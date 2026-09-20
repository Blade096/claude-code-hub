import { getCachedSystemSettings } from "@/lib/config";
import type { Provider } from "@/types/provider";
import { isCodexMultiAgentV2Request } from "../codex-multi-agent-v2-gate";
import type { ProxySession } from "../session";
import { PortableCompatibilityError } from "./errors";
import {
  PORTABLE_COLLABORATION_NAMESPACE,
  type PortablePreparation,
  type PortableTransformation,
  type PortableTransformationMetadata,
} from "./types";

const ORIGINAL_COLLABORATION_NAMESPACE = "collaboration";
const SUPPORTED_TOOL_NAME = "spawn_agent";
const PORTABLE_REQUEST_METADATA = Symbol("codex-portable-request-metadata");

type MarkedPortableRequest = Record<string, unknown> & {
  [PORTABLE_REQUEST_METADATA]?: PortableTransformationMetadata;
};

type ToolContainer = {
  tools: unknown[];
  path: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function hasSpawnAgentSchema(namespace: Record<string, unknown>): boolean {
  if (!Array.isArray(namespace.tools)) return false;
  return namespace.tools.some(
    (tool) => isRecord(tool) && tool.type === "function" && tool.name === SUPPORTED_TOOL_NAME
  );
}

function assertNoReservedToolCollision(
  tool: Record<string, unknown>,
  path: string,
  providerId: number
): void {
  if (
    tool.name === PORTABLE_COLLABORATION_NAMESPACE ||
    (typeof tool.name === "string" &&
      (tool.name.startsWith(`${PORTABLE_COLLABORATION_NAMESPACE}.`) ||
        tool.name.startsWith(`${PORTABLE_COLLABORATION_NAMESPACE}__`)))
  ) {
    throw new PortableCompatibilityError("name_collision", {
      fieldPath: `${path}.name`,
      providerId,
    });
  }
  if (tool.type === "function" && tool.name === SUPPORTED_TOOL_NAME) {
    throw new PortableCompatibilityError("name_collision", {
      fieldPath: `${path}.name`,
      providerId,
    });
  }
  if (tool.type === "namespace" && Array.isArray(tool.tools)) {
    tool.tools.forEach((nested, index) => {
      if (isRecord(nested)) {
        assertNoReservedToolCollision(nested, `${path}.tools.${index}`, providerId);
      }
    });
  }
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
      if (typeof part.encrypted_content !== "string" || isOpaqueContent(part.encrypted_content)) {
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

function rewriteSpawnAgentTools(
  request: Record<string, unknown>,
  providerId: number
): { paths: string[] } {
  const containers = collectToolContainers(request);
  const originalNamespaces: Array<{ namespace: Record<string, unknown>; path: string }> = [];

  for (const container of containers) {
    container.tools.forEach((tool, toolIndex) => {
      if (!isRecord(tool)) return;
      const path = `${container.path}.${toolIndex}`;
      if (
        tool.type === "namespace" &&
        tool.name === ORIGINAL_COLLABORATION_NAMESPACE &&
        hasSpawnAgentSchema(tool)
      ) {
        originalNamespaces.push({ namespace: tool, path });
        return;
      }
      assertNoReservedToolCollision(tool, path, providerId);
    });
  }

  if (originalNamespaces.length === 0) {
    throw new PortableCompatibilityError("client_or_protocol_mismatch", {
      fieldPath: "tools",
      providerId,
    });
  }

  const paths: string[] = [];
  for (const target of originalNamespaces) {
    const namespaceTools = target.namespace.tools as unknown[];
    namespaceTools.forEach((tool, index) => {
      if (isRecord(tool) && !(tool.type === "function" && tool.name === SUPPORTED_TOOL_NAME)) {
        assertNoReservedToolCollision(tool, `${target.path}.tools.${index}`, providerId);
      }
    });
    const spawnTools = namespaceTools
      .map((tool, index) => ({ tool, index }))
      .filter(
        (entry): entry is { tool: Record<string, unknown>; index: number } =>
          isRecord(entry.tool) &&
          entry.tool.type === "function" &&
          entry.tool.name === SUPPORTED_TOOL_NAME
      );

    for (const { tool, index } of spawnTools) {
      const toolPath = `${target.path}.tools.${index}`;
      const parameters = tool.parameters;
      const properties = isRecord(parameters) ? parameters.properties : null;
      const message = isRecord(properties) ? properties.message : null;
      if (
        !isRecord(parameters) ||
        parameters.type !== "object" ||
        !isRecord(message) ||
        message.type !== "string"
      ) {
        throw new PortableCompatibilityError("client_or_protocol_mismatch", {
          fieldPath: `${toolPath}.parameters.properties.message`,
          providerId,
        });
      }
      if (
        target.namespace.name === ORIGINAL_COLLABORATION_NAMESPACE &&
        message.encrypted !== true
      ) {
        throw new PortableCompatibilityError("client_or_protocol_mismatch", {
          fieldPath: `${toolPath}.parameters.properties.message.encrypted`,
          providerId,
        });
      }
      delete message.encrypted;
      paths.push(toolPath);
    }
    target.namespace.name = PORTABLE_COLLABORATION_NAMESPACE;
  }

  return { paths };
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
  const toolResult = rewriteSpawnAgentTools(prepared, provider.id);
  const inputResult = rewriteAgentMessages(prepared, provider.id);
  const transformations: PortableTransformation[] = [
    "spawn_agent_message_schema",
    "collaboration_namespace",
  ];
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
    toolMappings: [
      {
        encodedNamespace: PORTABLE_COLLABORATION_NAMESPACE,
        originalNamespace: ORIGINAL_COLLABORATION_NAMESPACE,
        originalName: SUPPORTED_TOOL_NAME,
      },
    ],
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
