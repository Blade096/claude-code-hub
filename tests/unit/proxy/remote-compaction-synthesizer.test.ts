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
import {
  resolveEndpointPolicy,
  SINGLE_ATTEMPT_ENDPOINT_POLICY,
} from "@/app/v1/_lib/proxy/endpoint-policy";

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
  singleAttemptCalls: boolean[];
  abortSignals: (AbortSignal | null)[];
};

function makeSession(options: { remoteCompactionV2: boolean }): FakeSession {
  const sentBodies: Record<string, unknown>[] = [];
  const singleAttemptCalls: boolean[] = [];
  const abortSignals: (AbortSignal | null)[] = [];
  let singleAttempt = false;
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
    headers: new Headers(),
    request,
    provider: {
      id: 7,
      name: "deepseek",
      remoteCompactionV2: options.remoteCompactionV2,
      modelRedirects: null,
    },
    sessionId: "01a08fc2-d8f1-7165-ade4-74a92cbf6f85",
    getOriginalModel: () => "deepseek-v4-pro",
    clientAbortSignal: null as AbortSignal | null,
    // 与 session.ts 的实现保持一致：替换中断信号、切换单次尝试策略
    setInternalRequestAbortSignal(signal: AbortSignal | null) {
      abortSignals.push(signal);
      this.clientAbortSignal = signal;
    },
    setSingleAttemptMode(enabled: boolean) {
      singleAttemptCalls.push(enabled);
      singleAttempt = enabled;
    },
    isSingleAttemptMode: () => singleAttempt,
    getEndpointPolicy: () =>
      singleAttempt ? SINGLE_ATTEMPT_ENDPOINT_POLICY : resolveEndpointPolicy("/v1/responses"),
  } as unknown as ProxySession;

  return { session, sentBodies, singleAttemptCalls, abortSignals };
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
function installLock(options: { acquire?: boolean }): { calls: LockCall[]; owners: string[] } {
  const calls: LockCall[] = [];
  const owners: string[] = [];
  setRemoteCompactionLockForTests(
    {
      tryAcquire: async (_key, owner) => {
        calls.push("acquire");
        owners.push(owner);
        return options.acquire ?? true;
      },
      release: async (_key, owner) => {
        calls.push("release");
        owners.push(owner);
      },
    },
    /* waitMs */ 40
  );
  return { calls, owners };
}

function sseEvents(body: string): { event: string; data: Record<string, unknown> }[] {
  return (
    body
      .split("\n\n")
      // 心跳是注释帧（以 ":" 开头），不是事件，必须跳过
      .filter((chunk) => chunk.includes("data: "))
      .map((chunk) => {
        const eventLine = chunk.split("\n").find((line) => line.startsWith("event: ")) ?? "event: ";
        const dataLine = chunk.split("\n").find((line) => line.startsWith("data: ")) ?? "data: {}";
        return {
          event: eventLine.slice("event: ".length),
          data: JSON.parse(dataLine.slice("data: ".length)) as Record<string, unknown>,
        };
      })
  );
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
    expect(response?.status).toBe(200);

    const events = sseEvents(await response!.text());
    expect(events.at(-1)?.event).toBe("response.failed");
    expect(JSON.stringify(events.at(-1)?.data)).toContain("远程压缩失败");
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
    const events = sseEvents(await response!.text());
    expect(events.at(-1)?.event).toBe("response.failed");
  });

  it("opens the SSE stream with a heartbeat before the summary completes", async () => {
    let release: ((value: Response) => void) | undefined;
    sendMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        })
    );

    const { session } = makeSession({ remoteCompactionV2: true });
    const response = await tryRemoteCompactionSynthesis(session);
    expect(response?.status).toBe(200);

    const reader = response!.body!.getReader();
    const decoder = new TextDecoder();
    const firstChunk = decoder.decode((await reader.read()).value);

    // 摘要还没返回，响应体已经建立并且先发了一个心跳注释帧
    expect(firstChunk).toContain("cch-remote-compaction-heartbeat");
    expect(firstChunk).not.toContain("response.completed");

    release?.(
      new Response(
        JSON.stringify({ output: [{ content: [{ text: "summary after heartbeat" }] }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    let rest = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      rest += decoder.decode(chunk.value);
    }
    const events = sseEvents(rest);
    expect(events.map((item) => item.event)).toEqual([
      "response.output_item.done",
      "response.completed",
    ]);
    expect(
      decodeCompactionSummary((events[0].data.item as Record<string, unknown>).encrypted_content).s
    ).toBe("summary after heartbeat");
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
    const otherResponse = await tryRemoteCompactionSynthesis(other.session);
    await otherResponse!.text();

    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it("releases the compaction lock after a successful synthesis", async () => {
    sendMock.mockResolvedValue(
      new Response(JSON.stringify({ output: [{ content: [{ text: "summary" }] }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    const lock = installLock({});
    const { session } = makeSession({ remoteCompactionV2: true });
    const response = await tryRemoteCompactionSynthesis(session);
    await response!.text();

    expect(lock.calls).toEqual(["acquire", "release"]);
    // 释放必须带同一个 owner token，否则会误删别人的锁
    expect(lock.owners[1]).toBe(lock.owners[0]);
    expect(lock.owners[0]).toMatch(/^[0-9a-f-]{36}$/);
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

    const lock = installLock({ acquire: false });
    const { session } = makeSession({ remoteCompactionV2: true });
    const response = await tryRemoteCompactionSynthesis(session);
    const body = await response!.text();

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(body).toContain("response.completed");
    // 没抢到锁就不该释放别人的锁
    expect(lock.calls).toEqual(["acquire"]);
  });

  it("keeps the summary running when the client disconnects", async () => {
    const clientController = new AbortController();
    const { session, abortSignals } = makeSession({ remoteCompactionV2: true });
    session.clientAbortSignal = clientController.signal;

    sendMock.mockImplementation(async (s: ProxySession) => {
      // 摘要进行中客户端断开
      clientController.abort();
      // 摘要请求必须挂在内部信号上，不能被客户端断开带走
      expect(s.clientAbortSignal?.aborted).toBe(false);
      return new Response(JSON.stringify({ output: [{ content: [{ text: "survived" }] }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const response = await tryRemoteCompactionSynthesis(session);
    const body = await response!.text();
    expect(body).toContain("response.completed");

    // 结束后恢复客户端信号，内部信号已不再是当前信号
    expect(abortSignals).toHaveLength(2);
    expect(abortSignals[0]?.aborted).toBe(false);
    expect(session.clientAbortSignal).toBe(clientController.signal);
  });

  it("uses a single-attempt policy for the summary request and restores it", async () => {
    const { session, singleAttemptCalls } = makeSession({ remoteCompactionV2: true });
    expect(session.getEndpointPolicy().allowRetry).toBe(true);

    sendMock.mockImplementation(async (s: ProxySession) => {
      const policy = s.getEndpointPolicy();
      expect(policy.allowRetry).toBe(false);
      expect(policy.allowProviderSwitch).toBe(false);
      return new Response(JSON.stringify({ output: [{ content: [{ text: "summary" }] }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const response = await tryRemoteCompactionSynthesis(session);
    await response!.text();

    expect(singleAttemptCalls).toEqual([true, false]);
    expect(session.getEndpointPolicy().allowRetry).toBe(true);
  });

  it("aborts the internal summary signal when the deadline expires", async () => {
    vi.useFakeTimers();
    try {
      const records = installInMemoryCacheStore();
      const { session, abortSignals, singleAttemptCalls } = makeSession({
        remoteCompactionV2: true,
      });
      // 上游只在自身 signal 被 abort 时收敛，用来说明超时真的会终止请求
      sendMock.mockImplementation(
        (s: ProxySession) =>
          new Promise<Response>((_resolve, reject) => {
            s.clientAbortSignal?.addEventListener("abort", () =>
              reject(new Error("summary aborted"))
            );
          })
      );

      const responsePromise = tryRemoteCompactionSynthesis(session);
      await vi.advanceTimersByTimeAsync(0);

      expect(abortSignals.length).toBeGreaterThan(0);
      const internalSignal = abortSignals[0] as AbortSignal;
      expect(internalSignal.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(120_000);
      expect(internalSignal.aborted).toBe(true);

      // 流必须收敛：发 response.failed、关闭、恢复状态、不写缓存
      const response = await responsePromise;
      const body = await response!.text();
      expect(body).toContain("response.failed");
      expect(session.clientAbortSignal).toBeNull();
      expect(singleAttemptCalls).toEqual([true, false]);
      expect(records.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("caches the result even when the client disconnected mid-summary", async () => {
    const clientController = new AbortController();
    const { session } = makeSession({ remoteCompactionV2: true });
    session.clientAbortSignal = clientController.signal;

    sendMock.mockImplementation(async () => {
      clientController.abort();
      return new Response(
        JSON.stringify({ output: [{ content: [{ text: "cached despite disconnect" }] }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const response = await tryRemoteCompactionSynthesis(session);
    await response!.text();
    expect(sendMock).toHaveBeenCalledTimes(1);

    // 重试（新会话、同历史）必须直接命中缓存，不再调用上游
    const retry = makeSession({ remoteCompactionV2: true });
    const retryResponse = await tryRemoteCompactionSynthesis(retry.session);
    const retryEvents = sseEvents(await retryResponse!.text());
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(
      decodeCompactionSummary(
        (retryEvents[0].data.item as Record<string, unknown>).encrypted_content
      ).s
    ).toBe("cached despite disconnect");
  });

  it("returns a localized failure message without leaking upstream detail", async () => {
    const { session } = makeSession({ remoteCompactionV2: true });
    session.headers = new Headers({ "accept-language": "en-US,en;q=0.9" });
    sendMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "upstream secret detail" } }), {
        status: 500,
      })
    );

    const response = await tryRemoteCompactionSynthesis(session);
    const body = await response!.text();

    expect(body).toContain("Remote compaction failed");
    expect(body).not.toContain("upstream secret detail");
    expect(body).toContain("remote_compaction_failed");
  });
});
