import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  provider: null as Provider | null,
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
  isWebsocketClientRequest: vi.fn(() => false),
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

vi.mock("@/app/v1/_lib/proxy/guard-pipeline", () => ({
  RequestType: { CHAT: "CHAT", COUNT_TOKENS: "COUNT_TOKENS" },
  GuardPipelineBuilder: {
    fromSession: (session: ProxySession) => ({
      run: vi.fn(async () => {
        session.setProvider(mocks.provider);
        session.authState = { success: true, user: null, key: null, apiKey: null };
        return null;
      }),
    }),
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
  isWebsocketClientRequest: mocks.isWebsocketClientRequest,
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
import { handleProxyRequest } from "@/app/v1/_lib/proxy-handler";
import { ProxyForwarder } from "@/app/v1/_lib/proxy/forwarder";
import { ProxyResponseHandler } from "@/app/v1/_lib/proxy/response-handler";
import {
  encodeCompactionSummary,
  expandCompactionReplayItems,
} from "@/app/v1/_lib/proxy/remote-compaction";
import { ProxySession } from "@/app/v1/_lib/proxy/session";
import type { Provider } from "@/types/provider";
import { Hono } from "hono";
import {
  COLLABORATION_ACTIONS,
  makeCollaborationNamespace as spawnAgentNamespace,
} from "./_helpers/codex-portable-fixtures";

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
    mocks.evaluateResponsesWsEligibility.mockReset();
    mocks.evaluateResponsesWsEligibility.mockResolvedValue({
      isWebsocketClient: false,
      eligible: false,
    });
    mocks.isWebsocketClientRequest.mockReset();
    mocks.isWebsocketClientRequest.mockReturnValue(false);
    mocks.tryResponsesWebsocketUpstream.mockReset();
    mocks.getCachedSystemSettings.mockResolvedValue({
      enableCodexMultiAgentV2Compatibility: true,
      enableClaudeMetadataUserIdInjection: false,
      enableBillingHeaderRectifier: false,
    });
    mocks.provider = null;
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

  test.each(COLLABORATION_ACTIONS)(
    "transforms and restores %s through the /v1/responses mock-upstream boundary",
    async (action) => {
      const provider = makeProvider();
      mocks.provider = provider;
      let upstreamBody: Record<string, unknown> | null = null;
      vi.spyOn(ProxyForwarder as never, "fetchWithoutAutoDecode").mockImplementationOnce(
        async (_url: string, init: RequestInit) => {
          upstreamBody = JSON.parse(bodyText(init.body));
          return new Response(
            JSON.stringify({
              id: "resp_boundary",
              output: [
                {
                  type: "function_call",
                  call_id: "call_boundary",
                  namespace: "collaboration-optimize",
                  name: action,
                  arguments: JSON.stringify({ message: "child task" }),
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
      );
      vi.spyOn(ProxyResponseHandler as never, "handleNonStream").mockImplementationOnce(
        async (_session: ProxySession, response: Response) => response
      );

      const app = new Hono();
      app.post("/v1/responses", handleProxyRequest);
      const response = await app.request("/v1/responses", {
        method: "POST",
        headers: {
          authorization: "Bearer proxy-key",
          "content-type": "application/json",
          "user-agent": "Codex Desktop/1.2.3",
        },
        body: JSON.stringify({
          model: "third-party-model",
          stream: false,
          tools: [spawnAgentNamespace(action)],
          input: [
            {
              type: "agent_message",
              content: [
                { type: "input_text", text: "Payload:\n" },
                { type: "encrypted_content", encrypted_content: "Run the boundary task." },
              ],
            },
          ],
        }),
      });

      expect(response.status, await response.clone().text()).toBe(200);
      expect(upstreamBody).toMatchObject({
        tools: [{ name: "collaboration-optimize" }],
        input: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "Payload:\n" },
              { type: "input_text", text: "Run the boundary task." },
            ],
          },
        ],
      });
      await expect(response.json()).resolves.toMatchObject({
        output: [{ namespace: "collaboration", name: action }],
      });
    }
  );

  test.each(COLLABORATION_ACTIONS)(
    "streams portable %s through the mock-upstream boundary and restores every call event",
    async (action) => {
      const provider = makeProvider();
      const session = makeSession(provider, {
        stream: true,
        tools: [spawnAgentNamespace(action)],
      });
      let upstreamBody: Record<string, unknown> | null = null;
      vi.spyOn(ProxyForwarder as never, "fetchWithoutAutoDecode").mockImplementationOnce(
        async (_url: string, init: RequestInit) => {
          upstreamBody = JSON.parse(bodyText(init.body));
          const events = [
            {
              type: "response.output_item.added",
              output_index: 0,
              item: {
                id: "item_boundary",
                type: "function_call",
                call_id: "call_boundary",
                namespace: "collaboration-optimize",
                name: action,
                arguments: "",
              },
            },
            {
              type: "response.function_call_arguments.delta",
              item_id: "item_boundary",
              output_index: 0,
              delta: '{"message":"child task"}',
            },
            {
              type: "response.output_item.done",
              output_index: 0,
              item: {
                id: "item_boundary",
                type: "function_call",
                call_id: "call_boundary",
                name: `collaboration-optimize.${action}`,
                arguments: '{"message":"child task"}',
              },
            },
            {
              type: "response.completed",
              response: {
                output: [
                  {
                    id: "item_boundary",
                    type: "function_call",
                    call_id: "call_boundary",
                    name: `collaboration-optimize__${action}`,
                    arguments: '{"message":"child task"}',
                  },
                ],
              },
            },
          ];
          return new Response(
            events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
            {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            }
          );
        }
      );

      const { doForward } = ProxyForwarder as unknown as {
        doForward: (
          session: ProxySession,
          provider: Provider,
          baseUrl: string
        ) => Promise<Response>;
      };
      const upstreamResponse = await doForward(session, provider, provider.url);
      const handleStream = vi
        .spyOn(ProxyResponseHandler as never, "handleStream")
        .mockImplementationOnce(async (_session: ProxySession, response: Response) => response);
      const clientResponse = await ProxyResponseHandler.dispatch(session, upstreamResponse);
      const responseText = await clientResponse.text();

      expect(upstreamBody).toMatchObject({
        stream: true,
        tools: [{ name: "collaboration-optimize" }],
      });
      expect(responseText).toContain(`"namespace":"collaboration","name":"${action}"`);
      expect(responseText).toContain(`"name":"collaboration__${action}"`);
      expect(responseText).toContain('{\\"message\\":\\"child task\\"}');
      expect(handleStream).toHaveBeenCalledOnce();
      expect(session.getPortableTransformationMetadata()).toBeNull();
    }
  );

  test("transforms an expanded compaction replay exactly once before the portable attempt", async () => {
    const provider = makeProvider();
    const token = encodeCompactionSummary({
      summary: "Earlier work is complete; continue with the bounded child task.",
      model: "third-party-model",
      createdAtSeconds: 1_700_000_000,
    });
    const replay = expandCompactionReplayItems([{ type: "compaction", encrypted_content: token }]);
    expect(replay.expanded).toBe(1);
    const agentMessage = (makeSession(provider).request.message.input as unknown[])[0];
    const session = makeSession(provider, {
      input: [...replay.items, agentMessage],
    });
    let upstreamBody: Record<string, unknown> | null = null;
    vi.spyOn(ProxyForwarder as never, "fetchWithoutAutoDecode").mockImplementationOnce(
      async (_url: string, init: RequestInit) => {
        upstreamBody = JSON.parse(bodyText(init.body));
        return new Response(JSON.stringify({ output: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
    );
    const { doForward } = ProxyForwarder as unknown as {
      doForward: (session: ProxySession, provider: Provider, baseUrl: string) => Promise<Response>;
    };

    await doForward(session, provider, provider.url);

    expect(upstreamBody).toMatchObject({
      tools: [{ name: "collaboration-optimize" }],
      input: [
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: expect.stringContaining("Earlier work is complete"),
            },
          ],
        },
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "Payload:\n" },
            { type: "input_text", text: "Complete the seam test task." },
          ],
        },
      ],
    });
    expect(JSON.stringify(upstreamBody).match(/collaboration-optimize/gu)).toHaveLength(1);
    expect(session.getPortableTransformationMetadata()?.transformations).toEqual([
      "spawn_agent_message_schema",
      "collaboration_namespace",
      "agent_message_input",
    ]);
    expect(session.getSpecialSettings()).toHaveLength(1);
  });

  test("prepares native root collaboration tools after compaction replay expansion", async () => {
    const provider = { ...makeProvider(), codexMultiAgentV2Mode: "native" as const } as Provider;
    const token = encodeCompactionSummary({
      summary: "Native checkpoint summary.",
      model: "third-party-model",
      createdAtSeconds: 1_700_000_000,
    });
    const replay = expandCompactionReplayItems([{ type: "compaction", encrypted_content: token }]);
    const originalAgentMessage = (makeSession(provider).request.message.input as unknown[])[0];
    const session = makeSession(provider, {
      input: [...replay.items, originalAgentMessage],
    });
    const originalRequest = structuredClone(session.request.message);
    let upstreamBody: Record<string, unknown> | null = null;
    vi.spyOn(ProxyForwarder as never, "fetchWithoutAutoDecode").mockImplementationOnce(
      async (_url: string, init: RequestInit) => {
        upstreamBody = JSON.parse(bodyText(init.body));
        return new Response(JSON.stringify({ output: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
    );
    const { doForward } = ProxyForwarder as unknown as {
      doForward: (session: ProxySession, provider: Provider, baseUrl: string) => Promise<Response>;
    };

    await doForward(session, provider, provider.url);

    expect(upstreamBody).toMatchObject({
      tools: [
        {
          name: "collaboration-optimize",
          tools: [
            { name: "spawn_agent", parameters: { properties: { message: { type: "string" } } } },
          ],
        },
      ],
      input: [
        {
          type: "message",
          content: [{ type: "input_text", text: expect.stringContaining("Native checkpoint") }],
        },
        {
          type: "agent_message",
          content: [
            { type: "input_text", text: "Payload:\n" },
            {
              type: "encrypted_content",
              encrypted_content: "Complete the seam test task.",
            },
          ],
        },
      ],
    });
    expect(session.request.message).toEqual(originalRequest);
    expect(session.getPortableTransformationMetadata()?.transformations).toEqual([
      "spawn_agent_message_schema",
      "collaboration_namespace",
    ]);
    expect(session.getSpecialSettings()).toHaveLength(1);
  });

  test("keeps a native SSE request and every response frame unchanged", async () => {
    const provider = { ...makeProvider(), codexMultiAgentV2Mode: "native" as const };
    const session = makeSession(provider, { stream: true });
    const upstreamText = [
      ": native-heartbeat\r\n",
      "id: native-1\r\n",
      "event: response.output_item.added\r\n",
      `data: ${JSON.stringify({
        type: "response.output_item.added",
        output_index: 0,
        item: {
          id: "native_item",
          type: "function_call",
          call_id: "native_call",
          namespace: "collaboration",
          name: "spawn_agent",
          arguments: "{}",
        },
      })}\r\n\r\n`,
      `data: ${JSON.stringify({
        type: "response.completed",
        response: {
          id: "native_response",
          output: [
            {
              id: "native_item",
              type: "function_call",
              call_id: "native_call",
              namespace: "collaboration",
              name: "spawn_agent",
              arguments: "{}",
            },
          ],
        },
      })}\r\n\r\n`,
      "data: [DONE]\n\n",
    ].join("");
    vi.spyOn(ProxyForwarder as never, "fetchWithoutAutoDecode").mockImplementationOnce(
      async () =>
        new Response(upstreamText, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
    );

    const { doForward } = ProxyForwarder as unknown as {
      doForward: (session: ProxySession, provider: Provider, baseUrl: string) => Promise<Response>;
    };
    const upstreamResponse = await doForward(session, provider, provider.url);
    vi.spyOn(ProxyResponseHandler as never, "handleStream").mockImplementationOnce(
      async (_session: ProxySession, response: Response) => response
    );
    const clientResponse = await ProxyResponseHandler.dispatch(session, upstreamResponse);

    await expect(clientResponse.text()).resolves.toBe(upstreamText);
    expect(session.getPortableTransformationMetadata()).toBeNull();
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

  test("rejects portable WebSocket before eligibility, upstream WS, or HTTP dispatch", async () => {
    const provider = makeProvider();
    const session = makeSession(provider);
    mocks.isWebsocketClientRequest.mockReturnValue(true);
    const fetch = vi.spyOn(ProxyForwarder as never, "fetchWithoutAutoDecode");
    const selectAlternative = vi.spyOn(ProxyForwarder as never, "selectAlternative");
    const { doForward } = ProxyForwarder as unknown as {
      doForward: (session: ProxySession, provider: Provider, baseUrl: string) => Promise<Response>;
    };

    await expect(doForward(session, provider, provider.url)).rejects.toMatchObject({
      compatibilityCode: "provider_transport_unsupported",
      fieldPath: "responses.websocket.portable",
      providerId: provider.id,
    });

    expect(mocks.evaluateResponsesWsEligibility).not.toHaveBeenCalled();
    expect(mocks.tryResponsesWebsocketUpstream).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(selectAlternative).not.toHaveBeenCalled();
  });

  test("keeps native OpenAI WebSocket eligible with its existing HTTP fallback", async () => {
    mocks.isWebsocketClientRequest.mockReturnValue(true);
    mocks.evaluateResponsesWsEligibility.mockResolvedValue({
      isWebsocketClient: true,
      eligible: true,
    });
    mocks.tryResponsesWebsocketUpstream.mockRejectedValue(
      new Error("upstream websocket handshake failed")
    );
    const fetch = vi.spyOn(ProxyForwarder as never, "fetchWithoutAutoDecode");
    fetch.mockImplementation(
      async () =>
        new Response(JSON.stringify({ output: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    );
    const { doForward } = ProxyForwarder as unknown as {
      doForward: (session: ProxySession, provider: Provider, baseUrl: string) => Promise<Response>;
    };

    const nativeProvider = { ...makeProvider(), codexMultiAgentV2Mode: "native" } as Provider;
    const preparedNativeSession = makeSession(nativeProvider);
    const preparedResponse = await doForward(
      preparedNativeSession,
      nativeProvider,
      nativeProvider.url
    );
    expect(preparedResponse.status).toBe(200);
    expect(preparedNativeSession.getPortableTransformationMetadata()).not.toBeNull();

    mocks.getCachedSystemSettings.mockResolvedValue({
      enableCodexMultiAgentV2Compatibility: false,
      enableClaudeMetadataUserIdInjection: false,
      enableBillingHeaderRectifier: false,
    });
    const unchangedNativeSession = makeSession(nativeProvider);
    const nativeResponse = await doForward(
      unchangedNativeSession,
      nativeProvider,
      nativeProvider.url
    );

    expect(nativeResponse.status).toBe(200);
    expect(mocks.tryResponsesWebsocketUpstream).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(unchangedNativeSession.getPortableTransformationMetadata()).toBeNull();
  });
});
