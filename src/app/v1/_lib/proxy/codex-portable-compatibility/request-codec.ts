import { createHash } from "node:crypto";
import { getCachedSystemSettings } from "@/lib/config";
import type { Provider } from "@/types/provider";
import {
  hasCodexMultiAgentV2ToolSchema,
  isCodexMultiAgentV2Request,
  isMalformedCodexMultiAgentV2Request,
} from "../codex-multi-agent-v2-gate";
import type { ProxySession } from "../session";
import { createPortableCompatibilityAudit } from "./audit";
import { PortableCompatibilityError } from "./errors";
import { isRecord } from "./guards";
import {
  CODEX_COLLABORATION_NAMESPACE,
  PORTABLE_COLLABORATION_ACTIONS,
  PORTABLE_COLLABORATION_NAMESPACE,
  type PortableCollaborationAction,
  type PortablePreparation,
  type PortableToolIdentityMapping,
  type PortableTransformation,
  type PortableTransformationMetadata,
} from "./types";

const ORIGINAL_COLLABORATION_NAMESPACE = CODEX_COLLABORATION_NAMESPACE;
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
  messageAction: PortableCollaborationAction | null;
  name: string;
  namespace: Record<string, unknown>;
  path: string;
  tool: Record<string, unknown>;
};

type ToolRewriteResult = {
  mappings: PortableToolIdentityMapping[];
  paths: string[];
  transformations: PortableTransformation[];
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
  targetNames: Set<string>,
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
    if (
      typeof candidate.name === "string" &&
      (isCollaborationAction(candidate.name) || targetNames.has(candidate.name)) &&
      !targetTools.has(candidate)
    ) {
      throw new PortableCompatibilityError("name_collision", {
        fieldPath: `${toolPath}.name`,
        providerId,
      });
    }
    if (candidate.type === "namespace" && Array.isArray(candidate.tools)) {
      assertNoToolIdentityCollisions(
        candidate.tools,
        `${toolPath}.tools`,
        targetTools,
        targetNames,
        providerId
      );
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
        if (
          !isRecord(tool) ||
          tool.type !== "function" ||
          typeof tool.name !== "string" ||
          tool.name.length === 0
        ) {
          return;
        }
        targets.push({
          messageAction: isCollaborationAction(tool.name) ? tool.name : null,
          name: tool.name,
          namespace: candidate,
          path: `${container.path}.${namespaceIndex}.tools.${toolIndex}`,
          tool,
        });
      });
    });
  }

  const targetTools = new Set(targets.map((target) => target.tool));
  const targetNames = new Set(targets.map((target) => target.name));
  for (const container of containers) {
    assertNoToolIdentityCollisions(
      container.tools,
      container.path,
      targetTools,
      targetNames,
      providerId
    );
  }

  const actionPaths = new Map<string, string>();
  for (const target of targets) {
    if (actionPaths.has(target.name)) {
      throw new PortableCompatibilityError("name_collision", {
        fieldPath: target.path,
        providerId,
      });
    }
    actionPaths.set(target.name, target.path);
    if (target.messageAction) assertValidMessageSchema(target, providerId);
  }
  return targets;
}

function rewriteCollaborationTools(
  request: Record<string, unknown>,
  providerId: number,
  renameNamespace: boolean
): ToolRewriteResult {
  const targets = collectCollaborationToolTargets(request, providerId);
  if (targets.length === 0) {
    return { mappings: [], paths: [], transformations: [] };
  }
  const namespaces = new Set<Record<string, unknown>>();
  const actions = new Set<PortableCollaborationAction>();

  for (const target of targets) {
    if (target.messageAction) {
      const parameters = target.tool.parameters as Record<string, unknown>;
      const properties = parameters.properties as Record<string, unknown>;
      const message = properties.message as Record<string, unknown>;
      delete message.encrypted;
      actions.add(target.messageAction);
    }
    namespaces.add(target.namespace);
  }
  for (const namespace of namespaces) {
    if (renameNamespace) namespace.name = PORTABLE_COLLABORATION_NAMESPACE;
  }

  const mappings: PortableToolIdentityMapping[] = renameNamespace
    ? targets.map((target) => ({
        encodedNamespace: PORTABLE_COLLABORATION_NAMESPACE,
        originalNamespace: ORIGINAL_COLLABORATION_NAMESPACE,
        originalName: target.name,
      }))
    : [];
  const transformations: PortableTransformation[] = [];
  for (const action of PORTABLE_COLLABORATION_ACTIONS) {
    if (!actions.has(action)) continue;
    transformations.push(`${action}_message_schema` as PortableTransformation);
  }
  if (renameNamespace) transformations.push("collaboration_namespace");

  return { mappings, paths: targets.map((target) => target.path), transformations };
}

function hasPreparedPortableNamespace(request: Record<string, unknown>): boolean {
  return collectToolContainers(request).some((container) =>
    container.tools.some(
      (tool) =>
        isRecord(tool) &&
        tool.type === "namespace" &&
        tool.name === PORTABLE_COLLABORATION_NAMESPACE
    )
  );
}

function fingerprintPreparedRequest(request: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(request)).digest("hex");
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

function createTransformationMetadata(
  session: ProxySession,
  provider: Provider,
  toolResult: ToolRewriteResult,
  inputPaths: string[],
  preparedRequest: Record<string, unknown>
): PortableTransformationMetadata {
  const transformations = [...toolResult.transformations];
  if (inputPaths.length > 0) transformations.push("agent_message_input");
  const actualModel = resolveActualModel(session);
  const audit = createPortableCompatibilityAudit({ session, provider, transformations });
  return {
    version: 1,
    providerId: provider.id,
    requestFingerprint: fingerprintPreparedRequest(preparedRequest),
    requestedModel: audit.requestedModel,
    actualModel,
    toolMappings: toolResult.mappings,
    transformations,
    matchedPaths: [...toolResult.paths, ...inputPaths],
    responseRestore: "pending",
    audit,
  };
}

function markPreparedRequest(
  request: Record<string, unknown>,
  metadata: PortableTransformationMetadata
): void {
  Object.defineProperty(request, PORTABLE_REQUEST_METADATA, {
    value: metadata,
    enumerable: false,
  });
}

function setAttemptMetadata(session: ProxySession, metadata: PortableTransformationMetadata): void {
  session.setPortableTransformationMetadata?.(metadata);
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
  if (session.isInternalCompactionRequest?.() === true) {
    return { request, metadata: null };
  }
  const priorMetadata = (request as MarkedPortableRequest)[PORTABLE_REQUEST_METADATA];
  if (priorMetadata) {
    if (priorMetadata.providerId !== provider.id) {
      throw new PortableCompatibilityError("name_collision", {
        fieldPath: "tools",
        providerId: provider.id,
      });
    }
    setAttemptMetadata(session, priorMetadata);
    return { request, metadata: priorMetadata };
  }
  if (isMalformedCodexMultiAgentV2Request(session, request)) {
    throw new PortableCompatibilityError("client_or_protocol_mismatch", {
      fieldPath: "tools",
      providerId: provider.id,
    });
  }
  const isMultiAgentV2 = isCodexMultiAgentV2Request(session, request);
  const isPreparedRetry =
    !isMultiAgentV2 && isCodexMultiAgentV2Request(session) && hasPreparedPortableNamespace(request);
  const mode = provider.codexMultiAgentV2Mode ?? "native";

  if (!isMultiAgentV2 && !isPreparedRetry) {
    return { request, metadata: null };
  }
  if (mode === "disabled") {
    throw new PortableCompatibilityError("provider_disabled", { providerId: provider.id });
  }

  const settings = await getCachedSystemSettings();
  if (!settings.enableCodexMultiAgentV2Compatibility) {
    if (mode === "native") return { request, metadata: null };
    throw new PortableCompatibilityError("feature_disabled", { providerId: provider.id });
  }
  if (mode === "native" && !hasCodexMultiAgentV2ToolSchema(request)) {
    return { request, metadata: null };
  }

  // The fake-streaming runner consumes the upstream body without passing it
  // through the shared portable response restorer. Only reject attempts that
  // will actually transform the request under the effective feature settings.
  if (session.isFakeStreamingAttempt?.() === true) {
    throw new PortableCompatibilityError("provider_transport_unsupported", {
      fieldPath: "transport.fake_streaming",
      providerId: provider.id,
    });
  }
  if (hasPreparedPortableNamespace(request)) {
    const metadata = session.getPortableTransformationMetadata?.() ?? null;
    if (
      !metadata ||
      metadata.providerId !== provider.id ||
      metadata.responseRestore !== "pending" ||
      metadata.requestFingerprint !== fingerprintPreparedRequest(request)
    ) {
      throw new PortableCompatibilityError("name_collision", {
        fieldPath: "tools",
        providerId: provider.id,
      });
    }
    markPreparedRequest(request, metadata);
    return { request, metadata };
  }

  const prepared = structuredClone(request);
  const toolResult = rewriteCollaborationTools(prepared, provider.id, true);
  const inputResult =
    mode === "portable"
      ? rewriteAgentMessages(prepared, provider.id)
      : { changed: false, paths: [] };
  const metadata = createTransformationMetadata(
    session,
    provider,
    toolResult,
    inputResult.paths,
    prepared
  );
  markPreparedRequest(prepared, metadata);
  setAttemptMetadata(session, metadata);

  return { request: prepared, metadata };
}
