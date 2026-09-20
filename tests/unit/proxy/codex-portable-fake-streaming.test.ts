import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("@/app/v1/_lib/proxy/forwarder", () => ({
  ProxyForwarder: { send: mocks.send },
}));

vi.mock("@/lib/logger", () => ({ logger: mocks.logger }));

import { isPortableCodexMultiAgentV2Request } from "@/app/v1/_lib/proxy/codex-multi-agent-v2-gate";
import { preparePortableCompatibilityRequest } from "@/app/v1/_lib/proxy/codex-portable-compatibility";
import { tryFakeStreamingPath } from "@/app/v1/_lib/proxy/fake-streaming/proxy-integration";
import type { ClientFormat } from "@/app/v1/_lib/proxy/format-mapper";
import type { ProxySession } from "@/app/v1/_lib/proxy/session";
import type { Provider } from "@/types/provider";
import type { SystemSettings } from "@/types/system-config";

function collaborationNamespace() {
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

function makeSession(options: {
  mode: "native" | "portable";
  collaboration?: boolean;
  internalCompaction?: boolean;
  format?: ClientFormat;
  pathname?: string;
  search?: string;
  stream?: boolean;
  clientAbortSignal?: AbortSignal | null;
}): ProxySession {
  const message: Record<string, unknown> = {
    model: "fake-stream-model",
    stream: options.stream ?? true,
    input: [{ type: "message", role: "user", content: "hello" }],
  };
  if (options.collaboration ?? true) {
    message.tools = [collaborationNamespace()];
  }
  const headers = new Headers({ "user-agent": "Codex Desktop/1.2.3" });
  let fakeStreamingAttempt = false;
  return {
    originalFormat: options.format ?? "response",
    requestUrl: new URL(
      `https://proxy.example.com${options.pathname ?? "/v1/responses"}${options.search ?? ""}`
    ),
    headers,
    userAgent: "Codex Desktop/1.2.3",
    request: {
      message,
      model: "fake-stream-model",
      log: "{}",
    },
    provider: {
      id: 42,
      name: "fake-stream-provider",
      providerType: "codex",
      codexMultiAgentV2Mode: options.mode,
      groupTag: "default",
    },
    clientAbortSignal:
      options.clientAbortSignal === undefined
        ? new AbortController().signal
        : options.clientAbortSignal,
    isInternalCompactionRequest: () => options.internalCompaction ?? false,
    setFakeStreamingAttempt: (enabled: boolean) => {
      fakeStreamingAttempt = enabled;
    },
    isFakeStreamingAttempt: () => fakeStreamingAttempt,
  } as unknown as ProxySession;
}

function settings(enabled = true): SystemSettings {
  return {
    enableCodexMultiAgentV2Compatibility: enabled,
    fakeStreamingWhitelist: [{ model: "fake-stream-model", groupTags: [] }],
  } as SystemSettings;
}

function successfulResponsesBody(): string {
  return JSON.stringify({
    id: "resp_fake_stream",
    object: "response",
    model: "fake-stream-model",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "ok" }],
      },
    ],
  });
}

describe("portable MultiAgentV2 fake-streaming bypass", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.send.mockResolvedValue(
      new Response(successfulResponsesBody(), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
  });

  test("pure preflight excludes internal compaction and requires the enabled portable mode", () => {
    expect(isPortableCodexMultiAgentV2Request(makeSession({ mode: "portable" }), true)).toBe(true);
    expect(isPortableCodexMultiAgentV2Request(makeSession({ mode: "native" }), true)).toBe(false);
    expect(isPortableCodexMultiAgentV2Request(makeSession({ mode: "portable" }), false)).toBe(
      false
    );
    expect(
      isPortableCodexMultiAgentV2Request(
        makeSession({ mode: "portable", internalCompaction: true }),
        true
      )
    ).toBe(false);
  });

  test("portable V2 bypasses before fake streaming mutates or forwards the request", async () => {
    const session = makeSession({ mode: "portable" });
    const originalMessage = structuredClone(session.request.message);
    const originalUrl = session.requestUrl.toString();

    await expect(tryFakeStreamingPath(session, settings())).resolves.toBeNull();

    expect(mocks.send).not.toHaveBeenCalled();
    expect(session.request.message).toEqual(originalMessage);
    expect(session.requestUrl.toString()).toBe(originalUrl);
    expect(session.getPortableTransformationMetadata?.()).toBeUndefined();
  });

  test("fails closed if a native fake-stream attempt switches to a portable provider", async () => {
    const session = makeSession({ mode: "native" }) as ProxySession & {
      clearResponseTimeout: (() => void) | null;
      releaseAgent: (() => void) | null;
    };
    const clearResponseTimeout = vi.fn();
    const releaseAgent = vi.fn();
    session.clearResponseTimeout = clearResponseTimeout;
    session.releaseAgent = releaseAgent;

    mocks.send.mockImplementationOnce(async (activeSession: ProxySession) => {
      expect(activeSession.isFakeStreamingAttempt()).toBe(true);
      const portableProvider = {
        ...activeSession.provider,
        id: 43,
        name: "portable-fallback",
        codexMultiAgentV2Mode: "portable",
      } as Provider;
      activeSession.provider = portableProvider;
      await preparePortableCompatibilityRequest({
        session: activeSession,
        provider: portableProvider,
        request: activeSession.request.message,
      });
      throw new Error("portable fake-stream attempt unexpectedly continued");
    });

    const response = await tryFakeStreamingPath(session, settings());
    expect(response).not.toBeNull();
    const body = await response!.text();

    expect(body).toContain("codex_multi_agent_v2_provider_transport_unsupported");
    expect(body).not.toContain("hello");
    expect(session.isFakeStreamingAttempt()).toBe(false);
    expect(session.getPortableTransformationMetadata?.()).toBeUndefined();
    expect(clearResponseTimeout).toHaveBeenCalledOnce();
    expect(releaseAgent).toHaveBeenCalledOnce();
    expect(session.clearResponseTimeout).toBeNull();
    expect(session.releaseAgent).toBeNull();
  });

  test.each([
    { label: "native V2", session: () => makeSession({ mode: "native" }) },
    {
      label: "ordinary Responses",
      session: () => makeSession({ mode: "portable", collaboration: false }),
    },
  ])("keeps existing fake-stream eligibility for $label", async ({ session: createSession }) => {
    const session = createSession();

    const response = await tryFakeStreamingPath(session, settings());
    expect(response).not.toBeNull();
    const body = await response!.text();

    expect(mocks.send).toHaveBeenCalledOnce();
    expect(session.request.message.stream).toBe(false);
    expect(body).toContain("response.completed");
  });

  test("keeps the whitelist opt-out behavior unchanged", async () => {
    const session = makeSession({ mode: "native" });
    const originalMessage = structuredClone(session.request.message);

    await expect(
      tryFakeStreamingPath(session, {
        ...settings(),
        fakeStreamingWhitelist: [],
      })
    ).resolves.toBeNull();

    expect(mocks.send).not.toHaveBeenCalled();
    expect(session.request.message).toEqual(originalMessage);
  });

  test("keeps Gemini fake streaming path rewriting and forwarder cleanup intact", async () => {
    const session = makeSession({
      mode: "native",
      format: "gemini",
      pathname: "/v1beta/models/gemini:streamGenerateContent",
      search: "?alt=sse&key=test",
    }) as ProxySession & {
      clearResponseTimeout: (() => void) | null;
      releaseAgent: (() => void) | null;
    };
    const clearResponseTimeout = vi.fn();
    const releaseAgent = vi.fn();
    session.clearResponseTimeout = clearResponseTimeout;
    session.releaseAgent = releaseAgent;
    mocks.send.mockResolvedValueOnce(
      new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    const response = await tryFakeStreamingPath(session, settings());
    expect(response).not.toBeNull();
    await response!.text();

    expect(session.requestUrl.pathname).toBe("/v1beta/models/gemini:generateContent");
    expect(session.requestUrl.search).toBe("?key=test");
    expect(session.request.message.stream).toBe(false);
    expect(clearResponseTimeout).toHaveBeenCalledOnce();
    expect(releaseAgent).toHaveBeenCalledOnce();
    expect(session.clearResponseTimeout).toBeNull();
    expect(session.releaseAgent).toBeNull();
  });

  test("keeps non-stream fake responses and null abort-signal diagnostics intact", async () => {
    const session = makeSession({
      mode: "native",
      stream: false,
      clientAbortSignal: null,
    });

    const response = await tryFakeStreamingPath(session, settings());

    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    expect(await response!.json()).toMatchObject({ id: "resp_fake_stream" });
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("clientAbortSignal is null"),
      { model: "fake-stream-model" }
    );
  });
});
