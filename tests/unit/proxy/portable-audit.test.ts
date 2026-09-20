import {
  createPortableCompatibilityAudit,
  markPortableResponseFailed,
  markPortableResponseStarted,
  markPortableResponseSucceeded,
  markPortableUpstreamResponseFailed,
  recordPortableFailureAudit,
} from "@/app/v1/_lib/proxy/codex-portable-compatibility/audit";
import { PortableCompatibilityError } from "@/app/v1/_lib/proxy/codex-portable-compatibility/errors";
import type { PortableTransformationMetadata } from "@/app/v1/_lib/proxy/codex-portable-compatibility/types";
import type { ProxySession } from "@/app/v1/_lib/proxy/session";
import type { Provider } from "@/types/provider";
import type { SpecialSetting } from "@/types/special-settings";
import { describe, expect, test } from "vitest";

function makeSession(stream = false): ProxySession {
  const settings: SpecialSetting[] = [];
  return {
    headers: new Headers(),
    request: {
      model: "requested-model",
      message: { stream, input: "PORTABLE_TASK_SENTINEL_AUDIT_8A27" },
    },
    provider: { id: 22, name: "actual-provider" },
    messageContext: { id: 101 },
    sessionId: "session-202",
    getRequestedProvider: () => ({ id: 11, name: "requested-provider" }),
    getOriginalModel: () => "requested-model",
    getCurrentModel: () => "actual-model",
    getSpecialSettings: () => settings,
    addSpecialSetting: (setting: SpecialSetting) => settings.push(setting),
  } as unknown as ProxySession;
}

const provider = { id: 22, name: "actual-provider" } as Provider;

function metadata(audit: ReturnType<typeof createPortableCompatibilityAudit>) {
  return {
    version: 1,
    providerId: provider.id,
    requestFingerprint: "fingerprint",
    requestedModel: "requested-model",
    actualModel: "actual-model",
    toolMappings: [],
    transformations: audit.transformations,
    matchedPaths: [],
    responseRestore: "pending",
    audit,
  } satisfies PortableTransformationMetadata;
}

describe("portable compatibility audit", () => {
  test.each([
    [false, "http"],
    [true, "sse"],
  ] as const)("records requested and actual route for %s streaming", (stream, transport) => {
    const session = makeSession(stream);
    const audit = createPortableCompatibilityAudit({
      session,
      provider,
      transformations: ["agent_message_input"],
    });
    const state = metadata(audit);

    markPortableResponseStarted(
      state,
      new Response("", {
        headers: { "content-type": stream ? "text/event-stream" : "application/json" },
      })
    );
    state.responseRestore = "restored";
    audit.responseRestore = "restored";
    markPortableResponseSucceeded(state);

    expect(audit).toMatchObject({
      requestedTransport: transport,
      actualTransport: transport,
      requestedProviderId: 11,
      requestedProviderName: "requested-provider",
      actualProviderId: 22,
      actualProviderName: "actual-provider",
      requestedModel: "requested-model",
      actualModel: "actual-model",
      state: "response_restored",
      requestId: 101,
      sessionId: "session-202",
    });
    expect(JSON.stringify(audit)).not.toContain("PORTABLE_TASK_SENTINEL_AUDIT_8A27");
  });

  test("records WebSocket as the actual transport and a content-free restore failure", () => {
    const audit = createPortableCompatibilityAudit({
      session: makeSession(true),
      provider,
      transformations: ["collaboration_namespace"],
    });
    const state = metadata(audit);
    markPortableResponseStarted(
      state,
      new Response("", { headers: { "x-cch-upstream-transport": "websocket" } })
    );
    markPortableResponseFailed(
      state,
      new PortableCompatibilityError("missing_mapping", { fieldPath: "output[0].name" })
    );

    expect(audit).toMatchObject({
      actualTransport: "websocket",
      state: "failed",
      responseRestore: "failed",
      errorCategory: "compatibility_restore_failed",
    });
  });

  test("records an upstream attempt failure before response restoration starts", () => {
    const audit = createPortableCompatibilityAudit({
      session: makeSession(true),
      provider,
      transformations: ["agent_message_input"],
    });
    const state = metadata(audit);

    markPortableUpstreamResponseFailed(state);

    expect(state.responseRestore).toBe("not_needed");
    expect(audit).toMatchObject({
      actualTransport: "sse",
      state: "failed",
      responseRestore: "not_needed",
      errorCategory: null,
    });
  });

  test("records precondition failure with requested and actual route distinction", () => {
    const session = makeSession(false);
    const audit = recordPortableFailureAudit(
      session,
      new PortableCompatibilityError("provider_disabled", { providerId: 22 })
    );

    expect(audit).toMatchObject({
      state: "failed",
      requestedProviderId: 11,
      actualProviderId: 22,
      requestedModel: "requested-model",
      actualModel: "actual-model",
      responseRestore: "not_started",
      errorCategory: "compatibility_provider_disabled",
      requestId: 101,
      sessionId: "session-202",
    });
    expect(session.getSpecialSettings()).toHaveLength(1);
  });
});
