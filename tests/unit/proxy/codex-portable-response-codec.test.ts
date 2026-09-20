import { describe, expect, test } from "vitest";
import {
  PortableCompatibilityError,
  restorePortableCompatibilityPayload,
  restorePortableCompatibilityResponse,
  type PortableTransformationMetadata,
} from "@/app/v1/_lib/proxy/codex-portable-compatibility";

function metadata(): PortableTransformationMetadata {
  const audit = {
    type: "codex_multi_agent_v2_portable" as const,
    scope: "request" as const,
    hit: true as const,
    providerId: 42,
    requestedModel: "requested-model",
    actualModel: "actual-model",
    transformations: ["spawn_agent_message_schema" as const, "collaboration_namespace" as const],
    responseRestore: "pending" as const,
    errorCode: null,
  };
  return {
    version: 1,
    providerId: 42,
    requestedModel: "requested-model",
    actualModel: "actual-model",
    transformations: [...audit.transformations],
    matchedPaths: ["tools.0.tools.0"],
    responseRestore: "pending",
    toolMappings: [
      {
        encodedNamespace: "collaboration-optimize",
        originalNamespace: "collaboration",
        originalName: "spawn_agent",
      },
    ],
    audit,
  };
}

describe("Codex MultiAgentV2 portable response codec", () => {
  test.each([
    [
      "structured namespace",
      { namespace: "collaboration-optimize", name: "spawn_agent" },
      { namespace: "collaboration", name: "spawn_agent" },
    ],
    [
      "dot-flattened name",
      { name: "collaboration-optimize.spawn_agent" },
      { namespace: "collaboration", name: "spawn_agent" },
    ],
    [
      "double-underscore name",
      { name: "collaboration-optimize__spawn_agent" },
      { name: "collaboration__spawn_agent" },
    ],
    [
      "omitted namespace",
      { name: "spawn_agent" },
      { namespace: "collaboration", name: "spawn_agent" },
    ],
  ])("restores %s using request-local metadata", (_label, identity, expected) => {
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
      metadata()
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
    expect(nonJsonState.audit.errorCode).toBe("malformed_response");

    await expect(
      restorePortableCompatibilityResponse(
        new Response("{", { headers: { "content-type": "application/json" } }),
        metadata()
      )
    ).rejects.toMatchObject({ compatibilityCode: "malformed_response" });
  });
});
