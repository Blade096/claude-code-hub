import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  // 打开 HTTP/2，才能走到 H2→H1 的传输层回退分支
  isHttp2Enabled: vi.fn(async () => true),
  getCachedSystemSettings: vi.fn(async () => ({
    enableClaudeMetadataUserIdInjection: false,
    enableBillingHeaderRectifier: false,
  })),
  getProxyAgentForProvider: vi.fn(async () => null),
  getGlobalAgentPool: vi.fn(() => ({
    getAgent: vi.fn(async () => ({ agent: undefined, cacheKey: "k", dispatcherId: "d" })),
    markUnhealthy: vi.fn(),
    markOriginUnhealthy: vi.fn(),
    releaseAgent: vi.fn(),
  })),
  wsEligible: vi.fn(async () => ({ eligible: true })),
  wsAttempt: vi.fn(async () => ({ reason: "handshake_failed", connected: false })),
}));

vi.mock("@/app/v1/_lib/responses-ws/eligibility", () => ({
  evaluateResponsesWsEligibility: mocks.wsEligible,
  getResponsesWsSessionId: vi.fn(() => "ws-session"),
  isWebsocketClientRequest: vi.fn(() => false),
}));

vi.mock("@/app/v1/_lib/responses-ws/upstream-adapter", () => ({
  tryResponsesWebsocketUpstream: mocks.wsAttempt,
}));

vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config")>();
  return {
    ...actual,
    isHttp2Enabled: mocks.isHttp2Enabled,
    getCachedSystemSettings: mocks.getCachedSystemSettings,
  };
});

vi.mock("@/lib/proxy-agent", () => ({
  getProxyAgentForProvider: mocks.getProxyAgentForProvider,
  getGlobalAgentPool: mocks.getGlobalAgentPool,
}));

import {
  resolveEndpointPolicy,
  SINGLE_ATTEMPT_ENDPOINT_POLICY,
} from "@/app/v1/_lib/proxy/endpoint-policy";
import { ProxyForwarder } from "@/app/v1/_lib/proxy/forwarder";
import { ProxySession } from "@/app/v1/_lib/proxy/session";
import type { Provider } from "@/types/provider";

function createProvider(): Provider {
  return {
    id: 11,
    name: "deepseek",
    providerType: "codex",
    url: "https://upstream.example.com/v1",
    key: "upstream-key",
    preserveClientIp: false,
    priority: 0,
    maxRetryAttempts: 1,
    providerVendorId: 0,
    mcpPassthroughType: "none",
    mcpPassthroughUrl: null,
  } as unknown as Provider;
}

function createSession(policy: ReturnType<typeof resolveEndpointPolicy>): ProxySession {
  const body = JSON.stringify({ model: "deepseek-v4-pro", stream: false, input: [] });
  const headers = new Headers({ "content-type": "application/json" });
  const session = Object.create(ProxySession.prototype);

  Object.assign(session, {
    startTime: Date.now(),
    method: "POST",
    requestUrl: new URL("https://hub.example.com/v1/responses"),
    headers,
    originalHeaders: new Headers(headers),
    headerLog: "{}",
    request: {
      model: "deepseek-v4-pro",
      log: body,
      message: JSON.parse(body) as Record<string, unknown>,
      buffer: new TextEncoder().encode(body).buffer,
    },
    userAgent: "CodexTest/1.0",
    context: null,
    clientAbortSignal: null,
    userName: "test-user",
    authState: { success: true, user: null, key: null, apiKey: null },
    provider: null,
    messageContext: null,
    sessionId: null,
    originalFormat: "response",
    providerType: null,
    originalUrlPathname: null,
    providerChain: [],
    endpointPolicy: policy,
    getEndpointPolicy: vi.fn(() => policy),
    isRawCrossProviderFallbackEnabled: vi.fn(() => false),
    setProvider: vi.fn(),
    addProviderToChain: vi.fn(),
    getProviderChain: vi.fn(() => []),
    getCurrentModel: vi.fn(() => "deepseek-v4-pro"),
    clientRequestsContext1m: vi.fn(() => false),
    getContext1mApplied: vi.fn(() => false),
    getCacheTtlResolved: vi.fn(() => null),
    getGroupCostMultiplier: vi.fn(() => 1),
    getMessagesLength: vi.fn(() => 1),
    addSpecialSetting: vi.fn(),
    getSpecialSettings: vi.fn(() => []),
    isHeaderModified: vi.fn(() => false),
    shouldPersistSessionDebugArtifacts: vi.fn(() => false),
    setCacheTtlResolved: vi.fn(),
    recordForwardStart: vi.fn(),
    clearResponseTimeout: vi.fn(),
    releaseAgent: vi.fn(),
  });

  return session as ProxySession;
}

function http2Error(): Error {
  const error = new Error("GOAWAY received") as Error & { code?: string };
  error.code = "ERR_HTTP2_GOAWAY";
  return error;
}

describe("ProxyForwarder transport fallback gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("单次尝试策略下 H2→H1 回退被禁止，只发送一次", async () => {
    const provider = createProvider();
    const session = createSession(SINGLE_ATTEMPT_ENDPOINT_POLICY);
    const fetchSpy = vi.spyOn(ProxyForwarder as never, "fetchWithoutAutoDecode" as never);
    (fetchSpy as unknown as { mockRejectedValue: (e: Error) => void }).mockRejectedValue(
      http2Error()
    );

    const { doForward } = ProxyForwarder as unknown as {
      doForward: (s: ProxySession, p: Provider, baseUrl: string) => Promise<Response>;
    };

    await expect(doForward(session, provider, provider.url)).rejects.toThrow();
    expect((fetchSpy as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(1);
  });

  it("对照组：默认策略下 H2 错误会透明回退到 HTTP/1.1", async () => {
    const provider = createProvider();
    const session = createSession(resolveEndpointPolicy("/v1/responses"));
    const fetchSpy = vi.spyOn(ProxyForwarder as never, "fetchWithoutAutoDecode" as never);
    (fetchSpy as unknown as { mockRejectedValueOnce: (e: Error) => void }).mockRejectedValueOnce(
      http2Error()
    );
    (fetchSpy as unknown as { mockResolvedValueOnce: (v: Response) => void }).mockResolvedValueOnce(
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
    );

    const { doForward } = ProxyForwarder as unknown as {
      doForward: (s: ProxySession, p: Provider, baseUrl: string) => Promise<Response>;
    };

    const response = await doForward(session, provider, provider.url);

    expect(response.status).toBe(200);
    expect((fetchSpy as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(2);
  });

  it("单次尝试策略下跳过 WS 上游尝试，只走 HTTP", async () => {
    const provider = createProvider();
    const session = createSession(SINGLE_ATTEMPT_ENDPOINT_POLICY);
    const fetchSpy = vi.spyOn(ProxyForwarder as never, "fetchWithoutAutoDecode" as never);
    (fetchSpy as unknown as { mockResolvedValue: (v: Response) => void }).mockResolvedValue(
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
    );

    const { doForward } = ProxyForwarder as unknown as {
      doForward: (s: ProxySession, p: Provider, baseUrl: string) => Promise<Response>;
    };

    await doForward(session, provider, provider.url);

    expect(mocks.wsAttempt).not.toHaveBeenCalled();
    expect((fetchSpy as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(1);
  });

  it("对照组：默认策略下会先尝试 WS 上游", async () => {
    const provider = createProvider();
    const session = createSession(resolveEndpointPolicy("/v1/responses"));
    const fetchSpy = vi.spyOn(ProxyForwarder as never, "fetchWithoutAutoDecode" as never);
    (fetchSpy as unknown as { mockResolvedValue: (v: Response) => void }).mockResolvedValue(
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
    );

    const { doForward } = ProxyForwarder as unknown as {
      doForward: (s: ProxySession, p: Provider, baseUrl: string) => Promise<Response>;
    };

    await doForward(session, provider, provider.url);

    expect(mocks.wsAttempt).toHaveBeenCalledTimes(1);
  });

  it("单次尝试策略下代理失败不再降级到直连", async () => {
    const provider = createProvider();
    provider.proxyUrl = "http://proxy.example.com:8080";
    provider.proxyFallbackToDirect = true;
    mocks.getProxyAgentForProvider.mockResolvedValue({
      agent: undefined,
      proxyUrl: "http://proxy.example.com:8080",
      fallbackToDirect: true,
      cacheKey: "proxy-cache",
      dispatcherId: "proxy-dispatcher",
    } as never);

    const session = createSession(SINGLE_ATTEMPT_ENDPOINT_POLICY);
    const fetchSpy = vi.spyOn(ProxyForwarder as never, "fetchWithoutAutoDecode" as never);
    (fetchSpy as unknown as { mockRejectedValue: (e: Error) => void }).mockRejectedValue(
      new Error("proxy connection failed")
    );

    const { doForward } = ProxyForwarder as unknown as {
      doForward: (s: ProxySession, p: Provider, baseUrl: string) => Promise<Response>;
    };

    await expect(doForward(session, provider, provider.url)).rejects.toThrow();
    expect((fetchSpy as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(1);
  });

  it("对照组：默认策略下代理失败会降级到直连", async () => {
    const provider = createProvider();
    provider.proxyUrl = "http://proxy.example.com:8080";
    provider.proxyFallbackToDirect = true;
    mocks.getProxyAgentForProvider.mockResolvedValue({
      agent: undefined,
      proxyUrl: "http://proxy.example.com:8080",
      fallbackToDirect: true,
      cacheKey: "proxy-cache",
      dispatcherId: "proxy-dispatcher",
    } as never);

    const session = createSession(resolveEndpointPolicy("/v1/responses"));
    const fetchSpy = vi.spyOn(ProxyForwarder as never, "fetchWithoutAutoDecode" as never);
    (fetchSpy as unknown as { mockRejectedValueOnce: (e: Error) => void }).mockRejectedValueOnce(
      new Error("proxy connection failed")
    );
    (fetchSpy as unknown as { mockResolvedValueOnce: (v: Response) => void }).mockResolvedValueOnce(
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
    );

    const { doForward } = ProxyForwarder as unknown as {
      doForward: (s: ProxySession, p: Provider, baseUrl: string) => Promise<Response>;
    };

    const response = await doForward(session, provider, provider.url);

    expect(response.status).toBe(200);
    expect((fetchSpy as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(2);
  });

  it("raw 端点策略下 H2 透明回退仍然保留", async () => {
    const provider = createProvider();
    const session = createSession(resolveEndpointPolicy("/v1/responses/compact"));
    const fetchSpy = vi.spyOn(ProxyForwarder as never, "fetchWithoutAutoDecode" as never);
    (fetchSpy as unknown as { mockRejectedValueOnce: (e: Error) => void }).mockRejectedValueOnce(
      http2Error()
    );
    (fetchSpy as unknown as { mockResolvedValueOnce: (v: Response) => void }).mockResolvedValueOnce(
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
    );

    const { doForward } = ProxyForwarder as unknown as {
      doForward: (s: ProxySession, p: Provider, baseUrl: string) => Promise<Response>;
    };

    const response = await doForward(session, provider, provider.url);

    expect(response.status).toBe(200);
    expect((fetchSpy as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(2);
  });
});
