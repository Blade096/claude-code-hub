import type { Provider } from "@/types/provider";
import type { CodexMultiAgentV2PortableSpecialSetting } from "@/types/special-settings";
import { isWebsocketClientRequest } from "../../responses-ws/eligibility";
import type { ProxySession } from "../session";
import type { PortableCompatibilityError } from "./errors";
import type {
  PortableTransformation,
  PortableTransformationMetadata,
  PortableTransport,
} from "./types";

function requestId(session: ProxySession): number | null {
  return session.messageContext?.id ?? null;
}

function currentModel(session: ProxySession): string | null {
  return session.getCurrentModel?.() ?? session.request.model ?? null;
}

export function requestedPortableTransport(session: ProxySession): PortableTransport {
  if (isWebsocketClientRequest(session.headers)) return "websocket";
  return session.request.message.stream === true ? "sse" : "http";
}

export function createPortableCompatibilityAudit(options: {
  session: ProxySession;
  provider: Provider;
  transformations: PortableTransformation[];
}): CodexMultiAgentV2PortableSpecialSetting {
  const { session, provider, transformations } = options;
  return {
    type: "codex_multi_agent_v2_portable",
    scope: "request",
    hit: true,
    mode: "portable",
    state: "request_transformed",
    requestedTransport: requestedPortableTransport(session),
    actualTransport: null,
    requestedProviderId: provider.id,
    requestedProviderName: provider.name ?? null,
    actualProviderId: provider.id,
    actualProviderName: provider.name ?? null,
    requestedModel: session.request.model,
    actualModel: currentModel(session),
    transformations: [...transformations],
    responseRestore: "pending",
    errorCategory: null,
    requestId: requestId(session),
    sessionId: session.sessionId,
    responseId: null,
  };
}

export function markPortableResponseStarted(
  metadata: PortableTransformationMetadata,
  response: Response
): void {
  metadata.audit.state = "upstream_sent";
  metadata.audit.actualTransport = response.headers
    .get("x-cch-upstream-transport")
    ?.toLowerCase()
    .includes("websocket")
    ? "websocket"
    : response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")
      ? "sse"
      : "http";
}

export function capturePortableResponseId(
  metadata: PortableTransformationMetadata,
  payload: unknown
): void {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
  const record = payload as Record<string, unknown>;
  const nested =
    record.response && typeof record.response === "object" && !Array.isArray(record.response)
      ? (record.response as Record<string, unknown>)
      : null;
  const candidate =
    typeof nested?.id === "string"
      ? nested.id
      : typeof record.response_id === "string"
        ? record.response_id
        : typeof record.id === "string" && !record.type
          ? record.id
          : null;
  if (candidate) metadata.audit.responseId = candidate;
}

export function markPortableResponseSucceeded(metadata: PortableTransformationMetadata): void {
  metadata.audit.state = "response_restored";
  metadata.audit.errorCategory = null;
}

export function markPortableResponseFailed(
  metadata: PortableTransformationMetadata,
  error: PortableCompatibilityError
): void {
  metadata.audit.state = "failed";
  metadata.audit.responseRestore = "failed";
  metadata.audit.errorCategory = error.category;
}

export function recordPortableFailureAudit(
  session: ProxySession,
  error: PortableCompatibilityError
): CodexMultiAgentV2PortableSpecialSetting {
  const existing = session
    .getSpecialSettings()
    ?.findLast(
      (setting): setting is CodexMultiAgentV2PortableSpecialSetting =>
        setting.type === "codex_multi_agent_v2_portable"
    );
  const provider = session.provider;
  const audit =
    existing ??
    ({
      type: "codex_multi_agent_v2_portable",
      scope: "request",
      hit: true,
      mode: "portable",
      state: "failed",
      requestedTransport: requestedPortableTransport(session),
      actualTransport: null,
      requestedProviderId: error.providerId ?? provider?.id ?? null,
      requestedProviderName:
        error.providerId !== null && error.providerId !== provider?.id
          ? null
          : (provider?.name ?? null),
      actualProviderId: null,
      actualProviderName: null,
      requestedModel: session.request.model,
      actualModel: currentModel(session),
      transformations: [],
      responseRestore: "not_started",
      errorCategory: error.category,
      requestId: requestId(session),
      sessionId: session.sessionId,
      responseId: null,
    } satisfies CodexMultiAgentV2PortableSpecialSetting);

  audit.state = "failed";
  audit.errorCategory = error.category;
  audit.requestId = requestId(session);
  audit.sessionId = session.sessionId;
  if (provider) {
    audit.actualProviderId = provider.id;
    audit.actualProviderName = provider.name ?? null;
    audit.actualModel = currentModel(session);
  }
  if (error.category === "compatibility_transport_unsupported") {
    audit.actualTransport = null;
  }
  if (error.category === "compatibility_restore_failed") {
    audit.responseRestore = "failed";
  }
  if (!existing) session.addSpecialSetting(audit);
  return audit;
}

export function portableAuditCorrelation(
  audit: CodexMultiAgentV2PortableSpecialSetting
): Record<string, string | number | null> {
  return {
    requestId: audit.requestId,
    sessionId: audit.sessionId,
    responseId: audit.responseId,
  };
}
