import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  hasCodexMultiAgentV2ToolSchema,
  isCodexMultiAgentV2Request,
  ProxyCodexMultiAgentV2Gate,
} from "@/app/v1/_lib/proxy/codex-multi-agent-v2-gate";
import { CHAT_PIPELINE } from "@/app/v1/_lib/proxy/guard-pipeline";
import type { ProxySession } from "@/app/v1/_lib/proxy/session";
import type { CodexMultiAgentV2Mode } from "@/types/provider";

const mocks = vi.hoisted(() => ({
  getCachedSystemSettings: vi.fn(),
}));

vi.mock("@/lib/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config")>()),
  getCachedSystemSettings: mocks.getCachedSystemSettings,
}));

function collaborationNamespace(name = "spawn_agent") {
  return {
    type: "namespace",
    name: "collaboration",
    tools: [
      {
        type: "function",
        name,
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

function createSession(
  mode: CodexMultiAgentV2Mode,
  message: Record<string, unknown> = { tools: [collaborationNamespace()] }
): ProxySession {
  return {
    originalFormat: "response",
    requestUrl: new URL("https://example.test/v1/responses"),
    headers: new Headers(),
    userAgent: "Codex Desktop/1.2.3",
    request: { message },
    provider: { id: 42, name: "fixture-provider", codexMultiAgentV2Mode: mode },
  } as unknown as ProxySession;
}

describe("Codex MultiAgentV2 provider gate", () => {
  beforeEach(() => {
    mocks.getCachedSystemSettings.mockReset();
    mocks.getCachedSystemSettings.mockResolvedValue({
      enableCodexMultiAgentV2Compatibility: false,
    });
  });

  test("runs after final provider selection and message-context creation", () => {
    const providerIndex = CHAT_PIPELINE.steps.indexOf("provider");
    const messageContextIndex = CHAT_PIPELINE.steps.indexOf("messageContext");
    const compatibilityIndex = CHAT_PIPELINE.steps.indexOf("codexMultiAgentV2");
    expect(providerIndex).toBeGreaterThan(-1);
    expect(messageContextIndex).toBeGreaterThan(providerIndex);
    expect(compatibilityIndex).toBeGreaterThan(messageContextIndex);
  });

  test("recognizes top-level and additional_tools collaboration schemas", () => {
    expect(hasCodexMultiAgentV2ToolSchema({ tools: [collaborationNamespace()] })).toBe(true);
    expect(
      hasCodexMultiAgentV2ToolSchema({
        input: [{ type: "additional_tools", tools: [collaborationNamespace("send_message")] }],
      })
    ).toBe(true);
    expect(
      hasCodexMultiAgentV2ToolSchema({
        input: [{ type: "additional_tools", tools: [collaborationNamespace("followup_task")] }],
      })
    ).toBe(true);
  });

  test("does not accept same-name business tools or malformed namespaces", () => {
    const standalone = collaborationNamespace().tools[0];
    expect(hasCodexMultiAgentV2ToolSchema({ tools: [standalone] })).toBe(false);
    expect(
      hasCodexMultiAgentV2ToolSchema({
        tools: [
          {
            ...collaborationNamespace(),
            tools: [
              {
                ...standalone,
                parameters: {
                  type: "object",
                  properties: { message: { type: "string" } },
                },
              },
            ],
          },
        ],
      })
    ).toBe(false);
  });

  test("requires Responses endpoint, response format, and official Codex client", () => {
    const wrongRoute = createSession("disabled");
    wrongRoute.requestUrl = new URL("https://example.test/v1/chat/completions");
    expect(isCodexMultiAgentV2Request(wrongRoute)).toBe(false);

    const wrongFormat = createSession("disabled");
    wrongFormat.originalFormat = "openai";
    expect(isCodexMultiAgentV2Request(wrongFormat)).toBe(false);

    const wrongClient = createSession("disabled");
    Object.defineProperty(wrongClient, "userAgent", { value: "business-client/1.0" });
    expect(isCodexMultiAgentV2Request(wrongClient)).toBe(false);
  });

  test("keeps native mode byte-for-byte unchanged", async () => {
    const session = createSession("native");
    const before = JSON.stringify(session.request.message);

    expect(await ProxyCodexMultiAgentV2Gate.ensure(session)).toBeNull();
    expect(JSON.stringify(session.request.message)).toBe(before);
    expect(mocks.getCachedSystemSettings).not.toHaveBeenCalled();
  });

  test("rejects confirmed V2 requests when the provider disables them", async () => {
    await expect(ProxyCodexMultiAgentV2Gate.ensure(createSession("disabled"))).rejects.toMatchObject(
      {
        compatibilityCode: "provider_disabled",
        category: "compatibility_provider_disabled",
        providerId: 42,
      }
    );
    expect(mocks.getCachedSystemSettings).not.toHaveBeenCalled();
  });

  test("rejects portable mode while the global feature is off", async () => {
    await expect(ProxyCodexMultiAgentV2Gate.ensure(createSession("portable"))).rejects.toMatchObject(
      {
        compatibilityCode: "feature_disabled",
        category: "compatibility_feature_disabled",
        providerId: 42,
      }
    );
  });

  test("gate failures never include delegated content", async () => {
    const sentinel = "PORTABLE_TASK_SENTINEL_GATE_74A2";
    const session = createSession("disabled", {
      tools: [collaborationNamespace()],
      input: [{ type: "agent_message", content: [{ type: "input_text", text: sentinel }] }],
    });

    const failure = await ProxyCodexMultiAgentV2Gate.ensure(session).catch((error) => error);
    expect(JSON.stringify(failure)).not.toContain(sentinel);
    expect(failure.message).not.toContain(sentinel);
  });

  test("allows portable mode when the global feature is on without transforming payload", async () => {
    mocks.getCachedSystemSettings.mockResolvedValue({
      enableCodexMultiAgentV2Compatibility: true,
    });
    const session = createSession("portable", {
      input: [{ type: "additional_tools", tools: [collaborationNamespace()] }],
    });
    const before = JSON.stringify(session.request.message);

    expect(await ProxyCodexMultiAgentV2Gate.ensure(session)).toBeNull();
    expect(JSON.stringify(session.request.message)).toBe(before);
  });

  test("does not gate unrelated Responses traffic", async () => {
    const session = createSession("disabled", {
      tools: [
        {
          type: "function",
          name: "spawn_agent",
          parameters: { type: "object", properties: { message: { type: "string" } } },
        },
      ],
    });

    expect(await ProxyCodexMultiAgentV2Gate.ensure(session)).toBeNull();
    expect(mocks.getCachedSystemSettings).not.toHaveBeenCalled();
  });
});
