import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  PortableCompatibilityError,
  preparePortableCompatibilityRequest,
  type PortableTransformationMetadata,
} from "@/app/v1/_lib/proxy/codex-portable-compatibility";
import type { ProxySession } from "@/app/v1/_lib/proxy/session";
import type { Provider } from "@/types/provider";
import {
  COLLABORATION_ACTIONS,
  makeCollaborationNamespace as spawnAgentNamespace,
} from "./_helpers/codex-portable-fixtures";

const mocks = vi.hoisted(() => ({
  getCachedSystemSettings: vi.fn(),
}));

vi.mock("@/lib/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config")>()),
  getCachedSystemSettings: mocks.getCachedSystemSettings,
}));

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
          { type: "input_text", text: "Implement the bounded worker task." },
        ],
        internal_chat_message_metadata_passthrough: { turn_id: "turn_1" },
      },
    ],
    ...overrides,
  };
}

function makeSession(
  message: Record<string, unknown>,
  providers: Provider[] = [
    {
      id: 84,
      name: "portable-child-provider",
      isEnabled: true,
      providerType: "codex",
      codexMultiAgentV2Mode: "portable",
      allowedModels: [
        { matchType: "exact", pattern: "deepseek-flash" },
        { matchType: "exact", pattern: "glm-5" },
      ],
    } as Provider,
  ]
): ProxySession {
  let portableMetadata: PortableTransformationMetadata | null = null;
  return {
    originalFormat: "response",
    requestUrl: new URL("https://proxy.example.com/v1/responses"),
    headers: new Headers(),
    userAgent: "Codex Desktop/1.2.3",
    request: { message, model: "requested-model" },
    getCurrentModel: () => "actual-model",
    getProvidersSnapshot: async () => providers,
    getPortableTransformationMetadata: () => portableMetadata,
    setPortableTransformationMetadata: (metadata: PortableTransformationMetadata | null) => {
      portableMetadata = metadata;
    },
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

  test.each(
    COLLABORATION_ACTIONS.flatMap((action) =>
      (["tools", "additional_tools"] as const).flatMap((location) =>
        (["native", "portable", "disabled"] as const).map((mode) => ({
          action,
          location,
          mode,
        }))
      )
    )
  )("handles $action in $location for $mode mode", async ({ action, location, mode }) => {
    const namespace = spawnAgentNamespace(action);
    const request = makeRequest(
      location === "tools"
        ? { tools: [namespace], input: [] }
        : {
            tools: undefined,
            input: [{ type: "additional_tools", tools: [namespace] }],
          }
    );
    const before = structuredClone(request);

    if (mode === "disabled") {
      await expect(
        preparePortableCompatibilityRequest({
          session: makeSession(request),
          provider: makeProvider(mode),
          request,
        })
      ).rejects.toMatchObject({ compatibilityCode: "provider_disabled" });
      expect(request).toEqual(before);
      return;
    }

    const result = await preparePortableCompatibilityRequest({
      session: makeSession(request),
      provider: makeProvider(mode),
      request,
    });
    if (mode === "native") {
      if (action !== "spawn_agent") {
        expect(result).toEqual({ request, metadata: null });
        expect(result.request).toBe(request);
        expect(request).toEqual(before);
        return;
      }
      expect(result.request).not.toBe(request);
      const nativeTools =
        location === "tools"
          ? (result.request.tools as Array<Record<string, unknown>>)
          : ((result.request.input as Array<Record<string, unknown>>)[0].tools as Array<
              Record<string, unknown>
            >);
      expect(nativeTools).toHaveLength(2);
      expect(nativeTools[0]).toEqual(namespace);
      expect(nativeTools[1].name).toBe("collaboration-optimize");
      const portableTool = (nativeTools[1].tools as Array<Record<string, unknown>>)[0];
      expect(portableTool.name).toBe("spawn_portable_agent");
      const portableMessage = (
        (portableTool.parameters as Record<string, unknown>).properties as Record<string, unknown>
      ).message;
      expect(portableMessage).not.toHaveProperty("encrypted");
      expect(portableTool).toMatchObject({
        parameters: {
          properties: {
            model: { type: "string", enum: ["deepseek-flash", "glm-5"] },
          },
        },
      });
      expect(result.metadata).toMatchObject({
        toolMappings: [
          {
            encodedNamespace: "collaboration-optimize",
            encodedName: "spawn_portable_agent",
            originalNamespace: "collaboration",
            originalName: action,
          },
        ],
        transformations: [`${action}_message_schema`, "collaboration_namespace"],
      });
      expect(request).toEqual(before);
      return;
    }

    const tools =
      location === "tools"
        ? (result.request.tools as Array<Record<string, unknown>>)
        : ((result.request.input as Array<Record<string, unknown>>)[0].tools as Array<
            Record<string, unknown>
          >);
    expect(tools[0].name).toBe("collaboration-optimize");
    const rewrittenTool = (tools[0].tools as Array<Record<string, unknown>>)[0];
    const message = (
      (rewrittenTool.parameters as Record<string, unknown>).properties as Record<string, unknown>
    ).message;
    expect(message).not.toHaveProperty("encrypted");
    expect(result.metadata?.toolMappings).toEqual([
      {
        encodedNamespace: "collaboration-optimize",
        originalNamespace: "collaboration",
        originalName: action,
      },
    ]);
    expect(result.metadata?.transformations).toEqual([
      `${action}_message_schema`,
      "collaboration_namespace",
    ]);
    expect(request).toEqual(before);
  });

  test("keeps the native spawn tool and adds one shared portable plaintext tool", async () => {
    const request = makeRequest({ input: [] });
    const nativeNamespace = structuredClone((request.tools as Array<Record<string, unknown>>)[0]);

    const result = await preparePortableCompatibilityRequest({
      session: makeSession(request),
      provider: makeProvider("native"),
      request,
    });

    const tools = result.request.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(2);
    expect(tools[0]).toEqual(nativeNamespace);

    const portableNamespace = tools[1];
    expect(portableNamespace.name).toBe("collaboration-optimize");
    const portableSpawns = portableNamespace.tools as Array<Record<string, unknown>>;
    expect(portableSpawns).toHaveLength(1);
    expect(portableSpawns.map((tool) => tool.name)).toEqual(["spawn_portable_agent"]);
    const portableSpawn = portableSpawns[0];
    const portableMessage = (
      (portableSpawn.parameters as Record<string, unknown>).properties as Record<string, unknown>
    ).message;
    expect(portableMessage).toEqual({ type: "string", minLength: 1 });
    expect(portableSpawn).toMatchObject({
      parameters: {
        required: ["message", "model"],
        properties: {
          model: { type: "string", enum: ["deepseek-flash", "glm-5"] },
        },
      },
    });
    expect(result.metadata?.toolMappings).toEqual([
      {
        encodedNamespace: "collaboration-optimize",
        encodedName: "spawn_portable_agent",
        originalNamespace: "collaboration",
        originalName: "spawn_agent",
      },
    ]);
  });

  test("only exposes portable target models visible to the authenticated provider group", async () => {
    const request = makeRequest({ input: [] });
    const providers = [
      {
        id: 84,
        name: "other-group",
        isEnabled: true,
        providerType: "codex",
        codexMultiAgentV2Mode: "portable",
        groupTag: "team-b",
        allowedModels: [{ matchType: "exact", pattern: "deepseek-flash" }],
      } as Provider,
      {
        id: 85,
        name: "visible-group",
        isEnabled: true,
        providerType: "codex",
        codexMultiAgentV2Mode: "portable",
        groupTag: "team-a",
        allowedModels: [{ matchType: "exact", pattern: "glm-5" }],
      } as Provider,
    ];
    const session = makeSession(request, providers);
    session.authState = {
      key: { providerGroup: "team-a" },
      user: null,
    } as ProxySession["authState"];

    const result = await preparePortableCompatibilityRequest({
      session,
      provider: makeProvider("native"),
      request,
    });

    const namespaces = result.request.tools as Array<Record<string, unknown>>;
    const portableTools = namespaces[1].tools as Array<Record<string, unknown>>;
    expect(portableTools.map((tool) => tool.name)).toEqual(["spawn_portable_agent"]);
    expect(portableTools[0]).toMatchObject({
      parameters: { properties: { model: { type: "string", enum: ["glm-5"] } } },
    });
    expect(result.metadata?.portableTargetModels).toEqual(["glm-5"]);
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

  test("prepares a real Codex subagent turn without collaboration tools", async () => {
    const request = makeRequest({
      client_metadata: {
        "x-openai-subagent": "worker",
        "x-codex-parent-thread-id": "parent-thread",
      },
      tools: [{ type: "function", name: "exec_command", parameters: { type: "object" } }],
    });
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
          content: [
            { type: "input_text", text: "Message Type: NEW_TASK\nPayload:\n" },
            { type: "input_text", text: "Implement the bounded worker task." },
          ],
        },
      ],
    });
    expect(result.metadata).toMatchObject({
      toolMappings: [],
      transformations: ["agent_message_input"],
    });
  });

  test("handles additional_tools and remains idempotent after copy-on-write cloning", async () => {
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
    const clonedRequest = structuredClone(first.request);
    const second = await preparePortableCompatibilityRequest({
      session,
      provider: makeProvider(),
      request: clonedRequest,
    });

    expect(second.request).toEqual(first.request);
    expect(second.request).toBe(clonedRequest);
    expect(second.metadata).toBe(first.metadata);
    expect(JSON.stringify(second.request)).not.toContain(
      "collaboration-optimize.collaboration-optimize"
    );

    await expect(
      preparePortableCompatibilityRequest({
        session,
        provider: { ...makeProvider(), id: 43 },
        request: structuredClone(first.request),
      })
    ).rejects.toMatchObject({ compatibilityCode: "name_collision" });
  });

  test("converts single and mixed plaintext agent-message content without reordering", async () => {
    const mixedContent = [
      { type: "input_text", text: "prefix", marker: 1 },
      { type: "input_text", text: "Readable delegated task.", marker: 2 },
      { type: "input_image", image_url: "data:image/png;base64,AA==", marker: 3 },
    ];
    const request = makeRequest({
      input: [
        {
          type: "agent_message",
          content: [{ type: "input_text", text: "Single readable task." }],
        },
        { type: "message", role: "user", content: [{ type: "input_text", text: "already" }] },
        { type: "agent_message", role: "user", content: mixedContent },
      ],
    });
    const result = await preparePortableCompatibilityRequest({
      session: makeSession(request),
      provider: makeProvider(),
      request,
    });
    const input = result.request.input as Array<Record<string, unknown>>;

    expect(input[0]).toMatchObject({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Single readable task." }],
    });
    expect(input[1]).toEqual({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "already" }],
    });
    expect(input[2].content).toEqual([
      { type: "input_text", text: "prefix", marker: 1 },
      { type: "input_text", text: "Readable delegated task.", marker: 2 },
      { type: "input_image", image_url: "data:image/png;base64,AA==", marker: 3 },
    ]);
  });

  test("preserves encrypted agent-message content for a native child", async () => {
    const request = makeRequest({
      input: [
        {
          type: "agent_message",
          id: "amsg_native",
          author: "/root",
          recipient: "/root/native-worker",
          content: [{ type: "encrypted_content", encrypted_content: "opaque-native-payload" }],
        },
      ],
    });
    const before = structuredClone(request);

    const result = await preparePortableCompatibilityRequest({
      session: makeSession(request),
      provider: makeProvider("native"),
      request,
    });
    expect(result.request.input).toEqual(before.input);
    expect(result.metadata?.transformations).toEqual([
      "spawn_agent_message_schema",
      "collaboration_namespace",
    ]);
    expect(request).toEqual(before);
  });

  test("preserves official plaintext agent-message content for a native root", async () => {
    const request = makeRequest();
    const before = structuredClone(request);

    const result = await preparePortableCompatibilityRequest({
      session: makeSession(request),
      provider: makeProvider("native"),
      request,
    });

    expect(result.request.input).toEqual(before.input);
    expect(result.metadata?.transformations).toEqual([
      "spawn_agent_message_schema",
      "collaboration_namespace",
    ]);
    expect(request).toEqual(before);
  });

  test("preserves an opaque native agent-message envelope without creating mixed content", async () => {
    const opaque = `gAAAA${"A".repeat(120)}`;
    const request = makeRequest({
      input: [
        {
          type: "agent_message",
          content: [
            { type: "encrypted_content", encrypted_content: "Readable prefix." },
            { type: "encrypted_content", encrypted_content: opaque },
          ],
        },
      ],
    });
    const before = structuredClone(request);

    const result = await preparePortableCompatibilityRequest({
      session: makeSession(request),
      provider: makeProvider("native"),
      request,
    });

    expect(result.request.input).toEqual(before.input);
    expect(result.metadata?.transformations).toEqual([
      "spawn_agent_message_schema",
      "collaboration_namespace",
    ]);
    expect(request).toEqual(before);
  });

  test("accepts an official plaintext agent message for a portable child", async () => {
    const request = makeRequest({
      client_metadata: {
        "x-openai-subagent": "worker",
        "x-codex-parent-thread-id": "parent-thread",
      },
      tools: [{ type: "function", name: "exec_command", parameters: { type: "object" } }],
      input: [
        {
          type: "agent_message",
          author: "/root",
          recipient: "/root/portable-worker",
          content: [
            { type: "input_text", text: "Message Type: NEW_TASK\nPayload:\n" },
            { type: "input_text", text: "Review the bounded change." },
          ],
        },
      ],
    });

    const result = await preparePortableCompatibilityRequest({
      session: makeSession(request),
      provider: makeProvider("portable"),
      request,
    });

    expect(result.request.input).toEqual([
      {
        type: "message",
        role: "user",
        author: "/root",
        recipient: "/root/portable-worker",
        content: [
          { type: "input_text", text: "Message Type: NEW_TASK\nPayload:\n" },
          { type: "input_text", text: "Review the bounded change." },
        ],
      },
    ]);
    expect(result.metadata?.transformations).toEqual(["agent_message_input"]);
  });

  test.each([
    ["保留本地明文标记", { encrypted_function_args: [] }],
    ["自定义 Provider 已清除本地明文标记", {}],
  ])("restores a replayed plaintext collaboration call when %s", async (_label, marker) => {
    const request = makeRequest({
      input: [
        {
          type: "function_call",
          call_id: "call_portable",
          namespace: "collaboration",
          name: "spawn_agent",
          arguments: JSON.stringify({
            model: "deepseek-flash",
            message: "Review the bounded change.",
          }),
          ...marker,
        },
        {
          type: "function_call_output",
          call_id: "call_portable",
          output: "accepted",
        },
      ],
    });

    const result = await preparePortableCompatibilityRequest({
      session: makeSession(request),
      provider: makeProvider("native"),
      request,
    });
    const input = result.request.input as Array<Record<string, unknown>>;

    expect(input[0]).toMatchObject({
      namespace: "collaboration-optimize",
      name: "spawn_portable_agent",
    });
    expect(input[0]).not.toHaveProperty("encrypted_function_args");
    expect(input[1]).toEqual((request.input as Array<Record<string, unknown>>)[1]);
  });

  test("restores portable-provider collaboration history after Codex strips local markers", async () => {
    const request = makeRequest({
      tools: [spawnAgentNamespace("send_message")],
      input: [
        {
          type: "function_call",
          call_id: "call_portable_root",
          namespace: "collaboration",
          name: "send_message",
          arguments: JSON.stringify({ target: "/root/worker", message: "Continue." }),
        },
      ],
    });

    const result = await preparePortableCompatibilityRequest({
      session: makeSession(request),
      provider: makeProvider("portable"),
      request,
    });
    const input = result.request.input as Array<Record<string, unknown>>;

    expect(input[0]).toMatchObject({
      namespace: "collaboration-optimize",
      name: "send_message",
    });
    expect(input[0]).not.toHaveProperty("encrypted_function_args");
  });

  test("rejects encrypted history for a portable model", async () => {
    const request = makeRequest({
      input: [
        {
          type: "function_call",
          call_id: "call_encrypted_portable",
          namespace: "collaboration",
          name: "spawn_agent",
          arguments: JSON.stringify({
            model: "deepseek-flash",
            message: "opaque-native-message",
          }),
          encrypted_function_args: ["message"],
        },
      ],
    });

    await expect(
      preparePortableCompatibilityRequest({
        session: makeSession(request),
        provider: makeProvider("native"),
        request,
      })
    ).rejects.toMatchObject({ compatibilityCode: "opaque_content" });
  });

  test.each([
    [
      "wrong role",
      { type: "agent_message", role: "assistant", content: [] },
      "client_or_protocol_mismatch",
    ],
    ["missing content", { type: "agent_message" }, "client_or_protocol_mismatch"],
    [
      "missing encrypted value",
      { type: "agent_message", content: [{ type: "encrypted_content" }] },
      "opaque_content",
    ],
    [
      "conflicting text value",
      {
        type: "agent_message",
        content: [{ type: "encrypted_content", encrypted_content: "task", text: "other" }],
      },
      "opaque_content",
    ],
  ])("rejects malformed input: %s", async (_label, item, compatibilityCode) => {
    const request = makeRequest({ input: [item] });
    const before = structuredClone(request);
    await expect(
      preparePortableCompatibilityRequest({
        session: makeSession(request),
        provider: makeProvider(),
        request,
      })
    ).rejects.toMatchObject({ compatibilityCode });
    expect(request).toEqual(before);
  });

  test.each(COLLABORATION_ACTIONS)(
    "leaves an ordinary business tool named %s unchanged when the full gate does not match",
    async (action) => {
      const request = makeRequest({
        tools: [
          {
            type: "function",
            name: action,
            parameters: {
              type: "object",
              properties: { message: { type: "string", encrypted: true } },
            },
          },
        ],
        input: [],
      });
      const result = await preparePortableCompatibilityRequest({
        session: makeSession(request),
        provider: makeProvider(),
        request,
      });

      expect(result).toEqual({ request, metadata: null });
      expect(result.request).toBe(request);
      expect(mocks.getCachedSystemSettings).not.toHaveBeenCalled();
    }
  );

  test("records every transformed action once in canonical order", async () => {
    const namespace = spawnAgentNamespace();
    namespace.tools.push(
      spawnAgentNamespace("send_message").tools[0],
      spawnAgentNamespace("followup_task").tools[0]
    );
    const request = makeRequest({ tools: [namespace], input: [] });
    const result = await preparePortableCompatibilityRequest({
      session: makeSession(request),
      provider: makeProvider(),
      request,
    });

    expect(result.metadata?.toolMappings.map((mapping) => mapping.originalName)).toEqual(
      COLLABORATION_ACTIONS
    );
    expect(result.metadata?.transformations).toEqual([
      "spawn_agent_message_schema",
      "send_message_message_schema",
      "followup_task_message_schema",
      "collaboration_namespace",
    ]);
  });

  test("maps every collaboration tool while only rewriting encrypted message schemas", async () => {
    const namespace = spawnAgentNamespace();
    const unsupportedCollaborationTool = {
      type: "function",
      name: "wait_agent",
      description: "Wait for agents",
      parameters: {
        type: "object",
        properties: { timeout: { type: "number", encrypted: true } },
      },
    };
    const businessTool = {
      type: "function",
      name: "lookup_order",
      parameters: {
        type: "object",
        properties: { message: { type: "string", encrypted: true } },
      },
    };
    namespace.tools.push(unsupportedCollaborationTool);
    const request = makeRequest({ tools: [namespace, businessTool], input: [] });
    const result = await preparePortableCompatibilityRequest({
      session: makeSession(request),
      provider: makeProvider(),
      request,
    });
    const rewrittenTools = result.request.tools as Array<Record<string, unknown>>;
    const rewrittenNamespaceTools = rewrittenTools[0].tools as unknown[];

    expect(rewrittenNamespaceTools[1]).toEqual(unsupportedCollaborationTool);
    expect(rewrittenTools[1]).toEqual(businessTool);
    expect(result.metadata?.toolMappings.map((mapping) => mapping.originalName)).toEqual([
      "spawn_agent",
      "wait_agent",
    ]);
    expect(result.metadata?.transformations).toEqual([
      "spawn_agent_message_schema",
      "collaboration_namespace",
    ]);
  });

  test("rejects an ordinary tool that collides with any renamed collaboration tool", async () => {
    const namespace = spawnAgentNamespace();
    namespace.tools.push({
      type: "function",
      name: "wait_agent",
      parameters: { type: "object", properties: {} },
    });
    const request = makeRequest({
      tools: [
        namespace,
        {
          type: "function",
          name: "wait_agent",
          parameters: { type: "object", properties: {} },
        },
      ],
      input: [],
    });

    await expect(
      preparePortableCompatibilityRequest({
        session: makeSession(request),
        provider: makeProvider(),
        request,
      })
    ).rejects.toMatchObject({ compatibilityCode: "name_collision" });
  });

  test("keeps native mode byte-for-byte unchanged while the global switch is off", async () => {
    mocks.getCachedSystemSettings.mockResolvedValueOnce({
      enableCodexMultiAgentV2Compatibility: false,
    });
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
    expect(mocks.getCachedSystemSettings).toHaveBeenCalledOnce();
  });

  test("keeps native fake streaming unchanged while the global switch is off", async () => {
    mocks.getCachedSystemSettings.mockResolvedValueOnce({
      enableCodexMultiAgentV2Compatibility: false,
    });
    const request = makeRequest();
    const session = makeSession(request);
    session.isFakeStreamingAttempt = () => true;

    await expect(
      preparePortableCompatibilityRequest({
        session,
        provider: makeProvider("native"),
        request,
      })
    ).resolves.toEqual({ request, metadata: null });
  });

  test("rejects a malformed collaboration schema when an attempt is re-evaluated", async () => {
    const namespace = spawnAgentNamespace();
    namespace.tools[0]!.parameters.properties.message = {
      type: "string",
    } as { type: string; encrypted: boolean };
    const request = makeRequest({ tools: [namespace], input: [] });

    await expect(
      preparePortableCompatibilityRequest({
        session: makeSession(request),
        provider: makeProvider(),
        request,
      })
    ).rejects.toMatchObject({ compatibilityCode: "client_or_protocol_mismatch" });
  });

  test("validates the actual attempt body instead of the session's stale request body", async () => {
    const original = makeRequest();
    const namespace = spawnAgentNamespace();
    namespace.tools[0]!.parameters.properties.message = {
      type: "string",
    } as { type: string; encrypted: boolean };
    const actualAttempt = makeRequest({ tools: [namespace], input: [] });

    await expect(
      preparePortableCompatibilityRequest({
        session: makeSession(original),
        provider: makeProvider(),
        request: actualAttempt,
      })
    ).rejects.toMatchObject({ compatibilityCode: "client_or_protocol_mismatch" });
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
      errorType: "compatibility_provider_disabled",
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

  test("fails closed on reserved names and supports streaming requests", async () => {
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

    const customToolCollision = makeRequest({
      tools: [
        spawnAgentNamespace(),
        {
          type: "custom",
          name: "spawn_agent",
          description: "Unrelated business tool",
        },
      ],
    });
    await expect(
      preparePortableCompatibilityRequest({
        session: makeSession(customToolCollision),
        provider: makeProvider(),
        request: customToolCollision,
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
    const preparedStreaming = await preparePortableCompatibilityRequest({
      session: makeSession(streaming),
      provider: makeProvider(),
      request: streaming,
    });
    expect(preparedStreaming.request).toMatchObject({
      stream: true,
      tools: [{ name: "collaboration-optimize" }],
    });
    expect(preparedStreaming.metadata).not.toBeNull();
  });

  test.each([
    ...COLLABORATION_ACTIONS.map((action) => ["bare action", action] as const),
    ["reserved namespace", "collaboration-optimize"] as const,
    ["reserved dot name", "collaboration-optimize.business"] as const,
    ["reserved double name", "collaboration-optimize__business"] as const,
  ])("rejects %s collision %s before changing the request", async (_label, name) => {
    const request = makeRequest({
      tools: [spawnAgentNamespace(), { type: "function", name, parameters: {} }],
    });
    const before = structuredClone(request);
    await expect(
      preparePortableCompatibilityRequest({
        session: makeSession(request),
        provider: makeProvider(),
        request,
      })
    ).rejects.toMatchObject({ compatibilityCode: "name_collision" });
    expect(request).toEqual(before);
  });

  test("rejects duplicate action mappings across tool containers", async () => {
    const request = makeRequest({
      tools: [spawnAgentNamespace()],
      input: [
        {
          type: "additional_tools",
          tools: [spawnAgentNamespace()],
        },
      ],
    });
    await expect(
      preparePortableCompatibilityRequest({
        session: makeSession(request),
        provider: makeProvider(),
        request,
      })
    ).rejects.toMatchObject({ compatibilityCode: "name_collision" });
  });

  test("leaves CCH-owned remote compaction summary requests outside the codec", async () => {
    const request = makeRequest();
    const session = makeSession(request);
    session.isInternalCompactionRequest = () => true;

    const result = await preparePortableCompatibilityRequest({
      session,
      provider: makeProvider("portable"),
      request,
    });

    expect(result).toEqual({ request, metadata: null });
    expect(result.request).toBe(request);
    expect(mocks.getCachedSystemSettings).not.toHaveBeenCalled();
  });
});
