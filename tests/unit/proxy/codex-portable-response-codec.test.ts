import { describe, expect, test } from "vitest";
import {
  PortableCompatibilityError,
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
    expect(state.audit.responseRestore).toBe("restored");
    expect(JSON.stringify(state.audit)).not.toContain("delegated task");
  });

  test("fails closed on non-JSON and invalid JSON responses", async () => {
    const nonJsonState = metadata();
    await expect(
      restorePortableCompatibilityResponse(
        new Response("upstream text", { headers: { "content-type": "text/plain" } }),
        nonJsonState
      )
    ).rejects.toMatchObject({ compatibilityCode: "malformed_response" });
    expect(nonJsonState.responseRestore).toBe("failed");
    expect(nonJsonState.audit.errorCategory).toBe("compatibility_restore_failed");

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
