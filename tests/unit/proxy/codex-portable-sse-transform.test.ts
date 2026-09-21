import { describe, expect, test, vi } from "vitest";
import {
  restorePortableCompatibilityResponse,
  type PortableTransformationMetadata,
} from "@/app/v1/_lib/proxy/codex-portable-compatibility";

type CollaborationAction = "spawn_agent" | "send_message" | "followup_task";

const ACTIONS: CollaborationAction[] = ["spawn_agent", "send_message", "followup_task"];

function metadata(actions: CollaborationAction[] = ACTIONS): PortableTransformationMetadata {
  const transformations = actions.map(
    (action) => `${action}_message_schema` as const
  ) as PortableTransformationMetadata["transformations"];
  transformations.push("collaboration_namespace");
  return {
    version: 1,
    providerId: 42,
    requestFingerprint: "sse-fixture",
    requestedModel: "requested-model",
    actualModel: "actual-model",
    toolMappings: actions.map((action) => ({
      encodedNamespace: "collaboration-optimize",
      originalNamespace: "collaboration",
      originalName: action,
    })),
    transformations,
    matchedPaths: ["tools.0.tools.0"],
    responseRestore: "pending",
    audit: {
      type: "codex_multi_agent_v2_portable",
      scope: "request",
      hit: true,
      mode: "portable",
      state: "request_transformed",
      requestedTransport: "sse",
      actualTransport: null,
      requestedProviderId: 42,
      requestedProviderName: "fixture-provider",
      actualProviderId: 42,
      actualProviderName: "fixture-provider",
      requestedModel: "requested-model",
      actualModel: "actual-model",
      transformations,
      responseRestore: "pending",
      errorCategory: null,
      requestId: 123,
      sessionId: "session-fixture",
      responseId: null,
    },
  };
}

function chunkedResponse(text: string, chunkSizes: number[]): Response {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  let chunkIndex = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.length) {
          controller.close();
          return;
        }
        const size = chunkSizes[chunkIndex % chunkSizes.length];
        chunkIndex += 1;
        controller.enqueue(bytes.slice(offset, Math.min(bytes.length, offset + size)));
        offset += size;
      },
    }),
    { headers: { "content-type": "text/event-stream", "content-length": "999" } }
  );
}

function eventData(text: string): unknown[] {
  return text
    .split(/\r?\n\r?\n/)
    .map((event) =>
      event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n")
    )
    .filter((data) => data.length > 0 && data !== "[DONE]")
    .map((data) => JSON.parse(data));
}

function callSequence(action: CollaborationAction): string {
  const added = JSON.stringify(
    {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        id: "item_1",
        type: "function_call",
        call_id: "call_1",
        namespace: "collaboration-optimize",
        name: action,
        arguments: "",
      },
    },
    null,
    2
  );
  return [
    ": keep-alive\r\n",
    "\r\n",
    "id: event-1\r\n",
    "x-provider-field: retained\r\n",
    "event: response.output_item.added\r\n",
    ...added.split("\n").map((line) => `data: ${line}\r\n`),
    "\r\n",
    `data: ${JSON.stringify({
      type: "response.function_call_arguments.delta",
      item_id: "item_1",
      output_index: 0,
      delta: '{"message":"正文保持原样',
    })}\n\n`,
    `data: ${JSON.stringify({
      type: "response.function_call_arguments.done",
      item_id: "item_1",
      output_index: 0,
      arguments: '{"message":"正文保持原样"}',
    })}\n\n`,
    `data: ${JSON.stringify({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: "item_1",
        type: "function_call",
        call_id: "call_1",
        name: `collaboration-optimize.${action}`,
        arguments: '{"message":"正文保持原样"}',
      },
    })}\n\n`,
    `data: ${JSON.stringify({
      type: "response.output_text.delta",
      output_index: 1,
      delta: "普通文本不变",
    })}\n\n`,
    `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        id: "resp_1",
        output: [
          {
            id: "item_1",
            type: "function_call",
            call_id: "call_1",
            name: `collaboration-optimize__${action}`,
            arguments: '{"message":"正文保持原样"}',
          },
        ],
        usage: { input_tokens: 3, output_tokens: 5 },
      },
    })}\n\n`,
    "data:[DONE]\n\n",
  ].join("");
}

describe("Codex portable SSE response transform", () => {
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
  ])("restores %s inside an SSE output item", async (_label, identity, expected) => {
    const event = {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        id: "item_shape",
        type: "function_call",
        call_id: "call_shape",
        arguments: "{}",
        ...identity,
      },
    };
    const response = await restorePortableCompatibilityResponse(
      chunkedResponse(`data: ${JSON.stringify(event)}\n\n`, [2, 1, 5]),
      metadata()
    );
    const [restored] = eventData(await response.text()) as Array<{
      item: Record<string, unknown>;
    }>;

    expect(restored.item).toMatchObject(expected);
  });

  test.each(ACTIONS)(
    "restores the complete function-call event sequence for %s across arbitrary chunks",
    async (action) => {
      const state = metadata();
      const finalize = vi.fn();
      const response = await restorePortableCompatibilityResponse(
        chunkedResponse(callSequence(action), [1, 2, 7, 3, 11]),
        state,
        { onFinalize: finalize }
      );

      expect(response.headers.has("content-length")).toBe(false);
      const text = await response.text();
      const events = eventData(text) as Array<Record<string, any>>;

      expect(text).toContain(": keep-alive\r\n");
      expect(text).toContain("id: event-1\r\n");
      expect(text).toContain("x-provider-field: retained\r\n");
      expect(text).toContain("data:[DONE]\n\n");
      expect(events[0].item).toMatchObject({ namespace: "collaboration", name: action });
      expect(events[1].delta).toBe('{"message":"正文保持原样');
      expect(events[2].arguments).toBe('{"message":"正文保持原样"}');
      expect(events[3].item).toMatchObject({ namespace: "collaboration", name: action });
      expect(events[4]).toMatchObject({
        type: "response.output_text.delta",
        delta: "普通文本不变",
      });
      expect(events[5].response.output[0]).toMatchObject({
        name: `collaboration__${action}`,
        arguments: '{"message":"正文保持原样"}',
      });
      expect(events[5].response.usage).toEqual({ input_tokens: 3, output_tokens: 5 });
      expect(state.responseRestore).toBe("restored");
      expect(state.audit).toMatchObject({
        state: "response_restored",
        actualTransport: "sse",
        responseRestore: "restored",
        errorCategory: null,
        responseId: "resp_1",
      });
      expect(finalize).toHaveBeenCalledOnce();
    }
  );

  test("fails closed on an inconsistent identity and never forwards later frames", async () => {
    const secret = "private delegated arguments";
    const state = metadata();
    const stream = [
      `data: ${JSON.stringify({
        type: "response.output_item.added",
        output_index: 0,
        item: {
          id: "item_1",
          type: "function_call",
          call_id: "call_1",
          name: "collaboration-optimize.spawn_agent",
          arguments: "",
        },
      })}\n\n`,
      `data: ${JSON.stringify({
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: "item_1",
          type: "function_call",
          call_id: "call_1",
          name: "collaboration-optimize.send_message",
          arguments: secret,
        },
      })}\n\n`,
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "must-not-pass" })}\n\n`,
    ].join("");

    const response = await restorePortableCompatibilityResponse(
      chunkedResponse(stream, [stream.length]),
      state
    );
    const text = await response.text();

    expect(text).toContain("compatibility_restore_failed");
    expect(text).not.toContain(secret);
    expect(text).not.toContain("must-not-pass");
    expect(state.responseRestore).toBe("failed");
    expect(state.audit).toMatchObject({
      state: "failed",
      actualTransport: "sse",
      responseRestore: "failed",
      errorCategory: "compatibility_restore_failed",
      responseId: null,
    });
  });

  test("fails closed when delta identifiers cross two calls using the same tool", async () => {
    const callItem = (id: string, callId: string) => ({
      id,
      type: "function_call",
      call_id: callId,
      name: "collaboration-optimize.spawn_agent",
      arguments: "",
    });
    const events = [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: callItem("item_a", "call_a"),
      },
      {
        type: "response.output_item.added",
        output_index: 1,
        item: callItem("item_b", "call_b"),
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "item_a",
        output_index: 1,
        delta: "{}",
      },
    ];
    const state = metadata();
    const response = await restorePortableCompatibilityResponse(
      chunkedResponse(
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
        [13, 2, 5]
      ),
      state
    );
    const text = await response.text();

    expect(text).toContain("compatibility_restore_failed");
    expect(state.responseRestore).toBe("failed");
  });

  test("fails closed on malformed JSON and unterminated framing", async () => {
    for (const body of ["data: {broken}\n\n", 'data: {"type":"response.created"}']) {
      const state = metadata();
      const response = await restorePortableCompatibilityResponse(
        chunkedResponse(body, [1]),
        state
      );
      const text = await response.text();
      expect(text).toContain("compatibility_restore_failed");
      expect(state.responseRestore).toBe("failed");
    }
  });

  test("fails closed when a framed SSE stream ends without a terminal response event", async () => {
    const state = metadata();
    const body = `data: ${JSON.stringify({
      type: "response.output_item.added",
      output_index: 0,
      item: {
        id: "item_1",
        type: "function_call",
        call_id: "call_1",
        name: "collaboration-optimize.spawn_agent",
        arguments: "{}",
      },
    })}\n\n`;
    const response = await restorePortableCompatibilityResponse(
      chunkedResponse(body, [body.length]),
      state
    );
    const text = await response.text();

    expect(text).toContain("compatibility_restore_failed");
    expect(state.responseRestore).toBe("failed");
    expect(state.audit.state).toBe("failed");
  });

  test.each(["response.failed", "response.incomplete"])(
    "keeps the upstream %s terminal event but never audits it as success",
    async (type) => {
      const state = metadata([]);
      const body = `data: ${JSON.stringify({ type, response: { id: "resp_failed" } })}\n\ndata: [DONE]\n\n`;
      const response = await restorePortableCompatibilityResponse(
        chunkedResponse(body, [body.length]),
        state
      );
      const text = await response.text();

      expect(text).toContain(type);
      expect(text).not.toContain("compatibility_restore_failed");
      expect(state.responseRestore).toBe("not_needed");
      expect(state.audit).toMatchObject({
        state: "failed",
        responseRestore: "not_needed",
        errorCategory: null,
        responseId: "resp_failed",
      });
    }
  );

  test("fails closed when a completed terminal follows a failed terminal", async () => {
    const state = metadata([]);
    const body = [
      { type: "response.failed", response: { id: "resp_1" } },
      { type: "response.completed", response: { id: "resp_1", output: [] } },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join("");
    const response = await restorePortableCompatibilityResponse(
      chunkedResponse(body, [body.length]),
      state
    );
    const text = await response.text();

    expect(text).toContain("compatibility_restore_failed");
    expect(state.responseRestore).toBe("failed");
    expect(state.audit.state).toBe("failed");
  });

  test("fails closed when response ids change within one stream", async () => {
    const state = metadata([]);
    const body = [
      { type: "response.created", response: { id: "resp_1" } },
      { type: "response.completed", response: { id: "resp_2", output: [] } },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join("");
    const response = await restorePortableCompatibilityResponse(
      chunkedResponse(body, [body.length]),
      state
    );
    const text = await response.text();

    expect(text).toContain("compatibility_restore_failed");
    expect(state.responseRestore).toBe("failed");
    expect(state.audit.responseId).toBe("resp_1");
  });

  test("cleans request lifecycle metadata when the client cancels", async () => {
    let upstreamCancelled = false;
    const upstream = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({ type: "response.created", response: { id: "resp_1" } })}\n\n`
            )
          );
        },
        cancel() {
          upstreamCancelled = true;
        },
      }),
      { headers: { "content-type": "text/event-stream" } }
    );
    const finalize = vi.fn();
    const state = metadata();
    const response = await restorePortableCompatibilityResponse(upstream, state, {
      onFinalize: finalize,
    });
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel("client_cancelled");

    expect(upstreamCancelled).toBe(true);
    expect(state.responseRestore).toBe("failed");
    expect(state.audit.state).toBe("failed");
    expect(finalize).toHaveBeenCalledOnce();
  });

  test("cleans lifecycle on a missing body before returning a response", async () => {
    const state = metadata();
    const finalize = vi.fn();
    await expect(
      restorePortableCompatibilityResponse(
        new Response(null, { headers: { "content-type": "text/event-stream" } }),
        state,
        { onFinalize: finalize }
      )
    ).rejects.toMatchObject({ compatibilityCode: "malformed_response" });

    expect(state.responseRestore).toBe("failed");
    expect(finalize).toHaveBeenCalledOnce();
  });

  test("turns an upstream stream error into a safe terminal error frame", async () => {
    const privateUpstreamDetail = "private upstream socket detail";
    const state = metadata();
    const finalize = vi.fn();
    const upstream = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(new Error(privateUpstreamDetail));
        },
      }),
      { headers: { "content-type": "text/event-stream" } }
    );
    const response = await restorePortableCompatibilityResponse(upstream, state, {
      onFinalize: finalize,
    });
    const text = await response.text();

    expect(text).toContain("compatibility_restore_failed");
    expect(text).not.toContain(privateUpstreamDetail);
    expect(state.responseRestore).toBe("failed");
    expect(finalize).toHaveBeenCalledOnce();
  });
});
