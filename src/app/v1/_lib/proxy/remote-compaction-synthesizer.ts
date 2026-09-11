import { logger } from "@/lib/logger";
import { ProxyForwarder } from "./forwarder";
import { ModelRedirector } from "./model-redirector";
import {
  buildCompactionSummaryInput,
  encodeCompactionSummary,
  isRemoteCompactionV2Request,
} from "./remote-compaction";
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

  const requestedModel = session.getOriginalModel() ?? session.request.model ?? "";
  const effectiveModel = requestedModel
    ? ModelRedirector.getRedirectedModel(requestedModel, provider)
    : requestedModel;

  const summaryBody: Record<string, unknown> = {
    model: effectiveModel,
    input: buildCompactionSummaryInput(requestBody.input),
    tools: [],
    tool_choice: "none",
    parallel_tool_calls: false,
    stream: false,
    store: false,
    max_output_tokens: SUMMARY_MAX_OUTPUT_TOKENS,
  };
  if (typeof requestBody.instructions === "string" && requestBody.instructions.trim()) {
    summaryBody.instructions = requestBody.instructions;
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
    logger.error("[RemoteCompaction] Summary request failed", {
      providerId: provider.id,
      providerName: provider.name,
      error: error instanceof Error ? error.message : String(error),
    });
    return ProxyResponses.buildError(
      502,
      `远程压缩失败：${error instanceof Error ? error.message : "摘要生成失败"}`
    );
  }

  const token = encodeCompactionSummary({
    summary: summaryText,
    model: effectiveModel || null,
    createdAtSeconds: Math.floor(Date.now() / 1000),
  });

  logger.info("[RemoteCompaction] Compaction synthesized", {
    providerId: provider.id,
    model: effectiveModel,
    summaryChars: summaryText.length,
    tokenBytes: token.length,
    usage,
  });

  return buildCompactionSseResponse(token, usage);
}

type CompactionUsage = {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
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
  const inputTokens = numberOrZero(usage?.input_tokens);
  const outputTokens = numberOrZero(usage?.output_tokens);
  const totalTokens = numberOrZero(usage?.total_tokens) || inputTokens + outputTokens;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
  };
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function buildCompactionSseResponse(token: string, usage: CompactionUsage): Response {
  const compactionId = `cmp_${randomHex(24)}`;
  const responseId = `resp_${randomHex(24)}`;

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
