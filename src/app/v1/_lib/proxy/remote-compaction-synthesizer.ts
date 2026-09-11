import { logger } from "@/lib/logger";
import { ProxyForwarder } from "./forwarder";
import { ModelRedirector } from "./model-redirector";
import {
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
import { ProxyResponses } from "./responses";
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

  // 同一份摘要可能被重复请求：断流后客户端最多重发两次，第一次也可能仍在飞行中。
  // 拿到锁的请求负责生成，没拿到的先等一会儿已有结果，等不到再自己算，避免长时间阻塞。
  const hasLock = await acquireCompactionLock(fingerprint);
  if (!hasLock) {
    const reused = await waitForCachedCompaction(fingerprint);
    if (reused) {
      logger.info("[RemoteCompaction] Reused compaction result from a concurrent request", {
        providerId: provider.id,
        model: reused.model,
      });
      return replayCachedCompaction(session, reused, startedAt);
    }
    logger.warn("[RemoteCompaction] Compaction lock held and no result yet; computing anyway", {
      providerId: provider.id,
      model: effectiveModel,
    });
  }

  // 下面两处 return 都必须释放锁，否则后续同名请求只能等到租期结束。
  const releaseLock = async () => {
    if (hasLock) {
      await releaseCompactionLock(fingerprint);
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
    return ProxyResponses.buildError(502, `远程压缩失败：${message}`);
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
  return buildCompactionSseResponse(token, usage, { compactionId, responseId });
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function buildCompactionSseResponse(
  token: string,
  usage: CompactionUsage,
  ids?: { compactionId: string; responseId: string }
): Response {
  const compactionId = ids?.compactionId ?? `cmp_${randomHex(24)}`;
  const responseId = ids?.responseId ?? `resp_${randomHex(24)}`;

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

  const body = events
    .map((item) => `event: ${item.event}\ndata: ${JSON.stringify(item.data)}\n\n`)
    .join("");

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
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
