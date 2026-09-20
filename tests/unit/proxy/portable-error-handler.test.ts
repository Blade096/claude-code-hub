import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  updateDetails: vi.fn(),
  updateDuration: vi.fn(),
  storeSpecialSettings: vi.fn(),
  endRequest: vi.fn(),
  emitTrace: vi.fn(),
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("@/repository/message", () => ({
  updateMessageRequestDetails: mocks.updateDetails,
  updateMessageRequestDuration: mocks.updateDuration,
}));

vi.mock("@/lib/session-manager", () => ({
  SessionManager: { storeSessionSpecialSettings: mocks.storeSpecialSettings },
}));

vi.mock("@/lib/proxy-status-tracker", () => ({
  ProxyStatusTracker: { getInstance: () => ({ endRequest: mocks.endRequest }) },
}));

vi.mock("@/lib/langfuse/emit-proxy-trace", () => ({
  emitProxyLangfuseTrace: mocks.emitTrace,
}));

vi.mock("@/lib/logger", () => ({ logger: mocks.logger }));

import { PortableCompatibilityError } from "@/app/v1/_lib/proxy/codex-portable-compatibility/errors";
import { ProxyErrorHandler } from "@/app/v1/_lib/proxy/error-handler";
import type { ProxySession } from "@/app/v1/_lib/proxy/session";
import type { SpecialSetting } from "@/types/special-settings";

function makeSession(sentinel: string): ProxySession {
  const specialSettings: SpecialSetting[] = [];
  return {
    headers: new Headers({ "accept-language": "ja" }),
    requestUrl: new URL("https://proxy.example.com/v1/responses"),
    request: {
      model: "requested-model",
      message: {
        stream: false,
        input: [{ type: "agent_message", content: [{ type: "input_text", text: sentinel }] }],
      },
    },
    provider: { id: 22, name: "actual-provider", swapCacheTtlBilling: false },
    messageContext: { id: 101, user: { id: 7 } },
    sessionId: "session-202",
    requestSequence: 3,
    startTime: Date.now(),
    getRequestedProvider: () => ({ id: 11, name: "requested-provider" }),
    getOriginalModel: () => "requested-model",
    getCurrentModel: () => "actual-model",
    getProviderChain: () => [],
    getContext1mApplied: () => false,
    getSpecialSettings: () => specialSettings,
    addSpecialSetting: (setting: SpecialSetting) => specialSettings.push(setting),
    shouldPersistSessionDebugArtifacts: () => true,
  } as unknown as ProxySession;
}

describe("portable compatibility error persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateDetails.mockResolvedValue(undefined);
    mocks.updateDuration.mockResolvedValue(undefined);
    mocks.storeSpecialSettings.mockResolvedValue(undefined);
  });

  test("localizes and persists a content-free precondition failure audit", async () => {
    const sentinel = "PORTABLE_TASK_SENTINEL_HANDLER_91C7";
    const session = makeSession(sentinel);

    const response = await ProxyErrorHandler.handle(
      session,
      new PortableCompatibilityError("provider_disabled", { providerId: 22 })
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      error: {
        type: "compatibility_provider_disabled",
        code: "compatibility_provider_disabled",
        details: {
          requestId: 101,
          sessionId: "session-202",
          responseId: null,
        },
      },
    });
    expect(body.error.message).toBe(
      "選択した Provider では Codex MultiAgentV2 リクエストが無効です。 " +
        "(cch_session_id: session-202)"
    );

    const persisted = mocks.updateDetails.mock.calls[0][1];
    expect(persisted.specialSettings).toContainEqual(
      expect.objectContaining({
        type: "codex_multi_agent_v2_portable",
        state: "failed",
        requestedProviderId: 11,
        actualProviderId: 22,
        requestedModel: "requested-model",
        actualModel: "actual-model",
        errorCategory: "compatibility_provider_disabled",
      })
    );
    expect(mocks.storeSpecialSettings).toHaveBeenCalledOnce();

    const observable = JSON.stringify({ body, persisted, logs: mocks.logger.error.mock.calls });
    expect(observable).not.toContain(sentinel);
  });
});
