import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  PortableCompatibilityError,
  preparePortableCompatibilityRequest,
} from "@/app/v1/_lib/proxy/codex-portable-compatibility";
import type { ProxySession } from "@/app/v1/_lib/proxy/session";
import type { Provider } from "@/types/provider";

const mocks = vi.hoisted(() => ({
  getCachedSystemSettings: vi.fn(),
}));

vi.mock("@/lib/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config")>()),
  getCachedSystemSettings: mocks.getCachedSystemSettings,
}));

function spawnAgentNamespace(namespace = "collaboration") {
  return {
    type: "namespace",
    name: namespace,
    description: "Collaboration tools",
    tools: [
      {
        type: "function",
        name: "spawn_agent",
        description: "Spawns an agent",
        parameters: {
          type: "object",
          required: ["message"],
          properties: {
            message: { type: "string", encrypted: true, minLength: 1 },
            model: { type: "string" },
          },
        },
      },
    ],
  };
}

function sendMessageNamespace() {
  const namespace = spawnAgentNamespace();
  namespace.tools[0].name = "send_message";
  return namespace;
}

function makeRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "third-party-model",
    stream: false,
    tools: [spawnAgentNamespace()],
    input: [
      {
        type: "agent_message",
        id: "amsg_1",
        author: "/root",
        recipient: "/root/worker",
        content: [
          { type: "input_text", text: "Message Type: NEW_TASK\nPayload:\n" },
          { type: "encrypted_content", encrypted_content: "Implement the bounded worker task." },
        ],
        internal_chat_message_metadata_passthrough: { turn_id: "turn_1" },
      },
    ],
    ...overrides,
  };
}

function makeSession(message: Record<string, unknown>): ProxySession {
  return {
    originalFormat: "response",
    requestUrl: new URL("https://proxy.example.com/v1/responses"),
    headers: new Headers(),
    userAgent: "Codex Desktop/1.2.3",
    request: { message, model: "requested-model" },
    getCurrentModel: () => "actual-model",
  } as unknown as ProxySession;
}

function makeProvider(mode: "native" | "portable" | "disabled" = "portable"): Provider {
  return {
    id: 42,
    name: "portable-provider",
    providerType: "codex",
    codexMultiAgentV2Mode: mode,
  } as Provider;
}

describe("Codex MultiAgentV2 portable request codec", () => {
  beforeEach(() => {
    mocks.getCachedSystemSettings.mockReset();
    mocks.getCachedSystemSettings.mockResolvedValue({
      enableCodexMultiAgentV2Compatibility: true,
    });
  });

  test("prepares spawn_agent without mutating the session request", async () => {
    const request = makeRequest();
    const before = structuredClone(request);
    const result = await preparePortableCompatibilityRequest({
      session: makeSession(request),
      provider: makeProvider(),
      request,
    });

    expect(request).toEqual(before);
    expect(result.request).not.toBe(request);
    expect(result.request).toMatchObject({
      input: [
        {
          type: "message",
          role: "user",
          author: "/root",
          recipient: "/root/worker",
          content: [
            { type: "input_text", text: "Message Type: NEW_TASK\nPayload:\n" },
            { type: "input_text", text: "Implement the bounded worker task." },
          ],
          internal_chat_message_metadata_passthrough: { turn_id: "turn_1" },
        },
      ],
    });
    const namespace = (result.request.tools as Array<Record<string, unknown>>)[0];
    expect(namespace.name).toBe("collaboration-optimize");
    const spawn = (namespace.tools as Array<Record<string, unknown>>)[0];
    expect(spawn).toMatchObject({
      name: "spawn_agent",
      description: "Spawns an agent",
      parameters: {
        type: "object",
        required: ["message"],
        properties: {
          message: { type: "string", minLength: 1 },
          model: { type: "string" },
        },
      },
    });
    expect(
      ((spawn.parameters as Record<string, unknown>).properties as Record<string, unknown>).message
    ).not.toHaveProperty("encrypted");
    expect(result.metadata).toMatchObject({
      providerId: 42,
      requestedModel: "requested-model",
      actualModel: "actual-model",
      transformations: [
        "spawn_agent_message_schema",
        "collaboration_namespace",
        "agent_message_input",
      ],
      toolMappings: [
        {
          encodedNamespace: "collaboration-optimize",
          originalNamespace: "collaboration",
          originalName: "spawn_agent",
        },
      ],
    });
    expect(JSON.stringify(result.metadata)).not.toContain("Implement the bounded worker task");
  });

  test("handles additional_tools and is idempotent", async () => {
    const request = makeRequest({
      tools: undefined,
      input: [
        {
          type: "additional_tools",
          role: "developer",
          tools: [spawnAgentNamespace()],
        },
      ],
    });
    const session = makeSession(request);
    const first = await preparePortableCompatibilityRequest({
      session,
      provider: makeProvider(),
      request,
    });
    const second = await preparePortableCompatibilityRequest({
      session,
      provider: makeProvider(),
      request: first.request,
    });

    expect(second.request).toEqual(first.request);
    expect(JSON.stringify(second.request)).not.toContain(
      "collaboration-optimize.collaboration-optimize"
    );
  });

  test("keeps native mode byte-for-byte unchanged", async () => {
    const request = makeRequest();
    const before = JSON.stringify(request);
    const result = await preparePortableCompatibilityRequest({
      session: makeSession(request),
      provider: makeProvider("native"),
      request,
    });

    expect(result.request).toBe(request);
    expect(JSON.stringify(result.request)).toBe(before);
    expect(result.metadata).toBeNull();
    expect(mocks.getCachedSystemSettings).not.toHaveBeenCalled();
  });

  test("rechecks disabled mode and the global switch for the actual attempt", async () => {
    const disabledRequest = makeRequest();
    await expect(
      preparePortableCompatibilityRequest({
        session: makeSession(disabledRequest),
        provider: makeProvider("disabled"),
        request: disabledRequest,
      })
    ).rejects.toMatchObject({
      compatibilityCode: "provider_disabled",
      errorType: "codex_multi_agent_v2_provider_disabled",
    });
    expect(mocks.getCachedSystemSettings).not.toHaveBeenCalled();

    mocks.getCachedSystemSettings.mockResolvedValueOnce({
      enableCodexMultiAgentV2Compatibility: false,
    });
    const featureDisabledRequest = makeRequest();
    await expect(
      preparePortableCompatibilityRequest({
        session: makeSession(featureDisabledRequest),
        provider: makeProvider(),
        request: featureDisabledRequest,
      })
    ).rejects.toMatchObject({ compatibilityCode: "feature_disabled" });
  });

  test("fails closed for opaque task content without exposing it", async () => {
    const opaque = "gAAAAABopaque-secret-task";
    const request = makeRequest({
      input: [
        {
          type: "agent_message",
          content: [{ type: "encrypted_content", encrypted_content: opaque }],
        },
      ],
    });

    const failure = await preparePortableCompatibilityRequest({
      session: makeSession(request),
      provider: makeProvider(),
      request,
    }).catch((error) => error);

    expect(failure).toBeInstanceOf(PortableCompatibilityError);
    expect(failure.compatibilityCode).toBe("opaque_content");
    expect(JSON.stringify(failure.toSafeDetails())).not.toContain(opaque);
    expect(failure.message).not.toContain(opaque);
  });

  test("fails closed on reserved names, streaming, and unsupported actions", async () => {
    const collision = makeRequest({
      tools: [
        spawnAgentNamespace(),
        { type: "function", name: "collaboration-optimize__business", parameters: {} },
      ],
    });
    await expect(
      preparePortableCompatibilityRequest({
        session: makeSession(collision),
        provider: makeProvider(),
        request: collision,
      })
    ).rejects.toMatchObject({ compatibilityCode: "name_collision" });

    const reservedNamespace = makeRequest({
      tools: [
        spawnAgentNamespace(),
        {
          ...spawnAgentNamespace(),
          name: "collaboration-optimize",
        },
      ],
    });
    await expect(
      preparePortableCompatibilityRequest({
        session: makeSession(reservedNamespace),
        provider: makeProvider(),
        request: reservedNamespace,
      })
    ).rejects.toMatchObject({ compatibilityCode: "name_collision" });

    const nestedCollision = makeRequest({
      tools: [
        spawnAgentNamespace(),
        {
          type: "namespace",
          name: "business",
          tools: [{ type: "function", name: "spawn_agent", parameters: {} }],
        },
      ],
    });
    await expect(
      preparePortableCompatibilityRequest({
        session: makeSession(nestedCollision),
        provider: makeProvider(),
        request: nestedCollision,
      })
    ).rejects.toMatchObject({ compatibilityCode: "name_collision" });

    const nestedTargetCollision = makeRequest({
      tools: [
        {
          ...spawnAgentNamespace(),
          tools: [
            ...(spawnAgentNamespace().tools as unknown[]),
            {
              type: "namespace",
              name: "business",
              tools: [{ type: "function", name: "spawn_agent", parameters: {} }],
            },
          ],
        },
      ],
    });
    await expect(
      preparePortableCompatibilityRequest({
        session: makeSession(nestedTargetCollision),
        provider: makeProvider(),
        request: nestedTargetCollision,
      })
    ).rejects.toMatchObject({ compatibilityCode: "name_collision" });

    const streaming = makeRequest({ stream: true });
    await expect(
      preparePortableCompatibilityRequest({
        session: makeSession(streaming),
        provider: makeProvider(),
        request: streaming,
      })
    ).rejects.toMatchObject({ compatibilityCode: "client_or_protocol_mismatch" });

    const sendOnly = makeRequest({ tools: [sendMessageNamespace()], input: [] });
    await expect(
      preparePortableCompatibilityRequest({
        session: makeSession(sendOnly),
        provider: makeProvider(),
        request: sendOnly,
      })
    ).rejects.toMatchObject({ compatibilityCode: "client_or_protocol_mismatch" });
  });
});
