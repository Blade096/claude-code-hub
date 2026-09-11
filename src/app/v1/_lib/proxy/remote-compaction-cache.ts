import { createHash, randomUUID } from "node:crypto";
import { getRedisClient } from "@/lib/redis/client";
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
/** 摘要调用的租期上限：锁最多占用这么久，之后允许其他实例重做。 */
const LOCK_LEASE_MS = 120_000;
/** 拿不到锁时最多等待已有结果的时间，超时就自己算，避免拖慢压缩。 */
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

/**
 * 尝试取得该压缩请求的执行权。
 *
 * 拿不到锁说明另一个实例/请求正在算同一份摘要，调用方应先用
 * {@link waitForCachedCompaction} 等一小会儿，等不到再自己算。
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
 * 轮询等待他人写入的结果。等待窗口故意很短：摘要通常要十几秒，
 * 长时间等待会把压缩本身拖慢，等不到就自己算更划算。
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
