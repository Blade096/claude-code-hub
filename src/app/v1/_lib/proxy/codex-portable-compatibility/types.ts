import type { CodexMultiAgentV2PortableSpecialSetting } from "@/types/special-settings";

export const PORTABLE_COLLABORATION_NAMESPACE = "collaboration-optimize";

export type PortableToolIdentityMapping = {
  encodedNamespace: typeof PORTABLE_COLLABORATION_NAMESPACE;
  originalNamespace: "collaboration";
  originalName: "spawn_agent";
};

export type PortableTransformation =
  | "spawn_agent_message_schema"
  | "collaboration_namespace"
  | "agent_message_input";

export type PortableTransformationMetadata = {
  version: 1;
  providerId: number;
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
