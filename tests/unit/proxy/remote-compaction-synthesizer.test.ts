import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.fn();
const updateDetailsMock = vi.fn();
const updateDurationMock = vi.fn();
const updateCostMock = vi.fn();

vi.mock("@/app/v1/_lib/proxy/forwarder", () => ({
  ProxyForwarder: { send: (...args: unknown[]) => sendMock(...args) },
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() },
}));
vi.mock("@/repository/message", () => ({
  addMessageRequestHedgeLoserCost: vi.fn(),
  updateMessageRequestCostWithBreakdown: (...args: unknown[]) => updateCostMock(...args),
  updateMessageRequestDetails: (...args: unknown[]) => updateDetailsMock(...args),
  updateMessageRequestDuration: (...args: unknown[]) => updateDurationMock(...args),
  updateMessageRequestWinnerCost: vi.fn(),
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
import { logger } from "@/lib/logger";
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
  internalCompactionCalls: boolean[];
  abortSignals: (AbortSignal | null)[];
};

function makeSession(options: { remoteCompactionV2: boolean; trackUsage?: boolean }): FakeSession {
  const sentBodies: Record<string, unknown>[] = [];
  const singleAttemptCalls: boolean[] = [];
  const internalCompactionCalls: boolean[] = [];
  const abortSignals: (AbortSignal | null)[] = [];
  let singleAttempt = false;
  let internalCompaction = false;
  const request = {
    message: {
      model: "deepseek-v4-pro",
      instructions: "you are codex",
      prompt_cache_key: "cache-key-1",
      tools: [{ type: "function", name: "exec_command" }],
      tool_choice: "auto",
      parallel_tool_calls: true,
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
      providerType: "codex",
      costMultiplier: 1,
      swapCacheTtlBilling: false,
      remoteCompactionV2: options.remoteCompactionV2,
      modelRedirects: null,
    },
    messageContext: options.trackUsage
      ? { id: 321, createdAt: new Date("2026-09-14T12:00:00Z") }
      : null,
    sessionId: "01a08fc2-d8f1-7165-ade4-74a92cbf6f85",
    getOriginalModel: () => "deepseek-v4-pro",
    getCurrentModel: () => "deepseek-v4-pro",
    getEndpoint: () => "/v1/responses",
    getResolvedPricingByBillingSource: vi.fn().mockResolvedValue({
      source: "cloud_exact",
      resolvedModelName: "deepseek-v4-pro",
      resolvedPricingProviderKey: "deepseek",
      priceData: {
        input_cost_per_token: 0.00000015,
        output_cost_per_token: 0.0000006,
        cache_read_input_token_cost: 0.000000003,
      },
    }),
    getContext1mApplied: () => false,
    setContext1mApplied: vi.fn(),
    getGroupCostMultiplier: () => 1,
    getProviderChain: () => [{ id: 7, name: "deepseek", reason: "request_success" }],
    getSpecialSettings: vi.fn(() => null),
    addSpecialSetting: vi.fn(),
    shouldTrackSessionObservability: () => false,
    requestSequence: null,
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
    setInternalCompactionRequest(enabled: boolean) {
      internalCompactionCalls.push(enabled);
      internalCompaction = enabled;
    },
    isInternalCompactionRequest: () => internalCompaction,
    getEndpointPolicy: () =>
      singleAttempt ? SINGLE_ATTEMPT_ENDPOINT_POLICY : resolveEndpointPolicy("/v1/responses"),
  } as unknown as ProxySession;

  return {
    session,
    sentBodies,
    singleAttemptCalls,
    internalCompactionCalls,
    abortSignals,
  };
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
    updateDetailsMock.mockReset();
    updateDurationMock.mockReset();
    updateCostMock.mockReset();
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
      // The summary call must be non-streaming and trigger-free.
      const body = s.request.message as Record<string, unknown>;
      expect(body.stream).toBe(false);
      // 保留 tools 与 prompt_cache_key 是为了让摘要请求命中同一份前缀缓存
      expect(body.tools).toEqual([{ type: "function", name: "exec_command" }]);
      expect(body.prompt_cache_key).toBe("cache-key-1");
      expect(body.tool_choice).toBe("auto");
      expect(body.parallel_tool_calls).toBe(true);
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

  it("does not invent tool selection settings when the original request omits them", async () => {
    const { session } = makeSession({ remoteCompactionV2: true });
    const originalBody = session.request.message as Record<string, unknown>;
    delete originalBody.tool_choice;
    delete originalBody.parallel_tool_calls;

    sendMock.mockImplementation(async (s: ProxySession) => {
      const body = s.request.message as Record<string, unknown>;
      expect(body).not.toHaveProperty("tool_choice");
      expect(body).not.toHaveProperty("parallel_tool_calls");
      return new Response(
        JSON.stringify({
          output: [{ type: "message", content: [{ type: "output_text", text: "summary" }] }],
          usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const response = await tryRemoteCompactionSynthesis(session);
    expect(response).not.toBeNull();
    await response!.text();
  });

  it("normalizes cached input and bills a synthesized compaction request", async () => {
    const { session } = makeSession({ remoteCompactionV2: true, trackUsage: true });
    sendMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          output: [{ content: [{ text: "summary" }] }],
          usage: {
            input_tokens: 1000,
            output_tokens: 100,
            total_tokens: 1100,
            input_tokens_details: { cached_tokens: 400 },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const response = await tryRemoteCompactionSynthesis(session);
    await response!.text();

    expect(logger.warn).not.toHaveBeenCalledWith(
      "[RemoteCompaction] Failed to finalize message request record",
      expect.anything()
    );
    expect(updateDetailsMock).toHaveBeenCalledWith(
      321,
      expect.objectContaining({
        inputTokens: 600,
        outputTokens: 100,
        cacheReadInputTokens: 400,
        actualResponseModel: "deepseek-v4-pro",
      })
    );
    expect(updateCostMock).toHaveBeenCalledTimes(1);
    expect(String(updateCostMock.mock.calls[0]?.[1])).toBe("0.0001512");
    expect(session.addSpecialSetting).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "pricing_resolution",
        source: "cloud_exact",
      })
    );
  });

  it("persists cache-write usage reported by a compatible upstream", async () => {
    const { session } = makeSession({ remoteCompactionV2: true, trackUsage: true });
    sendMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          output: [{ content: [{ text: "summary" }] }],
          usage: {
            input_tokens: 1000,
            output_tokens: 100,
            total_tokens: 1100,
            cache_creation_input_tokens: 300,
            input_tokens_details: { cached_tokens: 400 },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const response = await tryRemoteCompactionSynthesis(session);
    await response!.text();

    expect(updateDetailsMock).toHaveBeenCalledWith(
      321,
      expect.objectContaining({
        inputTokens: 600,
        outputTokens: 100,
        cacheCreationInputTokens: 300,
        cacheReadInputTokens: 400,
      })
    );
  });

  it("restores the original session request after the summary call", async () => {
    const { session, internalCompactionCalls } = makeSession({ remoteCompactionV2: true });
    const originalMessage = session.request.message;
    const originalBuffer = session.request.buffer;

    sendMock.mockResolvedValue(
      new Response(JSON.stringify({ output: [{ content: [{ text: "summary" }] }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    const response = await tryRemoteCompactionSynthesis(session);
    await response!.text();

    expect(session.request.message).toBe(originalMessage);
    expect(session.request.buffer).toBe(originalBuffer);
    expect(session.request.model).toBe("deepseek-v4-pro");
    expect(internalCompactionCalls).toEqual([true, false]);
    expect(session.isInternalCompactionRequest()).toBe(false);
  });

  it("fails loudly when the upstream summary call fails", async () => {
    const { session, internalCompactionCalls } = makeSession({ remoteCompactionV2: true });
    sendMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500 })
    );

    const response = await tryRemoteCompactionSynthesis(session);
    expect(response?.status).toBe(200);

    const events = sseEvents(await response!.text());
    expect(events.at(-1)?.event).toBe("response.failed");
    expect(JSON.stringify(events.at(-1)?.data)).toContain("远程压缩失败");
    expect(internalCompactionCalls).toEqual([true, false]);
    expect(session.isInternalCompactionRequest()).toBe(false);
  });

  it("does not persist or log the raw upstream error body", async () => {
    const sentinel = "UPSTREAM_PRIVATE_ERROR_BODY_71C9";
    const { session } = makeSession({ remoteCompactionV2: true, trackUsage: true });
    sendMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: sentinel } }), { status: 500 })
    );

    const response = await tryRemoteCompactionSynthesis(session);
    await response!.text();

    const persistedAndLogged = JSON.stringify({
      logs: (logger.error as unknown as { mock: { calls: unknown[][] } }).mock.calls,
      details: updateDetailsMock.mock.calls,
    });
    expect(persistedAndLogged).not.toContain(sentinel);
    expect(persistedAndLogged).toContain("remote_compaction_upstream_http_error:500");
  });

  it("does not persist or log raw details from a thrown forwarding error", async () => {
    const sentinel = "FORWARDER_PRIVATE_ERROR_2D94";
    const { session } = makeSession({ remoteCompactionV2: true, trackUsage: true });
    sendMock.mockRejectedValue(new Error(`provider transport failed: ${sentinel}`));

    const response = await tryRemoteCompactionSynthesis(session);
    await response!.text();

    const persistedAndLogged = JSON.stringify({
      logs: (logger.error as unknown as { mock: { calls: unknown[][] } }).mock.calls,
      details: updateDetailsMock.mock.calls,
    });
    expect(persistedAndLogged).not.toContain(sentinel);
    expect(persistedAndLogged).toContain("remote_compaction_forward_error");
  });

  it.each(["failed", "incomplete"])(
    "rejects a Responses summary with terminal status %s even when it contains text",
    async (status) => {
      const { session } = makeSession({ remoteCompactionV2: true });
      sendMock.mockResolvedValue(
        new Response(
          JSON.stringify({
            object: "response",
            status,
            incomplete_details: status === "incomplete" ? { reason: "max_output_tokens" } : null,
            output: [{ content: [{ text: "partial summary must not be accepted" }] }],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      );

      const response = await tryRemoteCompactionSynthesis(session);
      const events = sseEvents(await response!.text());
      expect(events.at(-1)?.event).toBe("response.failed");
      expect(events.map((event) => event.event)).not.toContain("response.completed");
    }
  );

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

  it("does not bill the upstream usage again when replaying a cached compaction", async () => {
    sendMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          output: [{ content: [{ text: "bill once" }] }],
          usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const first = makeSession({ remoteCompactionV2: true, trackUsage: true });
    const firstResponse = await tryRemoteCompactionSynthesis(first.session);
    await firstResponse!.text();
    expect(updateCostMock).toHaveBeenCalledTimes(1);

    const retry = makeSession({ remoteCompactionV2: true, trackUsage: true });
    const retryResponse = await tryRemoteCompactionSynthesis(retry.session);
    await retryResponse!.text();

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(updateCostMock).toHaveBeenCalledTimes(1);
  });

  it("does not reuse a cached result when instructions differ", async () => {
    sendMock.mockResolvedValue(
      new Response(JSON.stringify({ output: [{ content: [{ text: "summary" }] }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    const first = makeSession({ remoteCompactionV2: true });
    const firstResponse = await tryRemoteCompactionSynthesis(first.session);
    await firstResponse!.text();

    const second = makeSession({ remoteCompactionV2: true });
    (second.session.request.message as Record<string, unknown>).instructions =
      "different system instructions";
    const secondResponse = await tryRemoteCompactionSynthesis(second.session);
    await secondResponse!.text();

    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it("does not reuse a cached result across API keys", async () => {
    sendMock.mockResolvedValue(
      new Response(JSON.stringify({ output: [{ content: [{ text: "summary" }] }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    const first = makeSession({ remoteCompactionV2: true });
    first.session.authState = { user: { id: 11 }, key: { id: 101 } } as never;
    const firstResponse = await tryRemoteCompactionSynthesis(first.session);
    await firstResponse!.text();

    const second = makeSession({ remoteCompactionV2: true });
    second.session.authState = { user: { id: 11 }, key: { id: 202 } } as never;
    const secondResponse = await tryRemoteCompactionSynthesis(second.session);
    await secondResponse!.text();

    expect(sendMock).toHaveBeenCalledTimes(2);
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

  it("fails retryably when the lock is held and no result appears", async () => {
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

    expect(sendMock).not.toHaveBeenCalled();
    expect(body).toContain("response.failed");
    // 没抢到锁就不该释放别人的锁
    expect(lock.calls).toEqual(["acquire"]);
  });

  it("lets the forwarder apply model redirection exactly once", async () => {
    const { session } = makeSession({ remoteCompactionV2: true });
    session.provider!.modelRedirects = [
      { matchType: "exact", source: "deepseek-v4-pro", target: "redirected-once" },
      { matchType: "exact", source: "redirected-once", target: "redirected-twice" },
    ];
    session.getOriginalModel = () => null;

    sendMock.mockImplementation(async (s: ProxySession) => {
      expect((s.request.message as Record<string, unknown>).model).toBe("deepseek-v4-pro");
      return new Response(JSON.stringify({ output: [{ content: [{ text: "summary" }] }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const response = await tryRemoteCompactionSynthesis(session);
    expect(await response!.text()).toContain("response.completed");
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

  it("uses isolated internal flags for the summary request and restores them", async () => {
    const { session, singleAttemptCalls, internalCompactionCalls } = makeSession({
      remoteCompactionV2: true,
    });
    expect(session.getEndpointPolicy().allowRetry).toBe(true);

    sendMock.mockImplementation(async (s: ProxySession) => {
      const policy = s.getEndpointPolicy();
      expect(policy.allowRetry).toBe(false);
      expect(policy.allowProviderSwitch).toBe(false);
      expect(s.isInternalCompactionRequest()).toBe(true);
      return new Response(JSON.stringify({ output: [{ content: [{ text: "summary" }] }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const response = await tryRemoteCompactionSynthesis(session);
    await response!.text();

    expect(singleAttemptCalls).toEqual([true, false]);
    expect(internalCompactionCalls).toEqual([true, false]);
    expect(session.isInternalCompactionRequest()).toBe(false);
    expect(session.getEndpointPolicy().allowRetry).toBe(true);
  });

  it("aborts the internal summary signal when the deadline expires", async () => {
    vi.useFakeTimers();
    try {
      const records = installInMemoryCacheStore();
      const { session, abortSignals, singleAttemptCalls, internalCompactionCalls } = makeSession({
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
      expect(internalCompactionCalls).toEqual([true, false]);
      expect(session.isInternalCompactionRequest()).toBe(false);
      expect(records.size).toBe(0);

      // 内部超时必须记为 timeout，而不是「客户端中断」
      const loggedTimeout = (logger.error as unknown as { mock: { calls: unknown[][] } }).mock.calls
        .flat()
        .some((arg) => JSON.stringify(arg).includes("remote_compaction_timeout"));
      expect(loggedTimeout).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("warns instead of claiming a cache hit when the cache write fails", async () => {
    const failingStore = new RedisKVStore<CachedCompactionResult>({
      prefix: "test:rc2:",
      defaultTtlSeconds: 60,
      redisClient: {
        status: "ready",
        setex: async () => {
          throw new Error("redis down");
        },
        get: async () => null,
        del: async () => 0,
        eval: async () => null,
      } as unknown as never,
    });
    setRemoteCompactionCacheStoreForTests(failingStore);
    sendMock.mockResolvedValue(
      new Response(JSON.stringify({ output: [{ content: [{ text: "summary" }] }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    const { session } = makeSession({ remoteCompactionV2: true });
    const response = await tryRemoteCompactionSynthesis(session);
    expect(await response!.text()).toContain("response.completed");

    const warned = (logger.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .flat()
      .some((arg) => JSON.stringify(arg).includes("Failed to cache compaction result"));
    expect(warned).toBe(true);
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

  it("does not leak abort listeners, including on the cache-hit path", async () => {
    const listeners = new Set<() => void>();
    const fakeSignal = {
      aborted: false,
      addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    } as unknown as AbortSignal;

    sendMock.mockResolvedValue(
      new Response(JSON.stringify({ output: [{ content: [{ text: "summary" }] }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    const first = makeSession({ remoteCompactionV2: true });
    first.session.clientAbortSignal = fakeSignal;
    const firstResponse = await tryRemoteCompactionSynthesis(first.session);
    await firstResponse!.text();
    // 生产流程结束后监听器必须被移除
    expect(listeners.size).toBe(0);

    const second = makeSession({ remoteCompactionV2: true });
    second.session.clientAbortSignal = fakeSignal;
    const secondResponse = await tryRemoteCompactionSynthesis(second.session);
    await secondResponse!.text();
    // 缓存命中路径根本不该注册监听器
    expect(listeners.size).toBe(0);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});
