import { logger } from "@/lib/logger";
import { ProxyForwarder } from "./forwarder";
import { ModelRedirector } from "./model-redirector";
import {
  asRecord,
  buildCompactionSummaryInput,
  encodeCompactionSummary,
  isRemoteCompactionV2Request,
  normalizeInputWithoutTrigger,
} from "./remote-compaction";
import {
  acquireCompactionLock,
  type CachedCompactionResult,
  compactionFingerprint,
  readCachedCompaction,
  releaseCompactionLock,
  waitForCachedCompaction,
  writeCachedCompaction,
} from "./remote-compaction-cache";
import type { ProxySession } from "./session";

/**
 * 当供应商被标记为 `remoteCompactionV2` 时，由 CCH 代表上游完成 Codex 的远程压缩：
 * 把历史交给同一个供应商的模型生成摘要，再按远程压缩 v2 的协议回一个自包含 token。
 *
 * 协议要求（Codex 客户端的硬校验）：
 * - 流里必须恰好有一个 `response.output_item.done` 携带 compaction item；
 * - 之后必须有一个 `response.completed`，客户端只从中取 id 与 usage；
 * - 流必须是 `text/event-stream`。
 */

const SUMMARY_MAX_OUTPUT_TOKENS = 4096;

/**
 * 是否把原请求的 tools 一起发给摘要模型。
 *
 * Responses 的 prompt cache 前缀包含 tools，去掉 tools 会让前缀整体变化，
 * 大概率拿不到缓存命中；但保留 tools 时模型有极小概率仍然输出工具调用（已用
 * tool_choice: "none" 抑制）。若某个上游对此不适应，把这里改成 false 即可回到
 * Codex 本地压缩的形态（只发 instructions + 历史）。
 */
const PRESERVE_TOOLS_FOR_PROMPT_CACHE = true;

/**
 * 命中远程压缩替代方案时返回完整的 SSE Response；未命中返回 null，
 * 让调用方继续走原有代理路径。
 */
export async function tryRemoteCompactionSynthesis(
  session: ProxySession
): Promise<Response | null> {
  if (session.originalFormat !== "response") {
    return null;
  }

  const provider = session.provider;
  if (!provider?.remoteCompactionV2) {
    return null;
  }

  const requestBody = session.request.message as Record<string, unknown> | undefined;
  if (!requestBody || !isRemoteCompactionV2Request(session.requestUrl.pathname, requestBody)) {
    return null;
  }

  const startedAt = Date.now();
  const requestedModel = session.getOriginalModel() ?? session.request.model ?? "";
  const effectiveModel = requestedModel
    ? ModelRedirector.getRedirectedModel(requestedModel, provider)
    : requestedModel;

  const { items: historyWithoutTrigger } = normalizeInputWithoutTrigger(requestBody.input);
  const fingerprint = compactionFingerprint({
    sessionId: session.sessionId ?? null,
    providerId: provider.id ?? null,
    model: effectiveModel,
    history: historyWithoutTrigger,
  });

  const cached = await readCachedCompaction(fingerprint);
  if (cached) {
    return replayCachedCompaction(session, cached, startedAt);
  }

  // 摘要通常要十几秒。如果等它跑完再返回响应头，中间层（Cloudflare 一类对
  // 「无响应体」的超时）会掐掉连接，客户端只能重试。先把 SSE 建立起来，
  // 摘要期间用心跳注释保活，完成后再补协议事件。
  return buildStreamingCompactionResponse(() =>
    produceCompactionResult(session, {
      requestBody,
      provider,
      effectiveModel,
      requestedModel,
      fingerprint,
      startedAt,
    })
  );
}

type CompactionOutcome =
  | {
      ok: true;
      token: string;
      compactionId: string;
      responseId: string;
      usage: CompactionUsage;
    }
  | { ok: false; message: string };

type CompactionProductionInputs = {
  requestBody: Record<string, unknown>;
  provider: NonNullable<ProxySession["provider"]>;
  effectiveModel: string;
  requestedModel: string;
  fingerprint: string;
  startedAt: number;
};

/**
 * 生成或复用一份压缩结果。只负责业务结果，不负责协议组帧，
 * 失败以 outcome 返回，由 SSE 层决定怎么告诉客户端。
 */
async function produceCompactionResult(
  session: ProxySession,
  inputs: CompactionProductionInputs
): Promise<CompactionOutcome> {
  const { requestBody, provider, effectiveModel, requestedModel, fingerprint, startedAt } = inputs;

  // 同一份摘要可能被重复请求：断流后客户端最多重发两次，第一次也可能仍在飞行中。
  // 拿到锁的请求负责生成，没拿到的先等一会儿已有结果，等不到再自己算，避免长时间阻塞。
  const lockOwner = await acquireCompactionLock(fingerprint);
  const hasLock = lockOwner !== null;
  if (!hasLock) {
    const reused = await waitForCachedCompaction(fingerprint);
    if (reused) {
      logger.info("[RemoteCompaction] Reused compaction result from a concurrent request", {
        providerId: provider.id,
        model: reused.model,
      });
      const reusedUsage: CompactionUsage = {
        input_tokens: reused.inputTokens,
        output_tokens: reused.outputTokens,
        total_tokens: reused.totalTokens,
        cached_tokens: reused.cachedTokens,
      };
      await finalizeCompactionRecord(session, {
        statusCode: 200,
        durationMs: Date.now() - startedAt,
        usage: reusedUsage,
        model: reused.model,
        reused: true,
      });
      return {
        ok: true,
        token: reused.token,
        compactionId: reused.compactionId,
        responseId: reused.responseId,
        usage: reusedUsage,
      };
    }
    logger.warn("[RemoteCompaction] Compaction lock held and no result yet; computing anyway", {
      providerId: provider.id,
      model: effectiveModel,
    });
  }

  // 下面两处 return 都必须释放锁，否则后续同名请求只能等到租期结束。
  const releaseLock = async () => {
    if (lockOwner) {
      await releaseCompactionLock(fingerprint, lockOwner);
    }
  };

  const summaryBody: Record<string, unknown> = {
    model: effectiveModel,
    input: buildCompactionSummaryInput(requestBody.input),
    tools:
      PRESERVE_TOOLS_FOR_PROMPT_CACHE && Array.isArray(requestBody.tools) ? requestBody.tools : [],
    tool_choice: "none",
    parallel_tool_calls: false,
    stream: false,
    store: false,
    max_output_tokens: SUMMARY_MAX_OUTPUT_TOKENS,
  };
  if (typeof requestBody.instructions === "string" && requestBody.instructions.trim()) {
    summaryBody.instructions = requestBody.instructions;
  }
  // 复用原请求的 prompt cache key，尽量命中同一个前缀缓存分片。
  if (typeof requestBody.prompt_cache_key === "string" && requestBody.prompt_cache_key) {
    summaryBody.prompt_cache_key = requestBody.prompt_cache_key;
  }

  logger.info("[RemoteCompaction] Synthesizing compaction summary", {
    providerId: provider.id,
    providerName: provider.name,
    requestedModel,
    effectiveModel,
  });

  let summaryText: string;
  let usage: CompactionUsage;
  try {
    const result = await runSummaryRequest(session, summaryBody);
    summaryText = result.text;
    usage = result.usage;
  } catch (error) {
    const message = error instanceof Error ? error.message : "摘要生成失败";
    logger.error("[RemoteCompaction] Summary request failed", {
      providerId: provider.id,
      providerName: provider.name,
      error: message,
    });
    await finalizeCompactionRecord(session, {
      statusCode: 502,
      durationMs: Date.now() - startedAt,
      errorMessage: message,
      model: effectiveModel,
    });
    await releaseLock();
    return { ok: false, message };
  }

  const token = encodeCompactionSummary({
    summary: summaryText,
    model: effectiveModel || null,
    createdAtSeconds: Math.floor(Date.now() / 1000),
  });

  // id 先固定下来，重试命中缓存时才能回放完全一致的事件。
  const compactionId = `cmp_${randomHex(24)}`;
  const responseId = `resp_${randomHex(24)}`;

  await writeCachedCompaction(fingerprint, {
    token,
    compactionId,
    responseId,
    model: effectiveModel || null,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.total_tokens,
    cachedTokens: usage.cached_tokens,
    createdAtSeconds: Math.floor(Date.now() / 1000),
  });

  await finalizeCompactionRecord(session, {
    statusCode: 200,
    durationMs: Date.now() - startedAt,
    usage,
    model: effectiveModel,
  });

  logger.info("[RemoteCompaction] Compaction synthesized", {
    providerId: provider.id,
    model: effectiveModel,
    summaryChars: summaryText.length,
    tokenBytes: token.length,
    usage,
  });

  await releaseLock();
  return { ok: true, token, compactionId, responseId, usage };
}

/** 复用缓存或并发请求产出的结果：收敛使用记录并按协议回放同一份事件。 */
async function replayCachedCompaction(
  session: ProxySession,
  cached: CachedCompactionResult,
  startedAt: number
): Promise<Response> {
  logger.info("[RemoteCompaction] Reusing cached compaction result", {
    providerId: session.provider?.id,
    model: cached.model,
    tokenBytes: cached.token.length,
  });

  const usage: CompactionUsage = {
    input_tokens: cached.inputTokens,
    output_tokens: cached.outputTokens,
    total_tokens: cached.totalTokens,
    cached_tokens: cached.cachedTokens,
  };

  await finalizeCompactionRecord(session, {
    statusCode: 200,
    durationMs: Date.now() - startedAt,
    usage,
    model: cached.model,
    reused: true,
  });

  return buildCompactionSseResponse(cached.token, usage, {
    compactionId: cached.compactionId,
    responseId: cached.responseId,
  });
}

type CompactionUsage = {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cached_tokens: number;
};

async function runSummaryRequest(
  session: ProxySession,
  summaryBody: Record<string, unknown>
): Promise<{ text: string; usage: CompactionUsage }> {
  const snapshot = {
    message: session.request.message,
    model: session.request.model,
    buffer: session.request.buffer,
    note: session.request.note,
  };

  try {
    session.request.message = summaryBody;
    session.request.model = String(summaryBody.model ?? "");
    session.request.buffer = new TextEncoder().encode(JSON.stringify(summaryBody)).buffer;

    const response = await ProxyForwarder.send(session);
    const raw = await response.text();

    if (response.status >= 400) {
      throw new Error(`上游返回 ${response.status}: ${raw.slice(0, 300)}`);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new Error(`上游返回的不是 JSON: ${raw.slice(0, 200)}`);
    }

    const text = extractSummaryText(payload);
    if (!text) {
      throw new Error("上游没有返回可用的摘要文本");
    }

    return { text, usage: extractUsage(payload) };
  } finally {
    session.request.message = snapshot.message;
    session.request.model = snapshot.model;
    session.request.buffer = snapshot.buffer;
    session.request.note = snapshot.note;
    releaseForwarderResources(session);
  }
}

function extractSummaryText(payload: unknown): string | null {
  const record = asRecord(payload);
  if (!record) return null;

  const parts: string[] = [];

  const output = record.output;
  if (Array.isArray(output)) {
    for (const item of output) {
      const itemRecord = asRecord(item);
      if (!itemRecord) continue;
      const content = itemRecord.content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        const partRecord = asRecord(part);
        if (partRecord && typeof partRecord.text === "string") {
          parts.push(partRecord.text);
        }
      }
    }
  }

  if (parts.length === 0 && typeof record.output_text === "string") {
    parts.push(record.output_text);
  }

  if (parts.length === 0 && Array.isArray(record.choices)) {
    const first = asRecord(record.choices[0]);
    const message = first ? asRecord(first.message) : null;
    if (message && typeof message.content === "string") {
      parts.push(message.content);
    }
  }

  const text = parts.join("\n").trim();
  return text.length > 0 ? text : null;
}

function extractUsage(payload: unknown): CompactionUsage {
  const record = asRecord(payload);
  const usage = record ? asRecord(record.usage) : null;
  const inputTokens = numberOrZero(usage?.input_tokens) || numberOrZero(usage?.prompt_tokens);
  const outputTokens = numberOrZero(usage?.output_tokens) || numberOrZero(usage?.completion_tokens);
  const totalTokens = numberOrZero(usage?.total_tokens) || inputTokens + outputTokens;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    cached_tokens: extractCachedTokens(usage),
  };
}

/**
 * 上游对缓存命中的字段命名并不统一，这里把常见的几种都读一遍，
 * 便于在日志和使用记录里确认压缩请求到底有没有吃到缓存。
 */
function extractCachedTokens(usage: Record<string, unknown> | null): number {
  if (!usage) return 0;
  const details = asRecord(usage.input_tokens_details) ?? asRecord(usage.prompt_tokens_details);
  return (
    numberOrZero(usage.prompt_cache_hit_tokens) ||
    numberOrZero(usage.cache_read_input_tokens) ||
    numberOrZero(details?.cached_tokens) ||
    0
  );
}

/**
 * 压缩请求在 guard pipeline 里已经写入了 message_request 记录，但它的结算路径
 * 由响应处理器负责，而我们在那之前就返回了。这里手动收敛这条记录，避免它在后台
 * 一直显示为处理中，同时把摘要调用的 token 用量记录下来。
 */
async function finalizeCompactionRecord(
  session: ProxySession,
  details: {
    statusCode: number;
    durationMs: number;
    usage?: CompactionUsage;
    errorMessage?: string;
    model: string | null;
    reused?: boolean;
  }
): Promise<void> {
  const messageId = session.messageContext?.id;
  if (messageId == null) {
    return;
  }

  try {
    const { updateMessageRequestDetails, updateMessageRequestDuration } = await import(
      "@/repository/message"
    );
    await updateMessageRequestDetails(messageId, {
      statusCode: details.statusCode,
      inputTokens: details.usage?.input_tokens,
      outputTokens: details.usage?.output_tokens,
      cacheReadInputTokens: details.usage?.cached_tokens,
      model: details.model ?? undefined,
      providerId: session.provider?.id,
      errorMessage: details.errorMessage,
    });
    await updateMessageRequestDuration(messageId, details.durationMs);
  } catch (error) {
    logger.warn("[RemoteCompaction] Failed to finalize message request record", {
      messageId,
      reused: details.reused ?? false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
};

/** 摘要期间发给客户端的 SSE 注释帧，只用于保活，不参与事件计数。 */
const SSE_HEARTBEAT = ": cch-remote-compaction-heartbeat\n\n";
const HEARTBEAT_INTERVAL_MS = 10_000;

function formatSseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * 先建立 SSE，摘要期间持续发心跳，拿到结果后再补协议事件。
 * 失败时发 response.failed（流已建立，不能再改回 JSON 错误）。
 */
function buildStreamingCompactionResponse(produce: () => Promise<CompactionOutcome>): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // 客户端断开或流被取消，后续结果仍会写完缓存供重试复用。
          closed = true;
        }
      };

      send(SSE_HEARTBEAT);
      const heartbeat = setInterval(() => send(SSE_HEARTBEAT), HEARTBEAT_INTERVAL_MS);

      try {
        const outcome = await produce();
        send(
          outcome.ok
            ? formatCompactionEvents(outcome)
            : formatSseEvent("response.failed", {
                type: "response.failed",
                response: {
                  status: "failed",
                  error: {
                    code: "remote_compaction_failed",
                    message: `远程压缩失败：${outcome.message}`,
                  },
                },
              })
        );
      } catch (error) {
        send(
          formatSseEvent("response.failed", {
            type: "response.failed",
            response: {
              status: "failed",
              error: {
                code: "remote_compaction_failed",
                message: `远程压缩失败：${error instanceof Error ? error.message : "未知错误"}`,
              },
            },
          })
        );
      } finally {
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* 流已关闭 */
        }
        closed = true;
      }
    },
    cancel() {
      // 客户端断开后不取消摘要：让它跑完写进缓存，重试即可命中。
    },
  });

  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}

function formatCompactionEvents(outcome: {
  token: string;
  compactionId: string;
  responseId: string;
  usage: CompactionUsage;
}): string {
  const { token, compactionId, responseId, usage } = outcome;
  const events = [
    {
      event: "response.output_item.done",
      data: {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "compaction",
          id: compactionId,
          encrypted_content: token,
        },
      },
    },
    {
      event: "response.completed",
      data: {
        type: "response.completed",
        response: {
          id: responseId,
          usage: {
            input_tokens: usage.input_tokens,
            input_tokens_details: null,
            output_tokens: usage.output_tokens,
            output_tokens_details: null,
            total_tokens: usage.total_tokens,
          },
        },
      },
    },
  ];

  return events.map((item) => formatSseEvent(item.event, item.data)).join("");
}

function buildCompactionSseResponse(
  token: string,
  usage: CompactionUsage,
  ids?: { compactionId: string; responseId: string }
): Response {
  const body = formatCompactionEvents({
    token,
    compactionId: ids?.compactionId ?? `cmp_${randomHex(24)}`,
    responseId: ids?.responseId ?? `resp_${randomHex(24)}`,
    usage,
  });
  return new Response(body, { status: 200, headers: SSE_HEADERS });
}

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buffer);
  return Array.from(buffer, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * 摘要调用绕过了 ProxyResponseHandler，因此必须在这里释放 forwarder 挂在
 * session 上的超时定时器与 agent 预留，否则会泄漏。
 */
function releaseForwarderResources(session: ProxySession): void {
  const augmented = session as ProxySession & {
    clearResponseTimeout?: (() => void) | null;
    releaseAgent?: (() => void) | null;
  };
  try {
    augmented.clearResponseTimeout?.();
  } catch {
    /* swallow cleanup errors */
  }
  augmented.clearResponseTimeout = null;
  try {
    augmented.releaseAgent?.();
  } catch {
    /* swallow cleanup errors */
  }
  augmented.releaseAgent = null;
}
