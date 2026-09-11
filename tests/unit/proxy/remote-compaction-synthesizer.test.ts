import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.fn();

vi.mock("@/app/v1/_lib/proxy/forwarder", () => ({
  ProxyForwarder: { send: (...args: unknown[]) => sendMock(...args) },
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() },
}));

import {
  decodeCompactionSummary,
  encodeCompactionSummary,
} from "@/app/v1/_lib/proxy/remote-compaction";
import {
  type CachedCompactionResult,
  setRemoteCompactionCacheStoreForTests,
  setRemoteCompactionLockForTests,
} from "@/app/v1/_lib/proxy/remote-compaction-cache";
import { tryRemoteCompactionSynthesis } from "@/app/v1/_lib/proxy/remote-compaction-synthesizer";
import type { ProxySession } from "@/app/v1/_lib/proxy/session";
import { RedisKVStore } from "@/lib/redis/redis-kv-store";

function token(summary: string): string {
  return encodeCompactionSummary({
    summary,
    model: "deepseek-v4-pro",
    createdAtSeconds: 1_700_000_000,
  });
}

type FakeSession = {
  session: ProxySession;
  sentBodies: Record<string, unknown>[];
};

function makeSession(options: { remoteCompactionV2: boolean }): FakeSession {
  const sentBodies: Record<string, unknown>[] = [];
  const request = {
    message: {
      model: "deepseek-v4-pro",
      instructions: "you are codex",
      prompt_cache_key: "cache-key-1",
      tools: [{ type: "function", name: "exec_command" }],
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "do the thing" }] },
        { type: "compaction_trigger" },
      ],
    } as Record<string, unknown>,
    model: "deepseek-v4-pro",
    buffer: new ArrayBuffer(0),
    note: "",
  };

  const session = {
    originalFormat: "response",
    requestUrl: new URL("https://hub.test/v1/responses"),
    request,
    provider: {
      id: 7,
      name: "deepseek",
      remoteCompactionV2: options.remoteCompactionV2,
      modelRedirects: null,
    },
    sessionId: "01a08fc2-d8f1-7165-ade4-74a92cbf6f85",
    getOriginalModel: () => "deepseek-v4-pro",
  } as unknown as ProxySession;

  return { session, sentBodies };
}

/** 内存版 Redis KV，用于验证幂等缓存行为。 */
function installInMemoryCacheStore(): Map<string, string> {
  const records = new Map<string, string>();
  const client = {
    status: "ready",
    setex: async (key: string, _ttl: number, value: string) => {
      records.set(key, value);
      return "OK";
    },
    get: async (key: string) => records.get(key) ?? null,
    del: async () => 1,
    eval: async () => null,
  };
  setRemoteCompactionCacheStoreForTests(
    new RedisKVStore<CachedCompactionResult>({
      prefix: "test:rc2:",
      defaultTtlSeconds: 60,
      redisClient: client as unknown as never,
    })
  );
  return records;
}

type LockCall = "acquire" | "release";

/** 可控的锁实现：记录调用，并可指定是否抢到锁。 */
function installLock(options: { acquire?: boolean; calls?: LockCall[] }): LockCall[] {
  const calls = options.calls ?? [];
  setRemoteCompactionLockForTests(
    {
      tryAcquire: async () => {
        calls.push("acquire");
        return options.acquire ?? true;
      },
      release: async () => {
        calls.push("release");
      },
    },
    /* waitMs */ 40
  );
  return calls;
}

function sseEvents(body: string): { event: string; data: Record<string, unknown> }[] {
  return body
    .split("\n\n")
    .filter((chunk) => chunk.trim().length > 0)
    .map((chunk) => {
      const eventLine = chunk.split("\n").find((line) => line.startsWith("event: ")) ?? "event: ";
      const dataLine = chunk.split("\n").find((line) => line.startsWith("data: ")) ?? "data: {}";
      return {
        event: eventLine.slice("event: ".length),
        data: JSON.parse(dataLine.slice("data: ".length)) as Record<string, unknown>,
      };
    });
}

describe("remote compaction synthesis", () => {
  beforeEach(() => {
    sendMock.mockReset();
    setRemoteCompactionCacheStoreForTests(null);
    setRemoteCompactionLockForTests(null);
    installInMemoryCacheStore();
    installLock({});
  });

  it("does nothing when the provider is not opted in", async () => {
    const { session } = makeSession({ remoteCompactionV2: false });
    await expect(tryRemoteCompactionSynthesis(session)).resolves.toBeNull();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("does nothing for ordinary requests", async () => {
    const { session } = makeSession({ remoteCompactionV2: true });
    (session.request.message as Record<string, unknown>).input = [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    ];
    await expect(tryRemoteCompactionSynthesis(session)).resolves.toBeNull();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("emits exactly one compaction item followed by response.completed", async () => {
    const { session } = makeSession({ remoteCompactionV2: true });
    sendMock.mockImplementation(async (s: ProxySession) => {
      // The summary call must be non-streaming, tool-less and trigger-free.
      const body = s.request.message as Record<string, unknown>;
      expect(body.stream).toBe(false);
      // 保留 tools 与 prompt_cache_key 是为了让摘要请求命中同一份前缀缓存
      expect(body.tools).toEqual([{ type: "function", name: "exec_command" }]);
      expect(body.prompt_cache_key).toBe("cache-key-1");
      expect(JSON.stringify(body.input)).not.toContain("compaction_trigger");
      return new Response(
        JSON.stringify({
          id: "resp_upstream",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "CHECKPOINT: the thing is half done" }],
            },
          ],
          usage: { input_tokens: 120, output_tokens: 40, total_tokens: 160 },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const response = await tryRemoteCompactionSynthesis(session);
    expect(response).not.toBeNull();
    expect(response?.headers.get("content-type")).toContain("text/event-stream");

    const events = sseEvents(await response!.text());
    expect(events.map((item) => item.event)).toEqual([
      "response.output_item.done",
      "response.completed",
    ]);

    const doneItem = events[0].data.item as Record<string, unknown>;
    expect(doneItem.type).toBe("compaction");
    expect(typeof doneItem.id).toBe("string");

    const decoded = decodeCompactionSummary(doneItem.encrypted_content);
    expect(decoded.s).toBe("CHECKPOINT: the thing is half done");
    expect(decoded.m).toBe("deepseek-v4-pro");

    const usage = (events[1].data.response as Record<string, unknown>).usage as Record<
      string,
      unknown
    >;
    expect(usage.input_tokens).toBe(120);
    expect(usage.output_tokens).toBe(40);
  });

  it("restores the original session request after the summary call", async () => {
    const { session } = makeSession({ remoteCompactionV2: true });
    const originalMessage = session.request.message;
    const originalBuffer = session.request.buffer;

    sendMock.mockResolvedValue(
      new Response(JSON.stringify({ output: [{ content: [{ text: "summary" }] }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    await tryRemoteCompactionSynthesis(session);

    expect(session.request.message).toBe(originalMessage);
    expect(session.request.buffer).toBe(originalBuffer);
    expect(session.request.model).toBe("deepseek-v4-pro");
  });

  it("fails loudly when the upstream summary call fails", async () => {
    const { session } = makeSession({ remoteCompactionV2: true });
    sendMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500 })
    );

    const response = await tryRemoteCompactionSynthesis(session);
    expect(response?.status).toBe(502);
    expect(await response!.text()).toContain("远程压缩失败");
  });

  it("fails when the upstream returns no usable text", async () => {
    const { session } = makeSession({ remoteCompactionV2: true });
    sendMock.mockResolvedValue(
      new Response(JSON.stringify({ output: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    const response = await tryRemoteCompactionSynthesis(session);
    expect(response?.status).toBe(502);
  });

  it("reuses the cached result when Codex retries the same compaction", async () => {
    sendMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "resp_upstream",
          output: [{ type: "message", content: [{ type: "output_text", text: "CHECKPOINT 1" }] }],
          usage: {
            input_tokens: 900,
            output_tokens: 60,
            total_tokens: 960,
            input_tokens_details: { cached_tokens: 640 },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const first = makeSession({ remoteCompactionV2: true });
    const firstResponse = await tryRemoteCompactionSynthesis(first.session);
    const firstEvents = sseEvents(await firstResponse!.text());
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(firstEvents).toHaveLength(2);

    // 同一会话、同一历史的重试不再调用上游
    const retry = makeSession({ remoteCompactionV2: true });
    const retryResponse = await tryRemoteCompactionSynthesis(retry.session);
    expect(sendMock).toHaveBeenCalledTimes(1);

    const retryEvents = sseEvents(await retryResponse!.text());
    expect(retryEvents).toHaveLength(2);
    expect(retryEvents[0].data.item).toEqual(firstEvents[0].data.item);
    expect(
      decodeCompactionSummary(
        (retryEvents[0].data.item as Record<string, unknown>).encrypted_content
      ).s
    ).toBe("CHECKPOINT 1");
  });

  it("does not reuse a cached result for a different history", async () => {
    sendMock.mockResolvedValue(
      new Response(JSON.stringify({ output: [{ content: [{ text: "summary" }] }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    const first = makeSession({ remoteCompactionV2: true });
    await tryRemoteCompactionSynthesis(first.session);

    const other = makeSession({ remoteCompactionV2: true });
    (other.session.request.message as Record<string, unknown>).input = [
      { type: "message", role: "user", content: [{ type: "input_text", text: "different" }] },
      { type: "compaction_trigger" },
    ];
    await tryRemoteCompactionSynthesis(other.session);

    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it("releases the compaction lock after a successful synthesis", async () => {
    sendMock.mockResolvedValue(
      new Response(JSON.stringify({ output: [{ content: [{ text: "summary" }] }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    const calls = installLock({});
    const { session } = makeSession({ remoteCompactionV2: true });
    await tryRemoteCompactionSynthesis(session);

    expect(calls).toEqual(["acquire", "release"]);
  });

  it("reuses the result of a concurrent request instead of calling upstream", async () => {
    const concurrent: CachedCompactionResult = {
      token: token("CONCURRENT SUMMARY"),
      compactionId: "cmp_concurrent",
      responseId: "resp_concurrent",
      model: "deepseek-v4-pro",
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      cachedTokens: 0,
      createdAtSeconds: 1,
    };

    // 第一次读缓存必然落空（另一个请求还没写完），等待窗口内的轮询才拿到结果。
    let getCalls = 0;
    setRemoteCompactionCacheStoreForTests(
      new RedisKVStore<CachedCompactionResult>({
        prefix: "test:rc2:",
        defaultTtlSeconds: 60,
        redisClient: {
          status: "ready",
          setex: async () => "OK",
          get: async () => {
            getCalls += 1;
            return getCalls === 1 ? null : JSON.stringify(concurrent);
          },
          del: async () => 1,
          eval: async () => null,
        } as unknown as never,
      })
    );
    installLock({ acquire: false });

    const { session } = makeSession({ remoteCompactionV2: true });
    const response = await tryRemoteCompactionSynthesis(session);

    expect(sendMock).not.toHaveBeenCalled();
    const events = sseEvents(await response!.text());
    expect(events[0].data.item).toMatchObject({ id: "cmp_concurrent" });
    expect(
      decodeCompactionSummary((events[0].data.item as Record<string, unknown>).encrypted_content).s
    ).toBe("CONCURRENT SUMMARY");
  });

  it("computes locally when the lock is held and no result appears", async () => {
    sendMock.mockResolvedValue(
      new Response(JSON.stringify({ output: [{ content: [{ text: "own summary" }] }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    const calls = installLock({ acquire: false });
    const { session } = makeSession({ remoteCompactionV2: true });
    const response = await tryRemoteCompactionSynthesis(session);

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(await response!.text()).toContain("response.completed");
    // 没抢到锁就不该释放别人的锁
    expect(calls).toEqual(["acquire"]);
  });
});
