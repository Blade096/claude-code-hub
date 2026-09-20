import { getCachedSystemSettings } from "@/lib/config";
import type { CodexMultiAgentV2Mode } from "@/types/provider";
import { detectClientFull } from "./client-detector";
import { PortableCompatibilityError } from "./codex-portable-compatibility/errors";
import { isRecord } from "./codex-portable-compatibility/guards";
import {
  CODEX_COLLABORATION_NAMESPACE,
  PORTABLE_COLLABORATION_ACTIONS,
} from "./codex-portable-compatibility/types";
import type { ProxySession } from "./session";

const CODEX_MULTI_AGENT_V2_TOOL_NAMES = new Set<string>(PORTABLE_COLLABORATION_ACTIONS);

type CollaborationSchemaClassification = "absent" | "valid" | "malformed";

function hasEncryptedMessageParameter(tool: unknown): boolean {
  if (!isRecord(tool) || tool.type !== "function") return false;
  if (typeof tool.name !== "string" || !CODEX_MULTI_AGENT_V2_TOOL_NAMES.has(tool.name)) {
    return false;
  }

  const parameters = tool.parameters;
  if (!isRecord(parameters) || parameters.type !== "object") return false;

  const properties = parameters.properties;
  if (!isRecord(properties)) return false;

  const message = properties.message;
  return isRecord(message) && message.type === "string" && message.encrypted === true;
}

function classifyCollaborationNamespace(tools: unknown): CollaborationSchemaClassification {
  if (!Array.isArray(tools)) return "absent";

  let foundCollaborationNamespace = false;
  for (const tool of tools) {
    if (!isRecord(tool)) continue;
    if (tool.type !== "namespace" || tool.name !== CODEX_COLLABORATION_NAMESPACE) continue;
    foundCollaborationNamespace = true;
    if (Array.isArray(tool.tools) && tool.tools.some(hasEncryptedMessageParameter)) {
      return "valid";
    }
  }
  return foundCollaborationNamespace ? "malformed" : "absent";
}

function classifyCodexMultiAgentV2ToolSchema(
  message: Record<string, unknown>
): CollaborationSchemaClassification {
  const topLevel = classifyCollaborationNamespace(message.tools);
  if (topLevel === "valid") return "valid";

  let malformed = topLevel === "malformed";
  if (Array.isArray(message.input)) {
    for (const item of message.input) {
      if (!isRecord(item) || item.type !== "additional_tools") continue;
      const nested = classifyCollaborationNamespace(item.tools);
      if (nested === "valid") return "valid";
      malformed ||= nested === "malformed";
    }
  }
  return malformed ? "malformed" : "absent";
}

/**
 * Codex may place additional tools directly in `tools`, or inside an
 * `additional_tools` input item. Only the official encrypted collaboration
 * namespace is considered MultiAgentV2 traffic.
 */
export function hasCodexMultiAgentV2ToolSchema(message: Record<string, unknown>): boolean {
  return classifyCodexMultiAgentV2ToolSchema(message) === "valid";
}

function isOfficialCodexResponsesRequest(session: ProxySession): boolean {
  if (session.originalFormat !== "response") return false;
  if (session.requestUrl.pathname.replace(/\/+$/, "") !== "/v1/responses") return false;
  return detectClientFull(session, "codex-cli").matched;
}

export function isCodexMultiAgentV2Request(session: ProxySession): boolean {
  return (
    isOfficialCodexResponsesRequest(session) &&
    classifyCodexMultiAgentV2ToolSchema(session.request.message) === "valid"
  );
}

function resolveMode(session: ProxySession): CodexMultiAgentV2Mode {
  return session.provider?.codexMultiAgentV2Mode ?? "native";
}

/**
 * Read-only portable preflight shared by transport-adjacent paths that must
 * decide before mutating the request. Internal compaction summary calls are
 * deliberately excluded even though they retain the outer request's tools.
 */
export function isPortableCodexMultiAgentV2Request(
  session: ProxySession,
  compatibilityEnabled: boolean
): boolean {
  if (!compatibilityEnabled) return false;
  if (session.isInternalCompactionRequest?.() === true) return false;
  return resolveMode(session) === "portable" && isCodexMultiAgentV2Request(session);
}

export class ProxyCodexMultiAgentV2Gate {
  static async ensure(session: ProxySession): Promise<Response | null> {
    if (!isOfficialCodexResponsesRequest(session)) return null;

    const schema = classifyCodexMultiAgentV2ToolSchema(session.request.message);
    if (schema === "absent") return null;

    const mode = resolveMode(session);
    if (mode === "native") return null;

    if (schema === "malformed") {
      throw new PortableCompatibilityError("client_or_protocol_mismatch", {
        fieldPath: "tools",
        providerId: session.provider?.id,
      });
    }

    if (mode === "disabled") {
      throw new PortableCompatibilityError("provider_disabled", {
        providerId: session.provider?.id,
      });
    }

    const settings = await getCachedSystemSettings();
    if (!settings.enableCodexMultiAgentV2Compatibility) {
      throw new PortableCompatibilityError("feature_disabled", {
        providerId: session.provider?.id,
      });
    }

    // Ticket 02 performs portable payload encoding. Ticket 01 only gates it.
    return null;
  }
}
