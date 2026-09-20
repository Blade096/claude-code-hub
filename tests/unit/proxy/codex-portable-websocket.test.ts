import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { WebSocketServer } from "ws";

const mocks = vi.hoisted(() => ({
  getCachedSystemSettings: vi.fn(async () => ({
    enableCodexMultiAgentV2Compatibility: true,
  })),
}));

vi.mock("@/lib/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config")>()),
  getCachedSystemSettings: mocks.getCachedSystemSettings,
}));

import {
  preparePortableCompatibilityRequest,
  restorePortableCompatibilityResponse,
  type PortableCollaborationAction,
  type PortableTransformationMetadata,
} from "@/app/v1/_lib/proxy/codex-portable-compatibility";
import { ProxySession } from "@/app/v1/_lib/proxy/session";
import {
  clearResponsesWsSessionsForTests,
  getResponsesWsSessionCountForTests,
  tryResponsesWebsocketUpstream,
} from "@/app/v1/_lib/responses-ws/upstream-adapter";
import type { Provider } from "@/types/provider";

type ServerHandle = {
  port: number;
  close: () => Promise<void>;
};

type PortableTurn = {
  action: PortableCollaborationAction;
  request: Record<string, unknown>;
  session: ProxySession;
  taskText: string;
};

function startMockServer(
  handler: (socket: import("ws").WebSocket, req: import("http").IncomingMessage) => void
): Promise<ServerHandle> {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ port: 0 });
    wss.on("error", reject);
    wss.on("listening", () => {
      const address = wss.address() as AddressInfo;
      wss.on("connection", handler);
      resolve({
        port: address.port,
        close: () =>
          new Promise<void>((resolveClose) => {
            wss.close(() => resolveClose());
          }),
      });
    });
  });
}

function portableProvider(): Provider {
  return {
    id: 42,
    name: "portable-ws-upstream",
    providerType: "codex",
    codexMultiAgentV2Mode: "portable",
    url: "http://mock/v1",
    key: "sk-mock",
    enabled: true,
    priority: 1,
    weight: 1,
    costMultiplier: 1,
    groupTag: null,
    providerVendorId: null,
  } as unknown as Provider;
}

function collaborationNamespace(action: PortableCollaborationAction) {
  return {
    type: "namespace",
    name: "collaboration",
    tools: [
      {
        type: "function",
        name: action,
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

function makeTurn(action: PortableCollaborationAction, taskText: string): PortableTurn {
  const request = {
    model: "third-party-model",
    stream: true,
    store: false,
    tools: [collaborationNamespace(action)],
    input: [
      {
        type: "agent_message",
        content: [
          { type: "input_text", text: "Payload:\n" },
          { type: "encrypted_content", encrypted_content: taskText },
        ],
      },
    ],
  };
  const session = Object.create(ProxySession.prototype) as ProxySession;
  Object.assign(session, {
    requestUrl: new URL("https://proxy.example.com/v1/responses"),
    request: { message: request, model: "third-party-model", log: "{}" },
    headers: new Headers({
      "content-type": "application/json",
      "user-agent": "Codex Desktop/1.2.3",
    }),
    userAgent: "Codex Desktop/1.2.3",
    originalFormat: "response",
    portableTransformationMetadata: null,
  });
  return { action, request, session, taskText };
}

async function prepareTurn(turn: PortableTurn): Promise<{
  body: Record<string, unknown>;
  metadata: PortableTransformationMetadata;
}> {
  const prepared = await preparePortableCompatibilityRequest({
    session: turn.session,
    provider: portableProvider(),
    request: turn.request,
  });
  expect(prepared.metadata).toBeTruthy();
  return {
    body: prepared.request,
    metadata: prepared.metadata!,
  };
}

async function restoreTurnResponse(
  turn: PortableTurn,
  response: Response,
  metadata: PortableTransformationMetadata
): Promise<string> {
  const restored = await restorePortableCompatibilityResponse(response, metadata, {
    onFinalize: () => turn.session.clearPortableTransformationMetadata(),
  });
  return await restored.text();
}

function sendFunctionCallEvents(
  socket: import("ws").WebSocket,
  action: PortableCollaborationAction,
  responseId: string
): void {
  const item = {
    id: `${responseId}_item`,
    type: "function_call",
    call_id: `${responseId}_call`,
    namespace: "collaboration-optimize",
    name: action,
    arguments: "",
  };
  socket.send(
    JSON.stringify({
      type: "response.output_item.added",
      output_index: 0,
      item,
    })
  );
  socket.send(
    JSON.stringify({
      type: "response.function_call_arguments.delta",
      item_id: item.id,
      output_index: 0,
      delta: '{"message":"child task"}',
    })
  );
  socket.send(
    JSON.stringify({
      type: "response.output_item.done",
      output_index: 0,
      item: { ...item, arguments: '{"message":"child task"}' },
    })
  );
  socket.send(
    JSON.stringify({
      type: "response.completed",
      response: {
        id: responseId,
        output: [{ ...item, arguments: '{"message":"child task"}' }],
      },
    })
  );
}

function parseSsePayloads(body: string): Array<Record<string, unknown>> {
  return body
    .trim()
    .split(/\r?\n\r?\n/u)
    .map((frame) =>
      frame
        .split(/\r?\n/u)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /u, ""))
        .join("\n")
    )
    .filter((data) => data.length > 0 && data !== "[DONE]")
    .map((data) => JSON.parse(data) as Record<string, unknown>);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function actionFromRequestFrame(frame: Record<string, unknown>): PortableCollaborationAction {
  const tools = frame.tools as Array<{ tools?: Array<{ name?: string }> }>;
  const action = tools?.[0]?.tools?.[0]?.name;
  if (action !== "spawn_agent" && action !== "send_message" && action !== "followup_task") {
    throw new Error(`Unexpected portable collaboration action: ${String(action)}`);
  }
  return action;
}

async function openTurn(options: {
  turn: PortableTurn;
  port: number;
  sessionId: string;
  abortSignal?: AbortSignal;
}): Promise<{
  response: Response;
  metadata: PortableTransformationMetadata;
  reused: boolean;
}> {
  const { body, metadata } = await prepareTurn(options.turn);
  const result = await tryResponsesWebsocketUpstream({
    provider: portableProvider(),
    upstreamUrl: `http://127.0.0.1:${options.port}/v1/responses`,
    upstreamHeaders: new Headers({ authorization: "Bearer sk-mock" }),
    body,
    sessionId: options.sessionId,
    abortSignal: options.abortSignal,
  });
  expect("response" in result).toBe(true);
  if (!("response" in result)) {
    throw new Error(`WebSocket attempt failed: ${result.reason}`);
  }
  return { response: result.response, metadata, reused: result.reused };
}

describe("portable compatibility over Responses WebSocket", () => {
  let server: ServerHandle | null = null;

  beforeEach(() => {
    mocks.getCachedSystemSettings.mockResolvedValue({
      enableCodexMultiAgentV2Compatibility: true,
    });
  });

  afterEach(async () => {
    clearResponsesWsSessionsForTests();
    if (server) {
      await server.close();
      server = null;
    }
  });

  test("sends the request codec output in the WS frame and restores every function-call event", async () => {
    let upstreamFrame: Record<string, unknown> | null = null;
    server = await startMockServer((socket) => {
      socket.on("message", (data) => {
        upstreamFrame = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
        sendFunctionCallEvents(socket, actionFromRequestFrame(upstreamFrame), "resp_single");
      });
    });

    const turn = makeTurn("spawn_agent", "Run the WebSocket seam task.");
    const opened = await openTurn({
      turn,
      port: server.port,
      sessionId: "portable-single-turn",
    });
    expect(turn.session.getPortableTransformationMetadata()).toBe(opened.metadata);

    const body = await restoreTurnResponse(turn, opened.response, opened.metadata);
    const events = parseSsePayloads(body);

    expect(upstreamFrame).toMatchObject({
      type: "response.create",
      store: false,
      tools: [
        {
          name: "collaboration-optimize",
          tools: [{ name: "spawn_agent", parameters: { properties: { message: {} } } }],
        },
      ],
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "Payload:\n" },
            { type: "input_text", text: "Run the WebSocket seam task." },
          ],
        },
      ],
    });
    expect(upstreamFrame).not.toHaveProperty("stream");
    expect(JSON.stringify(upstreamFrame)).not.toContain('"encrypted":true');

    expect(events).toHaveLength(4);
    expect(events[0]).toMatchObject({
      type: "response.output_item.added",
      item: { namespace: "collaboration", name: "spawn_agent" },
    });
    expect(events[1]).toMatchObject({
      type: "response.function_call_arguments.delta",
      delta: '{"message":"child task"}',
    });
    expect(events[2]).toMatchObject({
      type: "response.output_item.done",
      item: { namespace: "collaboration", name: "spawn_agent" },
    });
    expect(events[3]).toMatchObject({
      type: "response.completed",
      response: {
        output: [{ namespace: "collaboration", name: "spawn_agent" }],
      },
    });
    expect(opened.metadata.responseRestore).toBe("restored");
    expect(turn.session.getPortableTransformationMetadata()).toBeNull();
  });

  test("reuses one socket across turns without reusing the previous turn mapping", async () => {
    const receivedFrames: Array<Record<string, unknown>> = [];
    let connectionCount = 0;
    server = await startMockServer((socket) => {
      connectionCount += 1;
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
        receivedFrames.push(frame);
        sendFunctionCallEvents(
          socket,
          actionFromRequestFrame(frame),
          `resp_turn_${receivedFrames.length}`
        );
      });
    });

    const firstTurn = makeTurn("spawn_agent", "First turn task.");
    const first = await openTurn({
      turn: firstTurn,
      port: server.port,
      sessionId: "portable-continuous-turns",
    });
    const firstBody = await restoreTurnResponse(firstTurn, first.response, first.metadata);
    expect(first.reused).toBe(false);
    expect(firstTurn.session.getPortableTransformationMetadata()).toBeNull();

    const secondTurn = makeTurn("send_message", "Second turn task.");
    const second = await openTurn({
      turn: secondTurn,
      port: server.port,
      sessionId: "portable-continuous-turns",
    });
    const secondBody = await restoreTurnResponse(secondTurn, second.response, second.metadata);

    expect(second.reused).toBe(true);
    expect(connectionCount).toBe(1);
    expect(actionFromRequestFrame(receivedFrames[0]!)).toBe("spawn_agent");
    expect(actionFromRequestFrame(receivedFrames[1]!)).toBe("send_message");
    expect(firstBody).toContain('"namespace":"collaboration","name":"spawn_agent"');
    expect(firstBody).not.toContain('"name":"send_message"');
    expect(secondBody).toContain('"namespace":"collaboration","name":"send_message"');
    expect(secondBody).not.toContain('"name":"spawn_agent"');
    expect(secondTurn.session.getPortableTransformationMetadata()).toBeNull();

    const state = globalThis as unknown as {
      __cchResponsesWsPersistentState?: { sessions: Map<string, Record<string, unknown>> };
    };
    const retained = [...(state.__cchResponsesWsPersistentState?.sessions.values() ?? [])];
    expect(retained).toHaveLength(1);
    expect(Object.keys(retained[0]!).sort()).toEqual([
      "active",
      "createdAt",
      "fingerprint",
      "idleTimer",
      "lastUsedAt",
      "sessionId",
      "ws",
    ]);
    expect(JSON.stringify(retained.map((entry) => Object.keys(entry)))).not.toContain(
      "toolMappings"
    );
    expect(JSON.stringify(receivedFrames)).not.toContain('"encrypted_content"');
  });

  test("isolates interleaved turns that share the lower-layer WS session id", async () => {
    let connectionCount = 0;
    let releaseFirstTerminal!: () => void;
    const firstTerminalReleased = new Promise<void>((resolve) => {
      releaseFirstTerminal = resolve;
    });
    server = await startMockServer((socket) => {
      connectionCount += 1;
      const connectionIndex = connectionCount;
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
        const action = actionFromRequestFrame(frame);
        if (connectionIndex !== 1) {
          sendFunctionCallEvents(socket, action, "resp_concurrent_second");
          return;
        }

        const item = {
          id: "resp_concurrent_first_item",
          type: "function_call",
          call_id: "resp_concurrent_first_call",
          namespace: "collaboration-optimize",
          name: action,
          arguments: "",
        };
        socket.send(
          JSON.stringify({
            type: "response.output_item.added",
            output_index: 0,
            item,
          })
        );
        firstTerminalReleased.then(() => {
          if (socket.readyState !== 1) return;
          socket.send(
            JSON.stringify({
              type: "response.function_call_arguments.delta",
              item_id: item.id,
              output_index: 0,
              delta: '{"message":"first child task"}',
            })
          );
          socket.send(
            JSON.stringify({
              type: "response.output_item.done",
              output_index: 0,
              item: { ...item, arguments: '{"message":"first child task"}' },
            })
          );
          socket.send(
            JSON.stringify({
              type: "response.completed",
              response: {
                id: "resp_concurrent_first",
                output: [{ ...item, arguments: '{"message":"first child task"}' }],
              },
            })
          );
        });
      });
    });

    const firstTurn = makeTurn("spawn_agent", "Concurrent first task.");
    const first = await openTurn({
      turn: firstTurn,
      port: server.port,
      sessionId: "portable-concurrent-turns",
    });
    const firstBodyPromise = restoreTurnResponse(firstTurn, first.response, first.metadata);

    const secondTurn = makeTurn("followup_task", "Concurrent second task.");
    const second = await openTurn({
      turn: secondTurn,
      port: server.port,
      sessionId: "portable-concurrent-turns",
    });
    const secondBody = await restoreTurnResponse(secondTurn, second.response, second.metadata);

    expect(connectionCount).toBe(2);
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(false);
    expect(secondBody).toContain('"namespace":"collaboration","name":"followup_task"');
    expect(secondBody).not.toContain('"name":"spawn_agent"');
    expect(secondTurn.session.getPortableTransformationMetadata()).toBeNull();
    expect(firstTurn.session.getPortableTransformationMetadata()).toBe(first.metadata);
    expect(getResponsesWsSessionCountForTests()).toBe(1);

    releaseFirstTerminal();
    const firstBody = await firstBodyPromise;
    expect(firstBody).toContain('"namespace":"collaboration","name":"spawn_agent"');
    expect(firstBody).not.toContain('"name":"followup_task"');
    expect(firstTurn.session.getPortableTransformationMetadata()).toBeNull();
  });

  test("client cancellation clears only that turn metadata and the next turn remains usable", async () => {
    let connectionCount = 0;
    let resolveFirstClosed!: () => void;
    const firstClosed = new Promise<void>((resolve) => {
      resolveFirstClosed = resolve;
    });
    server = await startMockServer((socket) => {
      connectionCount += 1;
      const connectionIndex = connectionCount;
      socket.on("close", () => {
        if (connectionIndex === 1) resolveFirstClosed();
      });
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
        const action = actionFromRequestFrame(frame);
        if (connectionIndex === 1) {
          socket.send(
            JSON.stringify({
              type: "response.output_item.added",
              output_index: 0,
              item: {
                id: "resp_cancelled_item",
                type: "function_call",
                call_id: "resp_cancelled_call",
                namespace: "collaboration-optimize",
                name: action,
                arguments: "",
              },
            })
          );
          return;
        }
        sendFunctionCallEvents(socket, action, "resp_after_cancel");
      });
    });

    const cancelledTurn = makeTurn("spawn_agent", "Cancel this task after its first event.");
    const cancelled = await openTurn({
      turn: cancelledTurn,
      port: server.port,
      sessionId: "portable-cancel-then-continue",
    });
    const restored = await restorePortableCompatibilityResponse(
      cancelled.response,
      cancelled.metadata,
      { onFinalize: () => cancelledTurn.session.clearPortableTransformationMetadata() }
    );
    const reader = restored.body!.getReader();
    const firstRead = await reader.read();
    expect(new TextDecoder().decode(firstRead.value)).toContain(
      '"namespace":"collaboration","name":"spawn_agent"'
    );
    await reader.cancel("client_cancelled_turn");
    await withTimeout(firstClosed, 1_000, "cancelled portable upstream socket stayed open");

    expect(cancelledTurn.session.getPortableTransformationMetadata()).toBeNull();
    expect(cancelled.metadata.responseRestore).toBe("restored");
    expect(getResponsesWsSessionCountForTests()).toBe(0);

    const nextTurn = makeTurn("send_message", "Continue after the cancelled turn.");
    const next = await openTurn({
      turn: nextTurn,
      port: server.port,
      sessionId: "portable-cancel-then-continue",
    });
    const nextBody = await restoreTurnResponse(nextTurn, next.response, next.metadata);

    expect(next.reused).toBe(false);
    expect(connectionCount).toBe(2);
    expect(nextBody).toContain('"namespace":"collaboration","name":"send_message"');
    expect(nextBody).not.toContain('"name":"spawn_agent"');
    expect(nextTurn.session.getPortableTransformationMetadata()).toBeNull();
  });

  test("a response restore error closes that logical turn and does not poison the next turn", async () => {
    let connectionCount = 0;
    server = await startMockServer((socket) => {
      connectionCount += 1;
      const connectionIndex = connectionCount;
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
        const requestedAction = actionFromRequestFrame(frame);
        if (connectionIndex === 1) {
          socket.send(
            JSON.stringify({
              type: "response.output_item.added",
              output_index: 0,
              item: {
                id: "resp_invalid_item",
                type: "function_call",
                call_id: "resp_invalid_call",
                namespace: "collaboration-optimize",
                name: "send_message",
                arguments: "",
              },
            })
          );
          return;
        }
        sendFunctionCallEvents(socket, requestedAction, "resp_after_restore_error");
      });
    });

    const failedTurn = makeTurn("spawn_agent", "Trigger an isolated response mapping error.");
    const failed = await openTurn({
      turn: failedTurn,
      port: server.port,
      sessionId: "portable-error-then-continue",
    });
    const failedBody = await restoreTurnResponse(failedTurn, failed.response, failed.metadata);

    expect(failedBody).toContain('"type":"error"');
    expect(failedBody).toContain("compatibility_restore_failed");
    expect(failedBody).not.toContain("Trigger an isolated response mapping error.");
    expect(failed.metadata.responseRestore).toBe("failed");
    expect(failed.metadata.audit.errorCategory).toBe("compatibility_restore_failed");
    expect(failedTurn.session.getPortableTransformationMetadata()).toBeNull();
    expect(getResponsesWsSessionCountForTests()).toBe(0);

    const nextTurn = makeTurn("followup_task", "Continue after the isolated error.");
    const next = await openTurn({
      turn: nextTurn,
      port: server.port,
      sessionId: "portable-error-then-continue",
    });
    const nextBody = await restoreTurnResponse(nextTurn, next.response, next.metadata);

    expect(next.reused).toBe(false);
    expect(connectionCount).toBe(2);
    expect(nextBody).toContain('"namespace":"collaboration","name":"followup_task"');
    expect(nextBody).not.toContain('"name":"spawn_agent"');
    expect(next.metadata.responseRestore).toBe("restored");
    expect(nextTurn.session.getPortableTransformationMetadata()).toBeNull();
  });

  test("a response deadline abort clears turn state and permits a clean following turn", async () => {
    let connectionCount = 0;
    server = await startMockServer((socket) => {
      connectionCount += 1;
      const connectionIndex = connectionCount;
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
        const action = actionFromRequestFrame(frame);
        if (connectionIndex === 1) {
          socket.send(
            JSON.stringify({
              type: "response.output_item.added",
              output_index: 0,
              item: {
                id: "resp_timed_out_item",
                type: "function_call",
                call_id: "resp_timed_out_call",
                namespace: "collaboration-optimize",
                name: action,
                arguments: "",
              },
            })
          );
          return;
        }
        sendFunctionCallEvents(socket, action, "resp_after_timeout");
      });
    });

    const deadline = new AbortController();
    const timedOutTurn = makeTurn("spawn_agent", "Allow this response deadline to expire.");
    const timedOut = await openTurn({
      turn: timedOutTurn,
      port: server.port,
      sessionId: "portable-timeout-then-continue",
      abortSignal: deadline.signal,
    });
    const timedOutBodyPromise = restoreTurnResponse(
      timedOutTurn,
      timedOut.response,
      timedOut.metadata
    );
    deadline.abort(new DOMException("response deadline exceeded", "TimeoutError"));
    const timedOutBody = await withTimeout(
      timedOutBodyPromise,
      1_000,
      "portable response did not settle after its deadline aborted"
    );

    expect(timedOutBody).toContain('"namespace":"collaboration","name":"spawn_agent"');
    expect(timedOutBody).toContain('"type":"error"');
    expect(timedOutBody).toContain("upstream_ws_mid_stream_error");
    expect(timedOutBody).not.toContain("Allow this response deadline to expire.");
    expect(timedOutTurn.session.getPortableTransformationMetadata()).toBeNull();
    expect(getResponsesWsSessionCountForTests()).toBe(0);

    const nextTurn = makeTurn("send_message", "Continue after the response deadline.");
    const next = await openTurn({
      turn: nextTurn,
      port: server.port,
      sessionId: "portable-timeout-then-continue",
    });
    const nextBody = await restoreTurnResponse(nextTurn, next.response, next.metadata);

    expect(next.reused).toBe(false);
    expect(connectionCount).toBe(2);
    expect(nextBody).toContain('"namespace":"collaboration","name":"send_message"');
    expect(nextBody).not.toContain('"name":"spawn_agent"');
    expect(nextTurn.session.getPortableTransformationMetadata()).toBeNull();
  });

  test("an upstream mid-stream close clears turn state without affecting the next turn", async () => {
    let connectionCount = 0;
    server = await startMockServer((socket) => {
      connectionCount += 1;
      const connectionIndex = connectionCount;
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
        const action = actionFromRequestFrame(frame);
        if (connectionIndex === 1) {
          socket.send(
            JSON.stringify({
              type: "response.output_item.added",
              output_index: 0,
              item: {
                id: "resp_closed_item",
                type: "function_call",
                call_id: "resp_closed_call",
                namespace: "collaboration-optimize",
                name: action,
                arguments: "",
              },
            })
          );
          setTimeout(() => socket.close(1011, "upstream interrupted"), 5);
          return;
        }
        sendFunctionCallEvents(socket, action, "resp_after_upstream_close");
      });
    });

    const closedTurn = makeTurn("spawn_agent", "Observe an upstream mid-stream close.");
    const closed = await openTurn({
      turn: closedTurn,
      port: server.port,
      sessionId: "portable-close-then-continue",
    });
    const closedBody = await restoreTurnResponse(closedTurn, closed.response, closed.metadata);

    expect(closedBody).toContain('"namespace":"collaboration","name":"spawn_agent"');
    expect(closedBody).toContain('"type":"error"');
    expect(closedBody).toContain("upstream_ws_closed_mid_stream");
    expect(closedBody).not.toContain("Observe an upstream mid-stream close.");
    expect(closedTurn.session.getPortableTransformationMetadata()).toBeNull();
    expect(getResponsesWsSessionCountForTests()).toBe(0);

    const nextTurn = makeTurn("followup_task", "Continue after the upstream close.");
    const next = await openTurn({
      turn: nextTurn,
      port: server.port,
      sessionId: "portable-close-then-continue",
    });
    const nextBody = await restoreTurnResponse(nextTurn, next.response, next.metadata);

    expect(next.reused).toBe(false);
    expect(connectionCount).toBe(2);
    expect(nextBody).toContain('"namespace":"collaboration","name":"followup_task"');
    expect(nextBody).not.toContain('"name":"spawn_agent"');
    expect(nextTurn.session.getPortableTransformationMetadata()).toBeNull();
  });
});
