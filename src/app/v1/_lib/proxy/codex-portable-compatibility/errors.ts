import { ProxyError } from "../errors";

export type PortableCompatibilityErrorCode =
  | "feature_disabled"
  | "provider_disabled"
  | "client_or_protocol_mismatch"
  | "opaque_content"
  | "name_collision"
  | "unknown_tool"
  | "missing_mapping"
  | "duplicate_mapping"
  | "ambiguous_mapping"
  | "malformed_response"
  | "response_identity_mismatch"
  | "provider_transport_unsupported";

const ERROR_MESSAGES: Record<PortableCompatibilityErrorCode, string> = {
  feature_disabled: "Codex MultiAgentV2 portable compatibility is not enabled.",
  provider_disabled: "The selected provider has disabled Codex MultiAgentV2 requests.",
  client_or_protocol_mismatch:
    "The request is not supported by Codex MultiAgentV2 portable compatibility.",
  opaque_content: "Codex MultiAgentV2 portable input contains unreadable opaque content.",
  name_collision: "Codex MultiAgentV2 portable tool names are ambiguous.",
  unknown_tool: "Codex MultiAgentV2 portable response contains an unknown tool.",
  missing_mapping: "Codex MultiAgentV2 portable response has no request-local tool mapping.",
  duplicate_mapping: "Codex MultiAgentV2 portable response has duplicate tool mappings.",
  ambiguous_mapping: "Codex MultiAgentV2 portable response tool identity is ambiguous.",
  malformed_response: "Codex MultiAgentV2 portable response is malformed.",
  response_identity_mismatch:
    "Codex MultiAgentV2 portable response changed a function-call identity.",
  provider_transport_unsupported:
    "The selected provider does not support the required Responses WebSocket transport.",
};

export class PortableCompatibilityError extends ProxyError {
  readonly compatibilityCode: PortableCompatibilityErrorCode;
  readonly fieldPath: string | null;
  readonly providerId: number | null;

  constructor(
    code: PortableCompatibilityErrorCode,
    options: { fieldPath?: string; providerId?: number } = {}
  ) {
    super(ERROR_MESSAGES[code], 400);
    this.name = "PortableCompatibilityError";
    this.compatibilityCode = code;
    this.fieldPath = options.fieldPath ?? null;
    this.providerId = options.providerId ?? null;
  }

  get errorType(): string {
    return `codex_multi_agent_v2_${this.compatibilityCode}`;
  }

  toSafeDetails(): Record<string, unknown> {
    return {
      compatibilityCode: this.compatibilityCode,
      fieldPath: this.fieldPath,
      providerId: this.providerId,
    };
  }
}

export function isPortableCompatibilityError(error: unknown): error is PortableCompatibilityError {
  return error instanceof PortableCompatibilityError;
}
