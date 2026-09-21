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

  let foundValidNamespace = false;
  let foundMalformedNamespace = false;
  for (const tool of tools) {
    if (!isRecord(tool)) continue;
    if (tool.type !== "namespace" || tool.name !== CODEX_COLLABORATION_NAMESPACE) continue;
    if (!Array.isArray(tool.tools)) {
      foundMalformedNamespace = true;
      continue;
    }

    const collaborationTools = tool.tools.filter(
      (candidate) =>
        isRecord(candidate) &&
        candidate.type === "function" &&
        typeof candidate.name === "string" &&
        CODEX_MULTI_AGENT_V2_TOOL_NAMES.has(candidate.name)
    );
    if (collaborationTools.length === 0) {
      foundMalformedNamespace = true;
      continue;
    }

    foundValidNamespace = true;
    foundMalformedNamespace ||= collaborationTools.some(
      (candidate) => !hasEncryptedMessageParameter(candidate)
    );
  }
  if (foundMalformedNamespace) return "malformed";
  return foundValidNamespace ? "valid" : "absent";
}

function classifyCodexMultiAgentV2ToolSchema(
  message: Record<string, unknown>
): CollaborationSchemaClassification {
  const topLevel = classifyCollaborationNamespace(message.tools);
  let valid = topLevel === "valid";
  let malformed = topLevel === "malformed";
  if (Array.isArray(message.input)) {
    for (const item of message.input) {
      if (!isRecord(item) || item.type !== "additional_tools") continue;
      const nested = classifyCollaborationNamespace(item.tools);
      valid ||= nested === "valid";
      malformed ||= nested === "malformed";
    }
  }
  if (malformed) return "malformed";
  return valid ? "valid" : "absent";
}

function hasCodexSubagentEnvelope(message: Record<string, unknown>): boolean {
  const metadata = message.client_metadata;
  if (!isRecord(metadata)) return false;

  const subagent = metadata["x-openai-subagent"];
  const parentThreadId = metadata["x-codex-parent-thread-id"];
  if (
    typeof subagent !== "string" ||
    subagent.trim().length === 0 ||
    typeof parentThreadId !== "string" ||
    parentThreadId.trim().length === 0
  ) {
    return false;
  }

  return (
    Array.isArray(message.input) &&
    message.input.some((item) => isRecord(item) && item.type === "agent_message")
  );
}

function classifyCodexMultiAgentV2Request(
  message: Record<string, unknown>
): CollaborationSchemaClassification {
  const schema = classifyCodexMultiAgentV2ToolSchema(message);
  if (schema !== "absent") return schema;
  return hasCodexSubagentEnvelope(message) ? "valid" : "absent";
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

export function isCodexMultiAgentV2Request(
  session: ProxySession,
  message: Record<string, unknown> = session.request.message
): boolean {
  return (
    isOfficialCodexResponsesRequest(session) &&
    classifyCodexMultiAgentV2Request(message) === "valid"
  );
}

export function isMalformedCodexMultiAgentV2Request(
  session: ProxySession,
  message: Record<string, unknown> = session.request.message
): boolean {
  return (
    isOfficialCodexResponsesRequest(session) &&
    classifyCodexMultiAgentV2Request(message) === "malformed"
  );
}

function resolveMode(session: ProxySession): CodexMultiAgentV2Mode {
  return session.provider?.codexMultiAgentV2Mode ?? "native";
}

/**
 * Read-only compatibility preflight shared by transport-adjacent paths that
 * must decide before mutating the request. Portable requests always need the
 * shared response pipeline. Native root requests need it when their tool
 * schema will be prepared to prevent encrypted delegation; native child
 * envelopes without collaboration tools remain byte-for-byte native.
 * Internal compaction summary calls are deliberately excluded even though
 * they retain the outer request's tools.
 */
export function isPortableCodexMultiAgentV2Request(
  session: ProxySession,
  compatibilityEnabled: boolean
): boolean {
  if (!compatibilityEnabled) return false;
  if (session.isInternalCompactionRequest?.() === true) return false;
  if (!isCodexMultiAgentV2Request(session)) return false;

  const mode = resolveMode(session);
  if (mode === "portable") return true;
  return mode === "native" && hasCodexMultiAgentV2ToolSchema(session.request.message);
}

export class ProxyCodexMultiAgentV2Gate {
  static async ensure(session: ProxySession): Promise<Response | null> {
    if (!isOfficialCodexResponsesRequest(session)) return null;

    const schema = classifyCodexMultiAgentV2Request(session.request.message);
    if (schema === "absent") return null;

    if (schema === "malformed") {
      throw new PortableCompatibilityError("client_or_protocol_mismatch", {
        fieldPath: "tools",
        providerId: session.provider?.id,
      });
    }

    const mode = resolveMode(session);
    if (mode === "native") return null;

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
