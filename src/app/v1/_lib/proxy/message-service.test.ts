import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ProxySession } from "./session";

const createMessageRequestMock = vi.hoisted(() => vi.fn());

vi.mock("@/repository/message", () => ({
  createMessageRequest: createMessageRequestMock,
}));

import { ProxyMessageService } from "./message-service";

function createSession(
  providerType: string,
  message: Record<string, unknown>,
  endpoint = "/v1/responses"
) {
  const specialSettings: NonNullable<ReturnType<ProxySession["getSpecialSettings"]>> = [];
  const session = {
    authState: {
      success: true,
      user: { id: 7 },
      key: { id: 8 },
      apiKey: "sk-test",
    },
    provider: { id: 9, providerType, costMultiplier: "1" },
    request: { model: "gpt-5", message },
    sessionId: "session-1",
    userAgent: "codex_cli_rs/1.0.0",
    clientIp: "127.0.0.1",
    getEndpoint: () => endpoint,
    getOriginalModel: () => "gpt-5",
    setOriginalModel: vi.fn(),
    getSpecialSettings: () => (specialSettings.length > 0 ? specialSettings : null),
    addSpecialSetting: (setting: (typeof specialSettings)[number]) => specialSettings.push(setting),
    getRequestSequence: () => 1,
    getGroupCostMultiplier: () => "1",
    getMessagesLength: () => 1,
    setMessageContext: vi.fn(),
  } as unknown as ProxySession;

  return { session, specialSettings };
}

describe("ProxyMessageService 思考强度审计", () => {
  beforeEach(() => {
    createMessageRequestMock.mockReset();
    createMessageRequestMock.mockResolvedValue({ id: 101, createdAt: new Date("2026-07-10") });
  });

  test("Codex 请求保存 reasoning.effort", async () => {
    const { session, specialSettings } = createSession("codex", {
      reasoning: { effort: "high" },
    });

    await ProxyMessageService.ensureContext(session);

    expect(specialSettings).toContainEqual({
      type: "codex_reasoning_effort",
      scope: "request",
      hit: true,
      effort: "high",
    });
  });

  test("OpenAI-compatible chat/completions 保存顶层 reasoning_effort", async () => {
    const { session, specialSettings } = createSession(
      "openai-compatible",
      { messages: [], reasoning_effort: "high" },
      "/v1/chat/completions/"
    );

    await ProxyMessageService.ensureContext(session);

    expect(specialSettings).toContainEqual({
      type: "openai_reasoning_effort",
      scope: "request",
      hit: true,
      effort: "high",
      source: "reasoning_effort",
    });
  });

  test("OpenAI-compatible chat/completions 保存嵌套 reasoning.effort", async () => {
    const { session, specialSettings } = createSession(
      "openai-compatible",
      { messages: [], reasoning: { effort: "low" } },
      "/v1/chat/completions"
    );

    await ProxyMessageService.ensureContext(session);

    expect(specialSettings).toContainEqual(
      expect.objectContaining({ effort: "low", source: "reasoning.effort" })
    );
  });

  test("OpenAI-compatible 非 chat/completions 不保存审计", async () => {
    const { session, specialSettings } = createSession("openai-compatible", {
      reasoning_effort: "high",
    });

    await ProxyMessageService.ensureContext(session);

    expect(specialSettings).toEqual([]);
  });
});
