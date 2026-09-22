import { createHash } from "node:crypto";
import { getCachedSystemSettings } from "@/lib/config";
import { PROVIDER_GROUP } from "@/lib/constants/provider.constants";
import { parseProviderGroups, resolveProviderGroupsWithDefault } from "@/lib/utils/provider-group";
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
const PORTABLE_SPAWN_TOOL_NAME = "spawn_portable_agent";
const PORTABLE_ROUTING_INSTRUCTION_PREFIX = "CCH portable child-model routing rule:";
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
  strategy: "duplicate" | "replace";
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

function appendRoutingDescription(existing: unknown, sentence: string): string {
  const prefix = typeof existing === "string" ? existing.trim() : "";
  return prefix.length > 0 ? `${prefix} ${sentence}` : sentence;
}

function injectPortableSpawnRoutingInstruction(
  request: Record<string, unknown>,
  portableTargetModels: string[],
  providerId: number
): string {
  const portableList = portableTargetModels.join(", ");
  const text = `${PORTABLE_ROUTING_INSTRUCTION_PREFIX} If model is exactly one of [${portableList}], you must call ${PORTABLE_COLLABORATION_NAMESPACE}.${PORTABLE_SPAWN_TOOL_NAME}; never call ${ORIGINAL_COLLABORATION_NAMESPACE}.spawn_agent for those model values. For every other model, use ${ORIGINAL_COLLABORATION_NAMESPACE}.spawn_agent.`;
  if (request.instructions === undefined) {
    request.instructions = text;
    return "instructions";
  }
  if (typeof request.instructions !== "string") {
    throw new PortableCompatibilityError("client_or_protocol_mismatch", {
      fieldPath: "instructions",
      providerId,
    });
  }
  if (!request.instructions.includes(PORTABLE_ROUTING_INSTRUCTION_PREFIX)) {
    request.instructions = `${request.instructions.trimEnd()}\n\n${text}`;
  }
  return "instructions";
}

function rewriteCollaborationTools(
  request: Record<string, unknown>,
  providerId: number,
  strategy: "duplicate" | "replace",
  portableTargetModels: string[] = []
): ToolRewriteResult {
  const targets = collectCollaborationToolTargets(request, providerId);
  if (targets.length === 0) {
    return { strategy, mappings: [], paths: [], transformations: [] };
  }
  const actions = new Set<PortableCollaborationAction>();

  for (const target of targets) {
    if (
      target.messageAction &&
      (strategy === "replace" ||
        (target.messageAction === "spawn_agent" && portableTargetModels.length > 0))
    ) {
      actions.add(target.messageAction);
    }
  }
  const portableSpawnEnabled = actions.has("spawn_agent") && portableTargetModels.length > 0;

  if (strategy === "replace") {
    const namespaces = new Set<Record<string, unknown>>();
    for (const target of targets) {
      if (target.messageAction) {
        const parameters = target.tool.parameters as Record<string, unknown>;
        const properties = parameters.properties as Record<string, unknown>;
        const message = properties.message as Record<string, unknown>;
        delete message.encrypted;
      }
      namespaces.add(target.namespace);
    }
    for (const namespace of namespaces) namespace.name = PORTABLE_COLLABORATION_NAMESPACE;
  } else {
    for (const container of collectToolContainers(request)) {
      const portableNamespaces: Record<string, unknown>[] = [];
      for (const candidate of container.tools) {
        if (
          !isRecord(candidate) ||
          candidate.type !== "namespace" ||
          candidate.name !== ORIGINAL_COLLABORATION_NAMESPACE ||
          !Array.isArray(candidate.tools)
        ) {
          continue;
        }

        const portableTools = candidate.tools.flatMap((tool) => {
          if (!isRecord(tool) || tool.name !== "spawn_agent" || !portableSpawnEnabled) {
            return [];
          }
          const portableTool = structuredClone(tool);
          portableTool.name = PORTABLE_SPAWN_TOOL_NAME;
          const portableList = portableTargetModels.join(", ");
          portableTool.description = appendRoutingDescription(
            portableTool.description,
            `Use this plaintext compatibility tool when model is one of: ${portableList}.`
          );
          const parameters = portableTool.parameters as Record<string, unknown>;
          const properties = parameters.properties as Record<string, unknown>;
          const message = properties.message as Record<string, unknown>;
          delete message.encrypted;
          properties.model = { type: "string", enum: [...portableTargetModels] };
          const required = Array.isArray(parameters.required) ? [...parameters.required] : [];
          if (!required.includes("model")) required.push("model");
          parameters.required = required;
          return [portableTool];
        });
        if (portableTools.length === 0) continue;

        portableNamespaces.push({
          ...structuredClone(candidate),
          name: PORTABLE_COLLABORATION_NAMESPACE,
          tools: portableTools,
        });
      }
      container.tools.push(...portableNamespaces);
    }
  }

  const mappings: PortableToolIdentityMapping[] =
    strategy === "replace"
      ? targets.map((target) => ({
          encodedNamespace: PORTABLE_COLLABORATION_NAMESPACE,
          originalNamespace: ORIGINAL_COLLABORATION_NAMESPACE,
          originalName: target.name,
        }))
      : portableSpawnEnabled
        ? [
            {
              encodedNamespace: PORTABLE_COLLABORATION_NAMESPACE,
              encodedName: PORTABLE_SPAWN_TOOL_NAME,
              originalNamespace: ORIGINAL_COLLABORATION_NAMESPACE,
              originalName: "spawn_agent",
            },
          ]
        : [];
  const transformations: PortableTransformation[] = [];
  for (const action of PORTABLE_COLLABORATION_ACTIONS) {
    if (!actions.has(action)) continue;
    transformations.push(`${action}_message_schema` as PortableTransformation);
  }
  if (mappings.length > 0) transformations.push("collaboration_namespace");
  const routingPath =
    strategy === "duplicate" && portableSpawnEnabled
      ? injectPortableSpawnRoutingInstruction(request, portableTargetModels, providerId)
      : null;
  if (routingPath) transformations.push("spawn_agent_routing_instruction");

  return {
    strategy,
    mappings,
    paths: [...targets.map((target) => target.path), ...(routingPath ? [routingPath] : [])],
    transformations,
  };
}

async function resolvePortableTargetModels(
  session: ProxySession,
  currentProvider: Provider
): Promise<string[]> {
  const providers = await session.getProvidersSnapshot?.();
  if (!Array.isArray(providers)) return [];

  const effectiveGroup =
    session.authState?.key?.providerGroup ||
    session.authState?.user?.providerGroup ||
    (session.authState ? PROVIDER_GROUP.DEFAULT : null);
  const userGroups = effectiveGroup ? parseProviderGroups(effectiveGroup) : [];
  const models = new Set<string>();
  for (const provider of providers) {
    const providerGroups = resolveProviderGroupsWithDefault(provider.groupTag);
    const visibleToGroup =
      effectiveGroup === null ||
      userGroups.includes(PROVIDER_GROUP.ALL) ||
      providerGroups.some((group) => userGroups.includes(group));
    if (
      provider.id === currentProvider.id ||
      !provider.isEnabled ||
      provider.providerType !== "codex" ||
      provider.codexMultiAgentV2Mode !== "portable" ||
      !visibleToGroup ||
      !Array.isArray(provider.allowedModels)
    ) {
      continue;
    }
    for (const rule of provider.allowedModels) {
      const model =
        typeof rule === "string"
          ? rule.trim()
          : rule.matchType === "exact"
            ? rule.pattern.trim()
            : "";
      if (model) models.add(model);
    }
  }
  return [...models].sort();
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

function rewriteAgentMessages(
  request: Record<string, unknown>,
  providerId: number,
  options: { preserveOpaque: boolean; preservePlaintext: boolean } = {
    preserveOpaque: false,
    preservePlaintext: false,
  }
): { changed: boolean; paths: string[] } {
  if (!Array.isArray(request.input)) return { changed: false, paths: [] };

  let changed = false;
  const paths: string[] = [];
  request.input.forEach((item, itemIndex) => {
    if (!isRecord(item) || item.type !== "agent_message") return;
    const itemPath = `input.${itemIndex}`;
    if (item.role !== undefined && item.role !== "user") {
      if (options.preserveOpaque) return;
      throw new PortableCompatibilityError("client_or_protocol_mismatch", {
        fieldPath: `${itemPath}.role`,
        providerId,
      });
    }
    if (!Array.isArray(item.content)) {
      if (options.preserveOpaque) return;
      throw new PortableCompatibilityError("client_or_protocol_mismatch", {
        fieldPath: `${itemPath}.content`,
        providerId,
      });
    }

    const plaintextPaths: string[] = [];
    let hasPlaintextTaskPart = false;
    let encryptedTaskPath: string | null = null;
    item.content.forEach((part, partIndex) => {
      if (!isRecord(part)) return;
      const partPath = `${itemPath}.content.${partIndex}`;
      if (part.type === "input_text") {
        if (typeof part.text !== "string") {
          if (options.preserveOpaque) return;
          throw new PortableCompatibilityError("client_or_protocol_mismatch", {
            fieldPath: `${partPath}.text`,
            providerId,
          });
        }
        hasPlaintextTaskPart = true;
        plaintextPaths.push(partPath);
        return;
      }
      if (part.type !== "encrypted_content") return;
      encryptedTaskPath ??= `${partPath}.encrypted_content`;
    });

    if (encryptedTaskPath !== null) {
      if (options.preserveOpaque) return;
      throw new PortableCompatibilityError("opaque_content", {
        fieldPath: encryptedTaskPath,
        providerId,
      });
    }
    if (!hasPlaintextTaskPart) {
      if (options.preserveOpaque) return;
      throw new PortableCompatibilityError("client_or_protocol_mismatch", {
        fieldPath: `${itemPath}.content`,
        providerId,
      });
    }
    if (options.preservePlaintext) return;
    paths.push(...plaintextPaths);
    item.type = "message";
    item.role = "user";
    changed = true;
  });

  return { changed, paths };
}

function rewritePortableHistoryCalls(
  request: Record<string, unknown>,
  mappings: PortableToolIdentityMapping[],
  providerId: number,
  strategy: "duplicate" | "replace",
  portableTargetModels: string[]
): string[] {
  if (!Array.isArray(request.input)) return [];

  const paths: string[] = [];
  request.input.forEach((item, index) => {
    if (
      !isRecord(item) ||
      item.type !== "function_call" ||
      item.namespace !== ORIGINAL_COLLABORATION_NAMESPACE ||
      !isCollaborationAction(item.name)
    ) {
      return;
    }
    const candidates = mappings.filter((mapping) => mapping.originalName === item.name);
    const mapping = candidates[0];
    if (strategy === "duplicate") {
      let parsedArguments: unknown;
      try {
        parsedArguments = typeof item.arguments === "string" ? JSON.parse(item.arguments) : null;
      } catch {
        parsedArguments = null;
      }
      const model = isRecord(parsedArguments) ? parsedArguments.model : null;
      if (typeof model !== "string" || !portableTargetModels.includes(model)) {
        return;
      }
    }
    if (!mapping) {
      if (strategy === "duplicate") return;
      throw new PortableCompatibilityError("missing_mapping", {
        fieldPath: `input.${index}.name`,
        providerId,
      });
    }
    if (Array.isArray(item.encrypted_function_args) && item.encrypted_function_args.length > 0) {
      throw new PortableCompatibilityError("opaque_content", {
        fieldPath: `input.${index}.encrypted_function_args`,
        providerId,
      });
    }
    item.namespace = mapping.encodedNamespace;
    item.name = mapping.encodedName ?? mapping.originalName;
    delete item.encrypted_function_args;
    paths.push(`input.${index}`);
  });
  return paths;
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
  portableTargetModels: string[],
  inputPaths: string[],
  historyPaths: string[],
  preparedRequest: Record<string, unknown>
): PortableTransformationMetadata {
  const transformations = [...toolResult.transformations];
  if (historyPaths.length > 0) transformations.push("collaboration_history");
  if (inputPaths.length > 0) transformations.push("agent_message_input");
  const actualModel = resolveActualModel(session);
  const audit = createPortableCompatibilityAudit({ session, provider, transformations });
  return {
    version: 1,
    providerId: provider.id,
    requestFingerprint: fingerprintPreparedRequest(preparedRequest),
    requestedModel: audit.requestedModel,
    actualModel,
    toolPresentation: toolResult.strategy,
    portableTargetModels: [...portableTargetModels],
    toolMappings: toolResult.mappings,
    transformations,
    matchedPaths: [...toolResult.paths, ...historyPaths, ...inputPaths],
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
  const portableTargetModels =
    mode === "native" ? await resolvePortableTargetModels(session, provider) : [];
  const toolResult = rewriteCollaborationTools(
    prepared,
    provider.id,
    mode === "native" ? "duplicate" : "replace",
    portableTargetModels
  );
  const historyPaths = rewritePortableHistoryCalls(
    prepared,
    toolResult.mappings,
    provider.id,
    toolResult.strategy,
    portableTargetModels
  );
  const inputResult = rewriteAgentMessages(prepared, provider.id, {
    preserveOpaque: mode === "native",
    preservePlaintext: mode === "native",
  });
  if (
    toolResult.transformations.length === 0 &&
    historyPaths.length === 0 &&
    inputResult.paths.length === 0
  ) {
    return { request, metadata: null };
  }
  const metadata = createTransformationMetadata(
    session,
    provider,
    toolResult,
    portableTargetModels,
    inputResult.paths,
    historyPaths,
    prepared
  );
  markPreparedRequest(prepared, metadata);
  setAttemptMetadata(session, metadata);

  return { request: prepared, metadata };
}
