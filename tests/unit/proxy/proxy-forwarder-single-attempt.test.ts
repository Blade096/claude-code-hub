import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isHttp2Enabled: vi.fn(async () => false),
  getCachedSystemSettings: vi.fn(async () => ({
    enableClaudeMetadataUserIdInjection: false,
    enableBillingHeaderRectifier: false,
  })),
  getProxyAgentForProvider: vi.fn(async () => null),
  getGlobalAgentPool: vi.fn(() => ({ getAgent: vi.fn(), markOriginUnhealthy: vi.fn() })),
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

import { SINGLE_ATTEMPT_ENDPOINT_POLICY } from "@/app/v1/_lib/proxy/endpoint-policy";
import { resolveEndpointPolicy } from "@/app/v1/_lib/proxy/endpoint-policy";
import { ProxyForwarder } from "@/app/v1/_lib/proxy/forwarder";
import { ProxySession } from "@/app/v1/_lib/proxy/session";
import type { Provider } from "@/types/provider";

function createProvider(): Provider {
  return {
    id: 7,
    name: "deepseek",
    providerType: "codex",
    url: "https://upstream.example.com/v1",
    key: "upstream-key",
    preserveClientIp: false,
    priority: 0,
    maxRetryAttempts: 3,
    providerVendorId: 0,
    mcpPassthroughType: "none",
    mcpPassthroughUrl: null,
  } as unknown as Provider;
}

function createSession(provider: Provider): ProxySession {
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
    provider,
    messageContext: null,
    sessionId: null,
    originalFormat: "response",
    providerType: null,
    originalUrlPathname: null,
    providerChain: [],
    endpointPolicy: SINGLE_ATTEMPT_ENDPOINT_POLICY,
    isRawCrossProviderFallbackEnabled: vi.fn(() => false),
    getEndpointPolicy: vi.fn(() => SINGLE_ATTEMPT_ENDPOINT_POLICY),
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
    recordForwardStart: vi.fn(),
    setCacheTtlResolved: vi.fn(),
  });

  return session as ProxySession;
}

describe("ProxyForwarder single-attempt policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("只发送一次，不重试也不切换供应商", async () => {
    const provider = createProvider();
    const session = createSession(provider);

    const doForward = vi.spyOn(ProxyForwarder as never, "doForward" as never);
    (doForward as unknown as { mockRejectedValue: (e: Error) => void }).mockRejectedValue(
      new Error("upstream 500")
    );
    const selectAlternative = vi.spyOn(ProxyForwarder as never, "selectAlternative" as never);
    vi.spyOn(
      ProxyForwarder as unknown as { clearSessionProviderBinding: () => Promise<void> },
      "clearSessionProviderBinding"
    ).mockResolvedValue(undefined);

    await expect(ProxyForwarder.send(session)).rejects.toThrow();

    expect(doForward).toHaveBeenCalledTimes(1);
    expect(selectAlternative).not.toHaveBeenCalled();
  });

  it("对照组：默认策略下同一个失败会重试并进入供应商切换", async () => {
    const provider = createProvider();
    const session = createSession(provider);
    (
      session.getEndpointPolicy as unknown as { mockReturnValue: (v: unknown) => void }
    ).mockReturnValue(resolveEndpointPolicy("/v1/responses"));

    const doForward = vi.spyOn(ProxyForwarder as never, "doForward" as never);
    (doForward as unknown as { mockRejectedValue: (e: Error) => void }).mockRejectedValue(
      new Error("upstream 500")
    );
    const selectAlternative = vi.spyOn(ProxyForwarder as never, "selectAlternative" as never);
    (selectAlternative as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue(
      null
    );
    vi.spyOn(
      ProxyForwarder as unknown as { clearSessionProviderBinding: () => Promise<void> },
      "clearSessionProviderBinding"
    ).mockResolvedValue(undefined);

    await expect(ProxyForwarder.send(session)).rejects.toThrow();

    expect(
      (doForward as unknown as { mock: { calls: unknown[] } }).mock.calls.length
    ).toBeGreaterThan(1);
    expect(selectAlternative).toHaveBeenCalled();
  });
});
