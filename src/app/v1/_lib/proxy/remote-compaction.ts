import { Buffer } from "node:buffer";
import { normalizeEndpointPath, V1_ENDPOINT_PATHS } from "./endpoint-paths";

/**
 * Codex 远程压缩 v2 的协议辅助模块。
 *
 * 上游（Claude/DeepSeek 等）不支持 Responses 的 compaction 协议，因此由 CCH 自己
 * 生成摘要，并把摘要编码进 `encrypted_content` 回给客户端。客户端只把它当作不透明
 * 字符串回放，所以 token 必须自包含，不依赖 Redis 或任何跨实例状态。
 *
 * token 形态：`cch2.<base64url(JSON)>`，JSON 为 { v, s, m, t }。
 */

export const REMOTE_COMPACTION_TOKEN_PREFIX = "cch2.";

/** 回放展开后写入历史的文本前缀，便于排查。 */
export const COMPACTION_CHECKPOINT_MARKER = "[CCH_COMPACTION_CHECKPOINT v2]";

const TOKEN_VERSION = 2;
const MAX_TOKEN_LENGTH = 1_048_576;

export type CompactionTokenPayload = {
  /** token 版本，用于将来平滑升级编码格式。 */
  v: number;
  /** 摘要正文。 */
  s: string;
  /** 生成摘要时使用的上游模型名，仅用于排查。 */
  m: string | null;
  /** 生成时间（Unix 秒），仅用于排查。 */
  t: number;
};

export class RemoteCompactionTokenError extends Error {
  readonly status: number;

  constructor(
    message: string,
    readonly code: string,
    status: number
  ) {
    super(message);
    this.name = "RemoteCompactionTokenError";
    this.status = status;
  }
}

/** 宽松地把 unknown 收窄成普通对象，供协议层各处复用。 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isCompactionTriggerItem(item: unknown): boolean {
  return asRecord(item)?.type === "compaction_trigger";
}

/**
 * 识别 Responses input 中精确的远程压缩 v2 trigger。
 * 只认顶层 item，不做任何推断，避免把普通对话误判成压缩。
 */
export function isRemoteCompactionV2Request(pathname: string, requestBody: unknown): boolean {
  if (normalizeEndpointPath(pathname) !== V1_ENDPOINT_PATHS.RESPONSES) {
    return false;
  }

  const body = asRecord(requestBody);
  if (!body) {
    return false;
  }

  return hasCompactionTrigger(body.input);
}

/** input 为单对象或数组时均可识别。 */
export function hasCompactionTrigger(input: unknown): boolean {
  if (Array.isArray(input)) {
    return input.some(isCompactionTriggerItem);
  }
  return isCompactionTriggerItem(input);
}

/**
 * 把 input 规范成数组并移除 compaction_trigger。
 * 非数组且非 trigger 时返回原值的数组包装，保证调用方拿到稳定结构。
 */
export function normalizeInputWithoutTrigger(input: unknown): {
  items: unknown[];
  removedTrigger: boolean;
} {
  const items = Array.isArray(input) ? [...input] : input === undefined ? [] : [input];
  let removedTrigger = false;
  const kept = items.filter((item) => {
    if (isCompactionTriggerItem(item)) {
      removedTrigger = true;
      return false;
    }
    return true;
  });
  return { items: kept, removedTrigger };
}

/** 是否为 CCH 自己生成的压缩 token。 */
export function isCchCompactionToken(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.startsWith(REMOTE_COMPACTION_TOKEN_PREFIX) &&
    value.length <= MAX_TOKEN_LENGTH
  );
}

/** 是否为需要由 CCH 接管展开的 compaction 回放 item。 */
export function isCchCompactionReplayItem(item: unknown): boolean {
  const record = asRecord(item);
  if (!record || record.type !== "compaction") {
    return false;
  }
  return isCchCompactionToken(record.encrypted_content);
}

export function encodeCompactionSummary(payload: {
  summary: string;
  model: string | null;
  createdAtSeconds: number;
}): string {
  const body: CompactionTokenPayload = {
    v: TOKEN_VERSION,
    s: payload.summary,
    m: payload.model,
    t: payload.createdAtSeconds,
  };
  const encoded = Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
  return `${REMOTE_COMPACTION_TOKEN_PREFIX}${encoded}`;
}

export function decodeCompactionSummary(token: unknown): CompactionTokenPayload {
  if (typeof token !== "string" || !token.startsWith(REMOTE_COMPACTION_TOKEN_PREFIX)) {
    throw new RemoteCompactionTokenError(
      "该压缩标记不是本服务生成的，无法恢复上下文",
      "REMOTE_COMPACTION_TOKEN_UNSUPPORTED",
      422
    );
  }
  if (token.length > MAX_TOKEN_LENGTH) {
    throw new RemoteCompactionTokenError(
      "压缩标记超出允许的长度",
      "REMOTE_COMPACTION_TOKEN_INVALID",
      422
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(
      Buffer.from(token.slice(REMOTE_COMPACTION_TOKEN_PREFIX.length), "base64url").toString("utf8")
    );
  } catch {
    throw new RemoteCompactionTokenError(
      "压缩标记无法解析",
      "REMOTE_COMPACTION_TOKEN_INVALID",
      422
    );
  }

  const record = asRecord(parsed);
  if (!record || record.v !== TOKEN_VERSION || typeof record.s !== "string" || !record.s.trim()) {
    throw new RemoteCompactionTokenError(
      "压缩标记内容不完整或版本不受支持",
      "REMOTE_COMPACTION_TOKEN_INVALID",
      422
    );
  }

  return {
    v: record.v as number,
    s: record.s,
    m: typeof record.m === "string" ? record.m : null,
    t: typeof record.t === "number" ? record.t : 0,
  };
}

function buildCheckpointMessage(summary: string): Record<string, unknown> {
  return {
    type: "message",
    role: "user",
    content: [
      {
        type: "input_text",
        text: `${COMPACTION_CHECKPOINT_MARKER}\n${summary}`,
      },
    ],
  };
}

/**
 * 把历史中的 CCH 压缩标记原位展开为可读的 user message。
 * 必须原位替换：Codex 会保留部分近期消息并把 compaction item 放在当时的历史末尾，
 * 只有原位展开才能保持「早期上下文 → 摘要 → 压缩后的新消息」这一时间顺序。
 *
 * 解不开的 token 直接抛错，不静默丢弃历史。
 */
export function expandCompactionReplayItems(input: unknown): {
  items: unknown[];
  expanded: number;
} {
  const items = Array.isArray(input) ? [...input] : input === undefined ? [] : [input];
  let expanded = 0;

  const next = items.map((item) => {
    if (!isCchCompactionReplayItem(item)) {
      return item;
    }
    const record = item as Record<string, unknown>;
    const payload = decodeCompactionSummary(record.encrypted_content);
    expanded += 1;
    return buildCheckpointMessage(payload.s);
  });

  return { items: next, expanded };
}

/**
 * 生成摘要请求的输入：历史（去掉 trigger、展开旧标记）+ 末尾追加的总结指令。
 */
export function buildCompactionSummaryInput(input: unknown): unknown[] {
  const { items } = normalizeInputWithoutTrigger(input);
  const { items: expanded } = expandCompactionReplayItems(items);
  return [...expanded, buildCheckpointMessage(COMPACTION_SUMMARY_INSTRUCTION)];
}

/**
 * 摘要指令对齐 Codex 本地压缩的语义：产出一份可供下一个模型直接接手的工作交接。
 */
export const COMPACTION_SUMMARY_INSTRUCTION = [
  "你正在为一个上下文窗口即将耗尽的编程 Agent 生成上下文检查点。",
  "阅读上面的完整对话，输出一份详细摘要，使下一个模型无需重新阅读原始历史即可继续同一项工作。",
  "按以下顺序覆盖内容：",
  "1. 用户最初的请求，以及后续明确提出的要求、约束和偏好。",
  "2. 当前进展：已经完成什么、验证到什么程度、哪些还没有验证。",
  "3. 关键事实：涉及的文件路径、符号、命令、配置、报错信息和数据。",
  "4. 已做出的决定及原因，包括尝试过但被否决的方案。",
  "5. 剩余工作和明确的下一步。",
  "6. 不能遗忘的事项：用户偏好、项目约定、凭据处理方式和安全约束。",
  "只输出纯文本，内容要具体、可核查，不要编造对话中没有出现的信息。",
  "不要对用户说话，这段文字是给下一个模型的内部交接材料。",
].join("\n");
