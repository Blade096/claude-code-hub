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
    provider: { codexMultiAgentV2Mode: mode },
  } as unknown as ProxySession;
}

describe("Codex MultiAgentV2 provider gate", () => {
  beforeEach(() => {
    mocks.getCachedSystemSettings.mockReset();
    mocks.getCachedSystemSettings.mockResolvedValue({
      enableCodexMultiAgentV2Compatibility: false,
    });
  });

  test("runs immediately after final provider selection", () => {
    const providerIndex = CHAT_PIPELINE.steps.indexOf("provider");
    expect(providerIndex).toBeGreaterThan(-1);
    expect(CHAT_PIPELINE.steps[providerIndex + 1]).toBe("codexMultiAgentV2");
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
    const response = await ProxyCodexMultiAgentV2Gate.ensure(createSession("disabled"));

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toMatchObject({
      error: {
        type: "codex_multi_agent_v2_provider_disabled",
        code: "codex_multi_agent_v2_provider_disabled",
      },
    });
    expect(mocks.getCachedSystemSettings).not.toHaveBeenCalled();
  });

  test("rejects portable mode while the global feature is off", async () => {
    const response = await ProxyCodexMultiAgentV2Gate.ensure(createSession("portable"));

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toMatchObject({
      error: {
        type: "codex_multi_agent_v2_compatibility_disabled",
        code: "codex_multi_agent_v2_compatibility_disabled",
      },
    });
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
