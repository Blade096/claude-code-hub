import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCachedSystemSettings: vi.fn(async () => ({
    enableCodexMultiAgentV2Compatibility: true,
    enableClaudeMetadataUserIdInjection: false,
    enableBillingHeaderRectifier: false,
  })),
  isHttp2Enabled: vi.fn(async () => false),
  getProxyAgentForProvider: vi.fn(async () => null),
  getGlobalAgentPool: vi.fn(() => ({
    getAgent: vi.fn(),
    releaseAgent: vi.fn(),
    markOriginUnhealthy: vi.fn(),
  })),
  evaluateResponsesWsEligibility: vi.fn(async () => ({
    isWebsocketClient: false,
    eligible: false,
  })),
  tryResponsesWebsocketUpstream: vi.fn(),
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("@/lib/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config")>()),
  getCachedSystemSettings: mocks.getCachedSystemSettings,
  isHttp2Enabled: mocks.isHttp2Enabled,
}));

vi.mock("@/lib/logger", () => ({ logger: mocks.logger }));

vi.mock("@/lib/proxy-agent", () => ({
  getProxyAgentForProvider: mocks.getProxyAgentForProvider,
  getGlobalAgentPool: mocks.getGlobalAgentPool,
}));

vi.mock("@/lib/request-filter-engine", () => ({
  requestFilterEngine: { applyFinal: vi.fn(async () => {}) },
}));

vi.mock("@/app/v1/_lib/responses-ws/eligibility", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/v1/_lib/responses-ws/eligibility")>()),
  evaluateResponsesWsEligibility: mocks.evaluateResponsesWsEligibility,
  getResponsesWsSessionId: vi.fn(() => null),
}));

vi.mock("@/app/v1/_lib/responses-ws/upstream-adapter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/v1/_lib/responses-ws/upstream-adapter")>()),
  tryResponsesWebsocketUpstream: mocks.tryResponsesWebsocketUpstream,
}));

vi.mock("@/app/v1/_lib/proxy/response-fixer", () => ({
  ResponseFixer: {
    process: vi.fn(async (_session: unknown, response: Response) => response),
  },
}));

import { resolveEndpointPolicy } from "@/app/v1/_lib/proxy/endpoint-policy";
import { ProxyForwarder } from "@/app/v1/_lib/proxy/forwarder";
import { ProxyResponseHandler } from "@/app/v1/_lib/proxy/response-handler";
import { ProxySession } from "@/app/v1/_lib/proxy/session";
import type { Provider } from "@/types/provider";

function spawnAgentNamespace() {
  return {
    type: "namespace",
    name: "collaboration",
    tools: [
      {
        type: "function",
        name: "spawn_agent",
        parameters: {
          type: "object",
          properties: {
            message: { type: "string", encrypted: true },
          },
        },
      },
    ],
  };
}

function makeProvider(): Provider {
  return {
    id: 42,
    name: "portable-upstream",
    providerType: "codex",
    url: "https://upstream.example.com/v1",
    key: "upstream-key",
    codexMultiAgentV2Mode: "portable",
    preserveClientIp: false,
    priority: 0,
    weight: 1,
    costMultiplier: 1,
    maxRetryAttempts: 1,
    requestTimeoutNonStreamingMs: 10_000,
    mcpPassthroughType: "none",
    mcpPassthroughUrl: null,
  } as Provider;
}

function makeSession(provider: Provider, overrides: Record<string, unknown> = {}): ProxySession {
  const message = {
    model: "third-party-model",
    stream: false,
    tools: [spawnAgentNamespace()],
    input: [
      {
        type: "agent_message",
        author: "/root",
        recipient: "/root/worker",
        content: [
          { type: "input_text", text: "Payload:\n" },
          { type: "encrypted_content", encrypted_content: "Complete the seam test task." },
        ],
      },
    ],
    ...overrides,
  };
  const headers = new Headers({
    "content-type": "application/json",
    authorization: "Bearer proxy-key",
  });
  const session = Object.create(ProxySession.prototype) as ProxySession;
  Object.assign(session, {
    startTime: Date.now(),
    method: "POST",
    requestUrl: new URL("https://proxy.example.com/v1/responses"),
    headers,
    originalHeaders: new Headers(headers),
    headerLog: "{}",
    request: {
      model: "third-party-model",
      log: JSON.stringify(message),
      message,
    },
    userAgent: "Codex Desktop/1.2.3",
    context: null,
    clientAbortSignal: null,
    userName: "test-user",
    authState: { success: true, user: null, key: null, apiKey: null },
    provider,
    messageContext: null,
    sessionId: null,
    requestSequence: 1,
    originalFormat: "response",
    providerType: "codex",
    originalModelName: null,
    originalUrlPathname: null,
    currentModelRedirect: null,
    providerChain: [],
    specialSettings: [],
    providerSessionRefs: new Set<number>(),
    cacheTtlResolved: null,
    context1mApplied: false,
    groupCostMultiplier: 1,
    cachedPriceData: null,
    cachedBillingModelSource: "redirected",
    cachedCodexPriorityBillingSource: "requested",
    resolvedPricingCache: new Map(),
    highConcurrencyModeEnabled: false,
    rawCrossProviderFallbackEnabled: false,
    forwardedRequestBody: null,
    portableTransformationMetadata: null,
    endpointPolicy: resolveEndpointPolicy("/v1/responses"),
  });
  return session;
}

function bodyText(body: BodyInit | null | undefined): string {
  if (typeof body === "string") return body;
  throw new Error(`Expected string request body, received ${typeof body}`);
}

describe("portable compatibility proxy seams", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCachedSystemSettings.mockResolvedValue({
      enableCodexMultiAgentV2Compatibility: true,
      enableClaudeMetadataUserIdInjection: false,
      enableBillingHeaderRectifier: false,
    });
  });

  test("sends portable payload to mock upstream and restores the response in dispatch", async () => {
    const provider = makeProvider();
    const session = makeSession(provider);
    const originalRequest = structuredClone(session.request.message);
    let upstreamBody: Record<string, unknown> | null = null;
    vi.spyOn(ProxyForwarder as never, "fetchWithoutAutoDecode").mockImplementationOnce(
      async (_url: string, init: RequestInit) => {
        upstreamBody = JSON.parse(bodyText(init.body));
        return new Response(
          JSON.stringify({
            id: "resp_1",
            output: [
              {
                type: "function_call",
                call_id: "call_1",
                namespace: "collaboration-optimize",
                name: "spawn_agent",
                arguments: JSON.stringify({ message: "task from model" }),
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
    );

    const { doForward } = ProxyForwarder as unknown as {
      doForward: (session: ProxySession, provider: Provider, baseUrl: string) => Promise<Response>;
    };
    const upstreamResponse = await doForward(session, provider, provider.url);

    expect(session.request.message).toEqual(originalRequest);
    expect(upstreamBody).toMatchObject({
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "Payload:\n" },
            { type: "input_text", text: "Complete the seam test task." },
          ],
        },
      ],
      tools: [{ name: "collaboration-optimize" }],
    });
    expect(JSON.stringify(upstreamBody)).not.toContain('"encrypted":true');
    expect(session.getPortableTransformationMetadata()?.providerId).toBe(42);

    const nonStream = vi
      .spyOn(ProxyResponseHandler as never, "handleNonStream")
      .mockImplementationOnce(async (_session: ProxySession, response: Response) => response);
    const clientResponse = await ProxyResponseHandler.dispatch(session, upstreamResponse);
    const clientPayload = await clientResponse.json();

    expect(clientPayload).toMatchObject({
      output: [
        {
          type: "function_call",
          namespace: "collaboration",
          name: "spawn_agent",
          arguments: JSON.stringify({ message: "task from model" }),
        },
      ],
    });
    expect(nonStream).toHaveBeenCalledOnce();
    expect(session.getPortableTransformationMetadata()).toBeNull();
    expect(JSON.stringify(session.getSpecialSettings())).not.toContain(
      "Complete the seam test task"
    );
    const loggedArguments = Object.values(mocks.logger).flatMap(
      (loggerMethod) => loggerMethod.mock.calls
    );
    expect(JSON.stringify(loggedArguments)).not.toContain("Complete the seam test task");
  });

  test("fatal compatibility errors neither reach upstream nor select another Provider", async () => {
    const provider = makeProvider();
    const session = makeSession(provider, {
      tools: [
        spawnAgentNamespace(),
        { type: "function", name: "collaboration-optimize__business", parameters: {} },
      ],
    });
    const fetch = vi.spyOn(ProxyForwarder as never, "fetchWithoutAutoDecode");
    const selectAlternative = vi.spyOn(ProxyForwarder as never, "selectAlternative");

    await expect(ProxyForwarder.send(session)).rejects.toMatchObject({
      compatibilityCode: "name_collision",
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(selectAlternative).not.toHaveBeenCalled();
    expect(session.getPortableTransformationMetadata()).toBeNull();
  });
});
