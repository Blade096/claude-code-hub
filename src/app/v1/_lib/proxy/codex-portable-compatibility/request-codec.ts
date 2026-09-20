import { getCachedSystemSettings } from "@/lib/config";
import type { Provider } from "@/types/provider";
import { isCodexMultiAgentV2Request } from "../codex-multi-agent-v2-gate";
import type { ProxySession } from "../session";
import { PortableCompatibilityError } from "./errors";
import { isRecord } from "./guards";
import {
  PORTABLE_COLLABORATION_ACTIONS,
  PORTABLE_COLLABORATION_NAMESPACE,
  type PortableCollaborationAction,
  type PortablePreparation,
  type PortableToolIdentityMapping,
  type PortableTransformation,
  type PortableTransformationMetadata,
} from "./types";

const ORIGINAL_COLLABORATION_NAMESPACE = "collaboration";
const PORTABLE_REQUEST_METADATA = Symbol("codex-portable-request-metadata");
const COLLABORATION_ACTIONS = new Set<string>(PORTABLE_COLLABORATION_ACTIONS);

type MarkedPortableRequest = Record<string, unknown> & {
  [PORTABLE_REQUEST_METADATA]?: PortableTransformationMetadata;
};

type ToolContainer = {
  tools: unknown[];
  path: string;
};

type CollaborationToolTarget = {
  action: PortableCollaborationAction;
  namespace: Record<string, unknown>;
  path: string;
  tool: Record<string, unknown>;
};

function isCollaborationAction(value: unknown): value is PortableCollaborationAction {
  return typeof value === "string" && COLLABORATION_ACTIONS.has(value);
}

function collectToolContainers(request: Record<string, unknown>): ToolContainer[] {
  const containers: ToolContainer[] = [];
  if (Array.isArray(request.tools)) {
    containers.push({ tools: request.tools, path: "tools" });
  }

  if (!Array.isArray(request.input)) return containers;
  request.input.forEach((item, index) => {
    if (!isRecord(item) || item.type !== "additional_tools" || !Array.isArray(item.tools)) {
      return;
    }
    containers.push({ tools: item.tools, path: `input.${index}.tools` });
  });
  return containers;
}

function isReservedPortableName(name: unknown): boolean {
  return (
    name === PORTABLE_COLLABORATION_NAMESPACE ||
    (typeof name === "string" &&
      (name.startsWith(`${PORTABLE_COLLABORATION_NAMESPACE}.`) ||
        name.startsWith(`${PORTABLE_COLLABORATION_NAMESPACE}__`)))
  );
}

function assertNoToolIdentityCollisions(
  tools: unknown[],
  path: string,
  targetTools: Set<Record<string, unknown>>,
  providerId: number
): void {
  tools.forEach((candidate, index) => {
    if (!isRecord(candidate)) return;
    const toolPath = `${path}.${index}`;
    if (isReservedPortableName(candidate.name)) {
      throw new PortableCompatibilityError("name_collision", {
        fieldPath: `${toolPath}.name`,
        providerId,
      });
    }
    if (isCollaborationAction(candidate.name) && !targetTools.has(candidate)) {
      throw new PortableCompatibilityError("name_collision", {
        fieldPath: `${toolPath}.name`,
        providerId,
      });
    }
    if (candidate.type === "namespace" && Array.isArray(candidate.tools)) {
      assertNoToolIdentityCollisions(candidate.tools, `${toolPath}.tools`, targetTools, providerId);
    }
  });
}

function assertValidMessageSchema(target: CollaborationToolTarget, providerId: number): void {
  const parameters = target.tool.parameters;
  const properties = isRecord(parameters) ? parameters.properties : null;
  const message = isRecord(properties) ? properties.message : null;
  const fieldPath = `${target.path}.parameters.properties.message`;
  if (
    !isRecord(parameters) ||
    parameters.type !== "object" ||
    !isRecord(message) ||
    message.type !== "string"
  ) {
    throw new PortableCompatibilityError("client_or_protocol_mismatch", {
      fieldPath,
      providerId,
    });
  }
  if (message.encrypted !== true) {
    throw new PortableCompatibilityError("client_or_protocol_mismatch", {
      fieldPath: `${fieldPath}.encrypted`,
      providerId,
    });
  }
}

function collectCollaborationToolTargets(
  request: Record<string, unknown>,
  providerId: number
): CollaborationToolTarget[] {
  const containers = collectToolContainers(request);
  const targets: CollaborationToolTarget[] = [];

  for (const container of containers) {
    container.tools.forEach((candidate, namespaceIndex) => {
      if (
        !isRecord(candidate) ||
        candidate.type !== "namespace" ||
        candidate.name !== ORIGINAL_COLLABORATION_NAMESPACE ||
        !Array.isArray(candidate.tools)
      ) {
        return;
      }
      candidate.tools.forEach((tool, toolIndex) => {
        if (!isRecord(tool) || tool.type !== "function" || !isCollaborationAction(tool.name)) {
          return;
        }
        targets.push({
          action: tool.name,
          namespace: candidate,
          path: `${container.path}.${namespaceIndex}.tools.${toolIndex}`,
          tool,
        });
      });
    });
  }

  if (targets.length === 0) {
    throw new PortableCompatibilityError("client_or_protocol_mismatch", {
      fieldPath: "tools",
      providerId,
    });
  }

  const targetTools = new Set(targets.map((target) => target.tool));
  for (const container of containers) {
    assertNoToolIdentityCollisions(container.tools, container.path, targetTools, providerId);
  }

  const actionPaths = new Map<PortableCollaborationAction, string>();
  for (const target of targets) {
    if (actionPaths.has(target.action)) {
      throw new PortableCompatibilityError("name_collision", {
        fieldPath: target.path,
        providerId,
      });
    }
    actionPaths.set(target.action, target.path);
    assertValidMessageSchema(target, providerId);
  }
  return targets;
}

function rewriteCollaborationTools(
  request: Record<string, unknown>,
  providerId: number
): {
  mappings: PortableToolIdentityMapping[];
  paths: string[];
  transformations: PortableTransformation[];
} {
  const targets = collectCollaborationToolTargets(request, providerId);
  const namespaces = new Set<Record<string, unknown>>();
  const actions = new Set<PortableCollaborationAction>();

  for (const target of targets) {
    const parameters = target.tool.parameters as Record<string, unknown>;
    const properties = parameters.properties as Record<string, unknown>;
    const message = properties.message as Record<string, unknown>;
    delete message.encrypted;
    namespaces.add(target.namespace);
    actions.add(target.action);
  }
  for (const namespace of namespaces) {
    namespace.name = PORTABLE_COLLABORATION_NAMESPACE;
  }

  const mappings: PortableToolIdentityMapping[] = [];
  const transformations: PortableTransformation[] = [];
  for (const action of PORTABLE_COLLABORATION_ACTIONS) {
    if (!actions.has(action)) continue;
    mappings.push({
      encodedNamespace: PORTABLE_COLLABORATION_NAMESPACE,
      originalNamespace: ORIGINAL_COLLABORATION_NAMESPACE,
      originalName: action,
    });
    transformations.push(`${action}_message_schema` as PortableTransformation);
  }
  transformations.push("collaboration_namespace");

  return { mappings, paths: targets.map((target) => target.path), transformations };
}

function isOpaqueContent(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (/^(?:gAAAA|AQICAH|ENC\[|encrypted:)/iu.test(trimmed)) return true;
  return trimmed.length >= 80 && /^[A-Za-z0-9+/_=-]+$/u.test(trimmed);
}

function rewriteAgentMessages(
  request: Record<string, unknown>,
  providerId: number
): { changed: boolean; paths: string[] } {
  if (!Array.isArray(request.input)) return { changed: false, paths: [] };

  let changed = false;
  const paths: string[] = [];
  request.input.forEach((item, itemIndex) => {
    if (!isRecord(item) || item.type !== "agent_message") return;
    const itemPath = `input.${itemIndex}`;
    if (item.role !== undefined && item.role !== "user") {
      throw new PortableCompatibilityError("client_or_protocol_mismatch", {
        fieldPath: `${itemPath}.role`,
        providerId,
      });
    }
    if (!Array.isArray(item.content)) {
      throw new PortableCompatibilityError("client_or_protocol_mismatch", {
        fieldPath: `${itemPath}.content`,
        providerId,
      });
    }

    let readableTaskParts = 0;
    item.content.forEach((part, partIndex) => {
      if (!isRecord(part) || part.type !== "encrypted_content") return;
      const partPath = `${itemPath}.content.${partIndex}`;
      if (
        typeof part.encrypted_content !== "string" ||
        Object.hasOwn(part, "text") ||
        isOpaqueContent(part.encrypted_content)
      ) {
        throw new PortableCompatibilityError("opaque_content", {
          fieldPath: `${partPath}.encrypted_content`,
          providerId,
        });
      }
      const text = part.encrypted_content;
      delete part.encrypted_content;
      part.type = "input_text";
      part.text = text;
      readableTaskParts += 1;
      paths.push(partPath);
    });

    if (readableTaskParts === 0) {
      throw new PortableCompatibilityError("client_or_protocol_mismatch", {
        fieldPath: `${itemPath}.content`,
        providerId,
      });
    }
    item.type = "message";
    item.role = "user";
    changed = true;
  });

  return { changed, paths };
}

function resolveActualModel(session: ProxySession): string | null {
  const getCurrentModel = (session as ProxySession & { getCurrentModel?: () => string | null })
    .getCurrentModel;
  return typeof getCurrentModel === "function"
    ? getCurrentModel.call(session)
    : session.request.model;
}

export async function preparePortableCompatibilityRequest({
  session,
  provider,
  request,
}: {
  session: ProxySession;
  provider: Provider;
  request: Record<string, unknown>;
}): Promise<PortablePreparation> {
  const isMultiAgentV2 = isCodexMultiAgentV2Request(session);
  const mode = provider.codexMultiAgentV2Mode ?? "native";

  if (!isMultiAgentV2 || mode === "native") {
    return { request, metadata: null };
  }
  if (mode === "disabled") {
    throw new PortableCompatibilityError("provider_disabled", { providerId: provider.id });
  }

  const settings = await getCachedSystemSettings();
  if (!settings.enableCodexMultiAgentV2Compatibility) {
    throw new PortableCompatibilityError("feature_disabled", { providerId: provider.id });
  }
  if (request.stream === true) {
    throw new PortableCompatibilityError("client_or_protocol_mismatch", {
      fieldPath: "stream",
      providerId: provider.id,
    });
  }

  const priorMetadata = (request as MarkedPortableRequest)[PORTABLE_REQUEST_METADATA];
  if (priorMetadata) {
    if (priorMetadata.providerId !== provider.id) {
      throw new PortableCompatibilityError("name_collision", {
        fieldPath: "tools",
        providerId: provider.id,
      });
    }
    return { request, metadata: priorMetadata };
  }

  const prepared = structuredClone(request);
  const toolResult = rewriteCollaborationTools(prepared, provider.id);
  const inputResult = rewriteAgentMessages(prepared, provider.id);
  const transformations = [...toolResult.transformations];
  if (inputResult.changed) transformations.push("agent_message_input");

  const audit = {
    type: "codex_multi_agent_v2_portable" as const,
    scope: "request" as const,
    hit: true as const,
    providerId: provider.id,
    requestedModel: session.request.model,
    actualModel: resolveActualModel(session),
    transformations: [...transformations],
    responseRestore: "pending" as const,
    errorCode: null,
  };
  const metadata: PortableTransformationMetadata = {
    version: 1,
    providerId: provider.id,
    requestedModel: session.request.model,
    actualModel: resolveActualModel(session),
    toolMappings: toolResult.mappings,
    transformations,
    matchedPaths: [...toolResult.paths, ...inputResult.paths],
    responseRestore: "pending",
    audit,
  };

  Object.defineProperty(prepared, PORTABLE_REQUEST_METADATA, {
    value: metadata,
    enumerable: false,
  });

  return { request: prepared, metadata };
}
