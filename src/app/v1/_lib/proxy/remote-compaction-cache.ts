import { createHash } from "node:crypto";
import { RedisKVStore } from "@/lib/redis/redis-kv-store";

/**
 * 远程压缩结果的短期幂等缓存。
 *
 * Codex 在压缩流中断时会重发同一个压缩请求（最多两次）。摘要本身可能耗时十几秒，
 * 如果每次都重新调用上游，既费钱又容易在重试时再次超时。这里把已经生成好的结果
 * 按「会话 + 供应商 + 模型 + 历史」指纹缓存一小段时间，重试直接复用同一份 token。
 *
 * 缓存只影响重试，不参与历史回放：token 本身是自包含的，Redis 丢了也能解密。
 */

export type CachedCompactionResult = {
  token: string;
  compactionId: string;
  responseId: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedTokens: number;
  createdAtSeconds: number;
};

const CACHE_TTL_SECONDS = 900;

const defaultStore = new RedisKVStore<CachedCompactionResult>({
  prefix: "cch:remote-compaction:v2:result:",
  defaultTtlSeconds: CACHE_TTL_SECONDS,
});

let storeOverride: RedisKVStore<CachedCompactionResult> | null = null;

/** 仅供测试注入内存实现。 */
export function setRemoteCompactionCacheStoreForTests(
  store: RedisKVStore<CachedCompactionResult> | null
): void {
  storeOverride = store;
}

function resolveStore(): RedisKVStore<CachedCompactionResult> {
  return storeOverride ?? defaultStore;
}

/**
 * 指纹必须对「同一次压缩重试」稳定：会话标识、供应商、模型和历史内容。
 * 历史用去掉 trigger 之后的 input，避免 trigger 位置差异影响指纹。
 */
export function compactionFingerprint(parts: {
  sessionId: string | null;
  providerId: number | null;
  model: string;
  history: unknown;
}): string {
  const hash = createHash("sha256");
  hash.update(
    `${parts.sessionId ?? "anonymous"}\u0000${parts.providerId ?? "unknown"}\u0000${parts.model}\u0000`
  );
  hash.update(JSON.stringify(parts.history ?? null));
  return hash.digest("hex");
}

export async function readCachedCompaction(
  fingerprint: string
): Promise<CachedCompactionResult | null> {
  return resolveStore().get(fingerprint);
}

export async function writeCachedCompaction(
  fingerprint: string,
  result: CachedCompactionResult
): Promise<void> {
  await resolveStore().set(fingerprint, result);
}
