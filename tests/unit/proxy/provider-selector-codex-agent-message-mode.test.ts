import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Provider } from "@/types/provider";

vi.mock("@/lib/circuit-breaker", () => ({
  isCircuitOpen: vi.fn(async () => false),
  getCircuitState: vi.fn(() => "closed"),
}));

const sessionManagerMocks = vi.hoisted(() => ({
  SessionManager: {
    getSessionProvider: vi.fn(async () => null as number | null),
    clearSessionProvider: vi.fn(async () => undefined),
  },
}));

vi.mock("@/lib/session-manager", () => sessionManagerMocks);

const providerRepositoryMocks = vi.hoisted(() => ({
  findProviderById: vi.fn(async () => null as Provider | null),
  findAllProviders: vi.fn(async () => [] as Provider[]),
}));

vi.mock("@/repository/provider", () => providerRepositoryMocks);

function provider(
  id: number,
  mode: "native" | "portable",
  allowedModels: Provider["allowedModels"] = null
): Provider {
  return {
    id,
    name: `${mode}-${id}`,
    isEnabled: true,
    providerType: "codex",
    codexMultiAgentV2Mode: mode,
    groupTag: null,
    weight: 1,
    priority: 0,
    costMultiplier: 1,
    allowedModels,
  } as Provider;
}

function session(providers: Provider[], model: string, content: Array<Record<string, unknown>>) {
  return {
    originalFormat: "response",
    authState: null,
    request: {
      message: {
        model,
        client_metadata: {
          "x-openai-subagent": "collab_spawn",
          "x-codex-parent-thread-id": "root-thread",
        },
        input: [{ type: "agent_message", content }],
      },
    },
    getProvidersSnapshot: async () => providers,
    getOriginalModel: () => model,
    getCurrentModel: () => model,
    clientRequestsContext1m: () => false,
  } as any;
}

describe("ProxyProviderResolver Codex child message mode", () => {
  beforeEach(() => vi.clearAllMocks());

  async function resolver() {
    const { ProxyProviderResolver } = await import("@/app/v1/_lib/proxy/provider-selector");
    vi.spyOn(ProxyProviderResolver as any, "filterByLimits").mockImplementation(
      async (...args: unknown[]) => args[0] as Provider[]
    );
    vi.spyOn(ProxyProviderResolver as any, "selectTopPriority").mockImplementation(
      (...args: unknown[]) => args[0] as Provider[]
    );
    vi.spyOn(ProxyProviderResolver as any, "selectOptimal").mockImplementation(
      (...args: unknown[]) => (args[0] as Provider[])[0] ?? null
    );
    return ProxyProviderResolver;
  }

  test("routes a plaintext agent_message only to a portable provider", async () => {
    const ProxyProviderResolver = await resolver();
    const native = provider(1, "native");
    const portable = provider(2, "portable", [{ matchType: "exact", pattern: "deepseek-flash" }]);

    const { provider: selected } = await (ProxyProviderResolver as any).pickRandomProvider(
      session([native, portable], "deepseek-flash", [
        { type: "input_text", text: "portable task" },
      ]),
      []
    );

    expect(selected?.id).toBe(2);
  });

  test("routes an encrypted agent_message only to a native provider", async () => {
    const ProxyProviderResolver = await resolver();
    const portable = provider(1, "portable");
    const native = provider(2, "native");

    const { provider: selected } = await (ProxyProviderResolver as any).pickRandomProvider(
      session([portable, native], "gpt-5.6", [
        { type: "input_text", text: "Message Type: NEW_TASK\nPayload:\n" },
        { type: "encrypted_content", encrypted_content: "opaque" },
      ]),
      []
    );

    expect(selected?.id).toBe(2);
  });

  test("rejects a reused native provider for a plaintext child request", async () => {
    const ProxyProviderResolver = await resolver();
    const native = provider(7, "native");
    sessionManagerMocks.SessionManager.getSessionProvider.mockResolvedValueOnce(7);
    providerRepositoryMocks.findProviderById.mockResolvedValueOnce(native);
    const childSession = session([native], "deepseek-flash", [
      { type: "input_text", text: "portable task" },
    ]);
    childSession.sessionId = "portable-child-session";
    childSession.shouldReuseProvider = () => true;

    const selected = await (ProxyProviderResolver as any).findReusable(childSession);

    expect(selected).toBeNull();
    expect(sessionManagerMocks.SessionManager.clearSessionProvider).toHaveBeenCalledWith(
      "portable-child-session"
    );
  });
});
