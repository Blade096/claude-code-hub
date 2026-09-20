import type { CodexMultiAgentV2PortableSpecialSetting } from "@/types/special-settings";

export const PORTABLE_COLLABORATION_NAMESPACE = "collaboration-optimize";

export const PORTABLE_COLLABORATION_ACTIONS = [
  "spawn_agent",
  "send_message",
  "followup_task",
] as const;

export type PortableCollaborationAction = (typeof PORTABLE_COLLABORATION_ACTIONS)[number];

export type PortableToolIdentityMapping = {
  encodedNamespace: string;
  originalNamespace: string;
  originalName: PortableCollaborationAction;
};

export type PortableTransformation =
  | "spawn_agent_message_schema"
  | "send_message_message_schema"
  | "followup_task_message_schema"
  | "collaboration_namespace"
  | "agent_message_input";

export type PortableTransformationMetadata = {
  version: 1;
  providerId: number;
  requestFingerprint: string;
  requestedModel: string | null;
  actualModel: string | null;
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
