import {
  CODEX_COLLABORATION_NAMESPACE,
  PORTABLE_COLLABORATION_ACTIONS,
  type PortableCollaborationAction,
} from "@/app/v1/_lib/proxy/codex-portable-compatibility/types";

export const COLLABORATION_ACTIONS: PortableCollaborationAction[] = [
  ...PORTABLE_COLLABORATION_ACTIONS,
];

export function makeCollaborationNamespace(
  action: PortableCollaborationAction = "spawn_agent",
  namespace = CODEX_COLLABORATION_NAMESPACE
) {
  return {
    type: "namespace",
    name: namespace,
    description: "Collaboration tools",
    tools: [
      {
        type: "function",
        name: action,
        description: "Spawns an agent",
        parameters: {
          type: "object",
          required: ["message"],
          properties: {
            message: { type: "string", encrypted: true, minLength: 1 },
            model: { type: "string" },
          },
        },
      },
    ],
  };
}
