import { getCachedSystemSettings } from "@/lib/config";
import type { CodexMultiAgentV2Mode } from "@/types/provider";
import { detectClientFull } from "./client-detector";
import { ProxyResponses } from "./responses";
import type { ProxySession } from "./session";

const CODEX_MULTI_AGENT_V2_TOOL_NAMES = new Set(["spawn_agent", "send_message", "followup_task"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

function hasCollaborationNamespace(tools: unknown): boolean {
  if (!Array.isArray(tools)) return false;

  return tools.some((tool) => {
    if (!isRecord(tool)) return false;
    if (tool.type !== "namespace" || tool.name !== "collaboration") return false;
    return Array.isArray(tool.tools) && tool.tools.some(hasEncryptedMessageParameter);
  });
}

/**
 * Codex may place additional tools directly in `tools`, or inside an
 * `additional_tools` input item. Only the official encrypted collaboration
 * namespace is considered MultiAgentV2 traffic.
 */
export function hasCodexMultiAgentV2ToolSchema(message: Record<string, unknown>): boolean {
  if (hasCollaborationNamespace(message.tools)) return true;

  if (!Array.isArray(message.input)) return false;
  return message.input.some(
    (item) =>
      isRecord(item) && item.type === "additional_tools" && hasCollaborationNamespace(item.tools)
  );
}

export function isCodexMultiAgentV2Request(session: ProxySession): boolean {
  if (session.originalFormat !== "response") return false;
  if (session.requestUrl.pathname.replace(/\/+$/, "") !== "/v1/responses") return false;
  if (!detectClientFull(session, "codex-cli").matched) return false;
  return hasCodexMultiAgentV2ToolSchema(session.request.message);
}

function resolveMode(session: ProxySession): CodexMultiAgentV2Mode {
  return session.provider?.codexMultiAgentV2Mode ?? "native";
}

export class ProxyCodexMultiAgentV2Gate {
  static async ensure(session: ProxySession): Promise<Response | null> {
    if (!isCodexMultiAgentV2Request(session)) return null;

    const mode = resolveMode(session);
    if (mode === "native") return null;

    if (mode === "disabled") {
      return ProxyResponses.buildError(
        400,
        "The selected provider has disabled Codex MultiAgentV2 requests.",
        "codex_multi_agent_v2_provider_disabled"
      );
    }

    const settings = await getCachedSystemSettings();
    if (!settings.enableCodexMultiAgentV2Compatibility) {
      return ProxyResponses.buildError(
        400,
        "Codex MultiAgentV2 compatibility is not enabled.",
        "codex_multi_agent_v2_compatibility_disabled"
      );
    }

    // Ticket 02 performs portable payload encoding. Ticket 01 only gates it.
    return null;
  }
}
