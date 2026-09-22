import { describe, expect, test } from "vitest";
import {
  createPortableResponseRestoreState,
  PortableCompatibilityError,
  restorePortableCompatibilityEventPayload,
  restorePortableCompatibilityPayload,
  restorePortableCompatibilityResponse,
  type PortableTransformationMetadata,
} from "@/app/v1/_lib/proxy/codex-portable-compatibility";

type CollaborationAction = "spawn_agent" | "send_message" | "followup_task";

const COLLABORATION_ACTIONS: CollaborationAction[] = [
  "spawn_agent",
  "send_message",
  "followup_task",
];

function metadata(
  actions: CollaborationAction[] = ["spawn_agent"]
): PortableTransformationMetadata {
  const transformations = actions.map(
    (action) => `${action}_message_schema` as const
  ) as PortableTransformationMetadata["transformations"];
  transformations.push("collaboration_namespace");
  const audit = {
    type: "codex_multi_agent_v2_portable" as const,
    scope: "request" as const,
    hit: true as const,
    mode: "portable" as const,
    state: "request_transformed" as const,
    requestedTransport: "http" as const,
    actualTransport: null,
    requestedProviderId: 42,
    requestedProviderName: "fixture-provider",
    actualProviderId: 42,
    actualProviderName: "fixture-provider",
    requestedModel: "requested-model",
    actualModel: "actual-model",
    transformations: [...transformations],
    responseRestore: "pending" as const,
    errorCategory: null,
    requestId: 123,
    sessionId: "session-fixture",
    responseId: null,
  };
  return {
    version: 1,
    providerId: 42,
    requestFingerprint: "fixture-request-fingerprint",
    requestedModel: "requested-model",
    actualModel: "actual-model",
    transformations: [...audit.transformations],
    matchedPaths: ["tools.0.tools.0"],
    responseRestore: "pending",
    toolMappings: actions.map((action) => ({
      encodedNamespace: "collaboration-optimize",
      originalNamespace: "collaboration",
      originalName: action,
    })),
    audit,
  };
}

describe("Codex MultiAgentV2 portable response codec", () => {
  test("marks only a restored portable spawn call as plaintext", () => {
    const state = Object.assign(metadata(), {
      toolPresentation: "duplicate" as const,
      portableTargetModels: ["deepseek-flash"],
      toolMappings: [
        {
          encodedNamespace: "collaboration-optimize",
          encodedName: "spawn_portable_agent",
          originalNamespace: "collaboration",
          originalName: "spawn_agent",
        },
      ],
    });
    const payload = {
      output: [
        {
          type: "function_call",
          call_id: "call_portable",
          namespace: "collaboration-optimize",
          name: "spawn_portable_agent",
          arguments: JSON.stringify({
            model: "deepseek-flash",
            message: "Review the bounded change.",
          }),
        },
        {
          type: "function_call",
          call_id: "call_native",
          namespace: "collaboration",
          name: "spawn_agent",
          arguments: JSON.stringify({
            model: "gpt-5.6",
            message: "opaque-native-message",
          }),
        },
      ],
    };

    const restored = restorePortableCompatibilityPayload(payload, state);
    const output = (restored.payload as { output: Array<Record<string, unknown>> }).output;

    expect(output[0]).toMatchObject({
      namespace: "collaboration",
      name: "spawn_agent",
      encrypted_function_args: [],
    });
    expect(output[1]).not.toHaveProperty("encrypted_function_args");
    expect(output[1]).toEqual(payload.output[1]);
  });

  test("passes native collaboration calls through when native tools were preserved", () => {
    const state = Object.assign(metadata(), { toolPresentation: "duplicate" as const });
    const payload = {
      output: [
        {
          type: "function_call",
          call_id: "call_wait",
          namespace: "collaboration",
          name: "wait_agent",
          arguments: "{}",
        },
      ],
    };

    expect(restorePortableCompatibilityPayload(payload, state)).toEqual({
      payload,
      restoredCount: 0,
    });
  });

  test.each([
    { namespace: "collaboration", name: "spawn_agent" },
    { name: "collaboration.spawn_agent" },
    { name: "collaboration__spawn_agent" },
    { name: "spawn_agent" },
  ])("preserves native spawn identity %# when tools were duplicated", (identity) => {
    const state = Object.assign(metadata(), {
      toolPresentation: "duplicate" as const,
      portableTargetModels: ["deepseek-flash"],
    });
    const item = {
      type: "function_call",
      call_id: "call_native_shape",
      ...identity,
      arguments: JSON.stringify({ model: "gpt-5.6", message: "opaque-native-message" }),
    };
    const payload = { output: [item] };

    expect(restorePortableCompatibilityPayload(payload, state)).toEqual({
      payload,
      restoredCount: 0,
    });
    expect(item).not.toHaveProperty("encrypted_function_args");
  });

  test("rejects a native spawn call that names a portable-only model", () => {
    const state = Object.assign(metadata(), {
      toolPresentation: "duplicate" as const,
      portableTargetModels: ["deepseek-flash"],
    });

    expect(() =>
      restorePortableCompatibilityPayload(
        {
          output: [
            {
              type: "function_call",
              call_id: "call_wrong_channel",
              namespace: "collaboration",
              name: "spawn_agent",
              arguments: JSON.stringify({ model: "deepseek-flash", message: "Do the task." }),
            },
          ],
        },
        state
      )
    ).toThrowError(
      expect.objectContaining({
        compatibilityCode: "malformed_response",
        fieldPath: "output.0.arguments.model",
      })
    );
  });

  test("rejects a portable spawn call whose model is outside the allowed targets", () => {
    const state = Object.assign(metadata(), {
      toolPresentation: "duplicate" as const,
      portableTargetModels: ["deepseek-flash", "glm-5"],
      toolMappings: [
        {
          encodedNamespace: "collaboration-optimize",
          encodedName: "spawn_portable_agent",
          originalNamespace: "collaboration",
          originalName: "spawn_agent",
        },
      ],
    });

    expect(() =>
      restorePortableCompatibilityPayload(
        {
          output: [
            {
              type: "function_call",
              call_id: "call_wrong_target",
              namespace: "collaboration-optimize",
              name: "spawn_portable_agent",
              arguments: JSON.stringify({ model: "other-model", message: "Do the task." }),
            },
          ],
        },
        state
      )
    ).toThrowError(
      expect.objectContaining({
        compatibilityCode: "malformed_response",
        fieldPath: "output.0.arguments.model",
      })
    );
  });

  test("does not validate ordinary function-call sequencing for input-only transformations", () => {
    const inputOnly = metadata();
    inputOnly.toolMappings = [];
    inputOnly.transformations = ["agent_message_input"];
    inputOnly.audit.transformations = ["agent_message_input"];
    const event = {
      type: "response.function_call_arguments.delta",
      item_id: "fc_exec",
      output_index: 0,
      delta: "{}",
    };

    expect(
      restorePortableCompatibilityEventPayload(
        event,
        inputOnly,
        createPortableResponseRestoreState()
      )
    ).toEqual({ payload: event, restoredCount: 0 });
  });

  test("does not bind ordinary function calls while restoring collaboration tools", () => {
    const state = metadata();
    const restoreState = createPortableResponseRestoreState();
    const added = {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "function_call", id: "fc_exec", name: "exec_command" },
    };
    const delta = {
      type: "response.function_call_arguments.delta",
      item_id: "fc_exec",
      output_index: 0,
      delta: "{}",
    };

    expect(restorePortableCompatibilityEventPayload(added, state, restoreState)).toEqual({
      payload: added,
      restoredCount: 0,
    });
    expect(restorePortableCompatibilityEventPayload(delta, state, restoreState)).toEqual({
      payload: delta,
      restoredCount: 0,
    });
  });

  test("restores tools without encrypted messages after the whole namespace is renamed", () => {
    const state = metadata();
    state.toolMappings.push({
      encodedNamespace: "collaboration-optimize",
      originalNamespace: "collaboration",
      originalName: "wait_agent",
    } as PortableTransformationMetadata["toolMappings"][number]);
    const payload = {
      output: [
        {
          type: "function_call",
          call_id: "call_wait",
          namespace: "collaboration-optimize",
          name: "wait_agent",
          arguments: "{}",
        },
      ],
    };

    expect(restorePortableCompatibilityPayload(payload, state)).toEqual({
      payload: {
        output: [
          {
            type: "function_call",
            call_id: "call_wait",
            namespace: "collaboration",
            name: "wait_agent",
            arguments: "{}",
          },
        ],
      },
      restoredCount: 1,
    });
  });

  test.each(
    COLLABORATION_ACTIONS.flatMap((action) => [
      {
        action,
        label: "structured namespace",
        identity: { namespace: "collaboration-optimize", name: action },
        expected: { namespace: "collaboration", name: action },
      },
      {
        action,
        label: "dot-flattened name",
        identity: { name: `collaboration-optimize.${action}` },
        expected: { namespace: "collaboration", name: action },
      },
      {
        action,
        label: "double-underscore name",
        identity: { name: `collaboration-optimize__${action}` },
        expected: { name: `collaboration__${action}` },
      },
      {
        action,
        label: "omitted namespace",
        identity: { name: action },
        expected: { namespace: "collaboration", name: action },
      },
    ])
  )("restores $action with $label", ({ identity, expected }) => {
    const argumentsText = JSON.stringify({ message: "delegated task remains untouched" });
    const result = restorePortableCompatibilityPayload(
      {
        output: [
          {
            type: "function_call",
            call_id: "call_1",
            arguments: argumentsText,
            ...identity,
          },
        ],
      },
      metadata(COLLABORATION_ACTIONS)
    );

    expect(result.restoredCount).toBe(1);
    expect((result.payload as { output: unknown[] }).output[0]).toMatchObject({
      type: "function_call",
      call_id: "call_1",
      arguments: argumentsText,
      ...expected,
    });
  });

  test("leaves ordinary function calls and restored payloads unchanged", () => {
    const payload = {
      output: [
        { type: "function_call", name: "business_tool", arguments: "{}" },
        {
          type: "function_call",
          namespace: "collaboration",
          name: "spawn_agent",
          arguments: "{}",
        },
      ],
    };
    expect(restorePortableCompatibilityPayload(payload, metadata())).toEqual({
      payload,
      restoredCount: 0,
    });
  });

  test.each([
    { namespace: "collaboration", name: "unknown_action" },
    { name: "collaboration__unknown_action" },
  ])("fails closed for an unmapped original collaboration identity", (identity) => {
    expect(() =>
      restorePortableCompatibilityPayload(
        {
          output: [
            {
              type: "function_call",
              arguments: "{}",
              ...identity,
            },
          ],
        },
        metadata()
      )
    ).toThrowError(expect.objectContaining({ compatibilityCode: "unknown_tool" }));
  });

  test("fails closed when an encoded response has no mapping", () => {
    expect(() =>
      restorePortableCompatibilityPayload(
        {
          output: [
            {
              type: "function_call",
              namespace: "collaboration-optimize",
              name: "send_message",
              arguments: "{}",
            },
          ],
        },
        metadata()
      )
    ).toThrowError(PortableCompatibilityError);
    expect(() =>
      restorePortableCompatibilityPayload(
        {
          output: [
            {
              type: "function_call",
              namespace: "collaboration-optimize",
              name: "send_message",
              arguments: "{}",
            },
          ],
        },
        metadata()
      )
    ).toThrowError(expect.objectContaining({ compatibilityCode: "missing_mapping" }));
  });

  test("distinguishes unknown, duplicate, and ambiguous mappings", () => {
    expect(() =>
      restorePortableCompatibilityPayload(
        {
          output: [
            {
              type: "function_call",
              name: "collaboration-optimize.unknown_action",
              arguments: "{}",
            },
          ],
        },
        metadata()
      )
    ).toThrowError(expect.objectContaining({ compatibilityCode: "unknown_tool" }));

    const duplicate = metadata();
    duplicate.toolMappings.push({ ...duplicate.toolMappings[0] });
    expect(() =>
      restorePortableCompatibilityPayload(
        { output: [{ type: "function_call", name: "spawn_agent", arguments: "{}" }] },
        duplicate
      )
    ).toThrowError(expect.objectContaining({ compatibilityCode: "duplicate_mapping" }));

    const ambiguous = metadata();
    ambiguous.toolMappings.push({
      ...ambiguous.toolMappings[0],
      encodedNamespace: "alternate-collaboration-optimize",
    });
    expect(() =>
      restorePortableCompatibilityPayload(
        { output: [{ type: "function_call", name: "spawn_agent", arguments: "{}" }] },
        ambiguous
      )
    ).toThrowError(expect.objectContaining({ compatibilityCode: "ambiguous_mapping" }));
  });

  test("does not include tool arguments in compatibility failures", () => {
    const delegatedText = "private delegated task body";
    let failure: unknown;
    try {
      restorePortableCompatibilityPayload(
        {
          output: [
            {
              type: "function_call",
              name: "collaboration-optimize.unknown_action",
              arguments: JSON.stringify({ message: delegatedText }),
            },
          ],
        },
        metadata()
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(PortableCompatibilityError);
    expect(JSON.stringify(failure)).not.toContain(delegatedText);
    expect((failure as PortableCompatibilityError).message).not.toContain(delegatedText);
  });

  test.each([
    ["missing call name", { type: "function_call", arguments: "{}" }],
    [
      "non-string namespace",
      { type: "function_call", namespace: 1, name: "spawn_agent", arguments: "{}" },
    ],
    ["non-object output item", null],
  ])("fails closed on malformed function-call shape: %s", (_label, item) => {
    expect(() => restorePortableCompatibilityPayload({ output: [item] }, metadata())).toThrowError(
      expect.objectContaining({ compatibilityCode: "malformed_response" })
    );
  });

  test("rebuilds a non-streaming JSON response and updates safe audit state", async () => {
    const state = metadata();
    const response = await restorePortableCompatibilityResponse(
      new Response(
        JSON.stringify({
          id: "resp_1",
          output: [
            {
              type: "function_call",
              namespace: "collaboration-optimize",
              name: "spawn_agent",
              arguments: "{}",
            },
          ],
        }),
        { headers: { "content-type": "application/json", "content-length": "1" } }
      ),
      state
    );

    expect(response.headers.has("content-length")).toBe(false);
    await expect(response.json()).resolves.toMatchObject({
      output: [{ namespace: "collaboration", name: "spawn_agent" }],
    });
    expect(state.responseRestore).toBe("restored");
    expect(state.audit).toMatchObject({
      state: "response_restored",
      actualTransport: "http",
      responseRestore: "restored",
      errorCategory: null,
      responseId: "resp_1",
    });
    expect(JSON.stringify(state.audit)).not.toContain("delegated task");
  });

  test("preserves an upstream HTTP error and records a terminal failed audit", async () => {
    const state = metadata();
    state.toolMappings = [];
    state.transformations = ["agent_message_input"];
    state.audit.transformations = ["agent_message_input"];
    let finalized = false;
    const response = await restorePortableCompatibilityResponse(
      new Response('{"error":{"message":"invalid model"}}', {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
      state,
      { onFinalize: () => (finalized = true) }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: { message: "invalid model" } });
    expect(finalized).toBe(true);
    expect(state.responseRestore).toBe("not_needed");
    expect(state.audit).toMatchObject({
      state: "failed",
      actualTransport: "http",
      responseRestore: "not_needed",
      errorCategory: null,
      responseId: null,
    });
  });

  test.each(["failed", "incomplete"])(
    "does not audit a non-streaming %s response as restored",
    async (status) => {
      const state = metadata();
      const payload = {
        id: "resp_failed",
        object: "response",
        status,
        output: [
          {
            type: "function_call",
            namespace: "collaboration-optimize",
            name: "spawn_agent",
            arguments: "{}",
          },
        ],
      };
      const response = await restorePortableCompatibilityResponse(
        new Response(JSON.stringify(payload), {
          headers: { "content-type": "application/json" },
        }),
        state
      );

      await expect(response.json()).resolves.toEqual(payload);
      expect(state.responseRestore).toBe("not_needed");
      expect(state.audit).toMatchObject({
        state: "failed",
        responseRestore: "not_needed",
        responseId: "resp_failed",
      });
    }
  );

  test("fails closed on non-JSON and invalid JSON responses", async () => {
    const nonJsonState = metadata();
    await expect(
      restorePortableCompatibilityResponse(
        new Response("upstream text", { headers: { "content-type": "text/plain" } }),
        nonJsonState
      )
    ).rejects.toMatchObject({ compatibilityCode: "malformed_response" });
    expect(nonJsonState.responseRestore).toBe("failed");
    expect(nonJsonState.audit).toMatchObject({
      state: "failed",
      actualTransport: "http",
      responseRestore: "failed",
      errorCategory: "compatibility_restore_failed",
      responseId: null,
    });

    await expect(
      restorePortableCompatibilityResponse(
        new Response("{", { headers: { "content-type": "application/json" } }),
        metadata()
      )
    ).rejects.toMatchObject({ compatibilityCode: "malformed_response" });
  });

  test.each([
    ["missing output", { id: "resp_1" }],
    ["non-array output", { id: "resp_1", output: {} }],
    ["nested non-array output", { response: { output: null } }],
  ])("fails closed on %s", (_label, payload) => {
    expect(() => restorePortableCompatibilityPayload(payload, metadata())).toThrowError(
      PortableCompatibilityError
    );
  });
});
