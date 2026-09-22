import type { CodexMultiAgentV2PortableSpecialSetting } from "@/types/special-settings";

export const PORTABLE_COLLABORATION_NAMESPACE = "collaboration-optimize";
export const CODEX_COLLABORATION_NAMESPACE = "collaboration";

export const PORTABLE_COLLABORATION_ACTIONS = [
  "spawn_agent",
  "send_message",
  "followup_task",
] as const;

export type PortableCollaborationAction = (typeof PORTABLE_COLLABORATION_ACTIONS)[number];

export type PortableToolIdentityMapping = {
  encodedNamespace: string;
  encodedName?: string;
  originalNamespace: string;
  originalName: string;
};

export type PortableTransformation =
  | "spawn_agent_message_schema"
  | "send_message_message_schema"
  | "followup_task_message_schema"
  | "spawn_agent_routing_instruction"
  | "collaboration_namespace"
  | "collaboration_history"
  | "agent_message_input";

export type PortableTransport = "http" | "sse" | "websocket";

export type PortableCompatibilityErrorCategory =
  | "compatibility_feature_disabled"
  | "compatibility_provider_disabled"
  | "compatibility_client_or_protocol_mismatch"
  | "compatibility_opaque_content"
  | "compatibility_name_collision"
  | "compatibility_restore_failed"
  | "compatibility_transport_unsupported";

export type PortableTransformationMetadata = {
  version: 1;
  providerId: number;
  requestFingerprint: string;
  requestedModel: string | null;
  actualModel: string | null;
  toolPresentation?: "duplicate" | "replace";
  portableTargetModels?: string[];
  toolMappings: PortableToolIdentityMapping[];
  transformations: PortableTransformation[];
  matchedPaths: string[];
  responseRestore: "pending" | "restored" | "not_needed" | "failed";
  audit: CodexMultiAgentV2PortableSpecialSetting;
};

export type PortablePreparation = {
  request: Record<string, unknown>;
  metadata: PortableTransformationMetadata | null;
};

export type PortableResponseCallBinding = {
  callToken: string;
  toolIdentity: string;
};

export type PortableResponseRestoreState = {
  callIdentities: Map<string, PortableResponseCallBinding>;
};
