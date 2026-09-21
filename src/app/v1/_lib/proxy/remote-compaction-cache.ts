import { createHash, randomUUID } from "node:crypto";
import { getRedisClient } from "@/lib/redis/client";
import { RedisKVStore } from "@/lib/redis/redis-kv-store";

/**
 * 远程压缩结果的短期幂等缓存。
 *
 * Codex 在压缩流中断时会重发同一个压缩请求（最多两次）。摘要本身可能耗时十几秒，
 * 如果每次都重新调用上游，既费钱又容易在重试时再次超时。这里把已经生成好的结果
 * 按「认证主体 + 会话 + 供应商 + 模型 + 完整摘要请求」指纹缓存一小段时间，
 * 重试直接复用同一份 token。
 *
 * 缓存只影响重试，不参与历史回放：token 本身是自包含编码，Redis 丢失也能展开。
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
/** 摘要调用的租期上限：锁最多占用这么久，之后允许其他实例重做。 */
const LOCK_LEASE_MS = 120_000;
/** 拿不到锁时最多等待已有结果的时间，超时由调用方返回可重试失败。 */
const LOCK_WAIT_MS = 5_000;
const LOCK_POLL_INTERVAL_MS = 250;

const defaultStore = new RedisKVStore<CachedCompactionResult>({
  prefix: "cch:remote-compaction:v2:result:",
  defaultTtlSeconds: CACHE_TTL_SECONDS,
});

let storeOverride: RedisKVStore<CachedCompactionResult> | null = null;
let lockOverride: CompactionLockOps | null = null;
let lockWaitMsOverride: number | null = null;

export interface CompactionLockOps {
  tryAcquire(key: string, owner: string, ttlMs: number): Promise<boolean>;
  release(key: string, owner: string): Promise<void>;
}

interface LockRedisClient {
  status?: string;
  set(key: string, value: string, mode: "PX", ttlMs: number, nx: "NX"): Promise<unknown>;
  eval(script: string, numKeys: number, key: string, arg: string): Promise<unknown>;
}

/**
 * 只有锁的当前持有者才能释放它：租约过期后另一个实例可能已经拿到锁，
 * 此时旧持有者直接 DEL 会把别人的锁删掉。
 */
const LUA_RELEASE_IF_OWNER = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0`;

const defaultLockOps: CompactionLockOps = {
  async tryAcquire(key, owner, ttlMs) {
    const redis = getRedisClient({
      allowWhenRateLimitDisabled: true,
    }) as unknown as LockRedisClient | null;
    if (!redis || redis.status !== "ready") {
      // Redis 不可用时不做互斥，宁可重复一次也不要卡住压缩。
      return true;
    }
    try {
      const result = await redis.set(key, owner, "PX", ttlMs, "NX");
      return result === "OK";
    } catch {
      return true;
    }
  },
  async release(key, owner) {
    const redis = getRedisClient({
      allowWhenRateLimitDisabled: true,
    }) as unknown as LockRedisClient | null;
    if (!redis || redis.status !== "ready") {
      return;
    }
    try {
      await redis.eval(LUA_RELEASE_IF_OWNER, 1, key, owner);
    } catch {
      /* 释放失败只影响下一次重试，不影响本次结果 */
    }
  },
};

/** 仅供测试注入内存实现。 */
export function setRemoteCompactionCacheStoreForTests(
  store: RedisKVStore<CachedCompactionResult> | null
): void {
  storeOverride = store;
}

/** 仅供测试注入内存实现。 */
export function setRemoteCompactionLockForTests(
  ops: CompactionLockOps | null,
  waitMs?: number
): void {
  lockOverride = ops;
  lockWaitMsOverride = waitMs ?? null;
}

function resolveStore(): RedisKVStore<CachedCompactionResult> {
  return storeOverride ?? defaultStore;
}

function resolveLockOps(): CompactionLockOps {
  return lockOverride ?? defaultLockOps;
}

function lockKey(fingerprint: string): string {
  return `cch:remote-compaction:v2:lock:${fingerprint}`;
}

/**
 * 指纹必须对「同一次压缩重试」稳定，同时不能跨 API key 或摘要请求配置复用。
 * 摘要请求已去掉 trigger，并包含 instructions/tools 等会影响输出的字段。
 */
export function compactionFingerprint(parts: {
  userId: number | null;
  keyId: number | null;
  sessionId: string | null;
  providerId: number | null;
  model: string;
  summaryRequest: unknown;
}): string {
  const hash = createHash("sha256");
  hash.update(
    `${parts.userId ?? "anonymous-user"}\u0000${parts.keyId ?? "anonymous-key"}\u0000${parts.sessionId ?? "anonymous-session"}\u0000${parts.providerId ?? "unknown-provider"}\u0000${parts.model}\u0000`
  );
  hash.update(JSON.stringify(parts.summaryRequest ?? null));
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
): Promise<boolean> {
  return resolveStore().set(fingerprint, result);
}

/**
 * 尝试取得该压缩请求的执行权。
 *
 * 拿不到锁说明另一个实例/请求正在算同一份摘要，调用方应先用
 * {@link waitForCachedCompaction} 等待结果；等待超时也不能绕过锁重复计算。
 */
export async function acquireCompactionLock(fingerprint: string): Promise<string | null> {
  const owner = randomUUID();
  const acquired = await resolveLockOps().tryAcquire(lockKey(fingerprint), owner, LOCK_LEASE_MS);
  return acquired ? owner : null;
}

export async function releaseCompactionLock(fingerprint: string, owner: string): Promise<void> {
  await resolveLockOps().release(lockKey(fingerprint), owner);
}

/**
 * 轮询等待他人写入的结果。等待超时由调用方返回可重试失败，避免同一份摘要
 * 被多个实例同时发送并重复计费。
 */
export async function waitForCachedCompaction(
  fingerprint: string,
  timeoutMs: number = lockWaitMsOverride ?? LOCK_WAIT_MS
): Promise<CachedCompactionResult | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_INTERVAL_MS));
    const cached = await readCachedCompaction(fingerprint);
    if (cached) {
      return cached;
    }
  }
  return null;
}
