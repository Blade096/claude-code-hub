import { PortableCompatibilityError } from "./errors";
import { isRecord } from "./guards";
import {
  PORTABLE_COLLABORATION_ACTIONS,
  PORTABLE_COLLABORATION_NAMESPACE,
  type PortableCollaborationAction,
  type PortableToolIdentityMapping,
  type PortableTransformationMetadata,
} from "./types";

const ORIGINAL_COLLABORATION_NAMESPACE = "collaboration";
const COLLABORATION_ACTIONS = new Set<string>(PORTABLE_COLLABORATION_ACTIONS);

function isCollaborationAction(value: string): value is PortableCollaborationAction {
  return COLLABORATION_ACTIONS.has(value);
}

function mappingKey(mapping: PortableToolIdentityMapping): string {
  return `${mapping.encodedNamespace}\u0000${mapping.originalNamespace}\u0000${mapping.originalName}`;
}

function validateMappings(metadata: PortableTransformationMetadata): void {
  if (!Array.isArray(metadata.toolMappings)) {
    throw new PortableCompatibilityError("missing_mapping", {
      fieldPath: "metadata.toolMappings",
      providerId: metadata.providerId,
    });
  }

  const seen = new Set<string>();
  metadata.toolMappings.forEach((mapping, index) => {
    if (
      !isRecord(mapping) ||
      typeof mapping.encodedNamespace !== "string" ||
      mapping.encodedNamespace.length === 0 ||
      typeof mapping.originalNamespace !== "string" ||
      mapping.originalNamespace.length === 0 ||
      typeof mapping.originalName !== "string" ||
      !isCollaborationAction(mapping.originalName)
    ) {
      throw new PortableCompatibilityError("malformed_response", {
        fieldPath: `metadata.toolMappings.${index}`,
        providerId: metadata.providerId,
      });
    }
    const key = mappingKey(mapping);
    if (seen.has(key)) {
      throw new PortableCompatibilityError("duplicate_mapping", {
        fieldPath: `metadata.toolMappings.${index}`,
        providerId: metadata.providerId,
      });
    }
    seen.add(key);
  });
}

function resolveMapping(
  metadata: PortableTransformationMetadata,
  name: string,
  fieldPath: string,
  omittedNamespace: boolean,
  encodedNamespace?: string
): PortableToolIdentityMapping {
  if (!isCollaborationAction(name)) {
    throw new PortableCompatibilityError("unknown_tool", {
      fieldPath,
      providerId: metadata.providerId,
    });
  }

  const matches = metadata.toolMappings.filter(
    (mapping) =>
      mapping.originalName === name &&
      (omittedNamespace || mapping.encodedNamespace === encodedNamespace)
  );
  if (matches.length === 0) {
    throw new PortableCompatibilityError("missing_mapping", {
      fieldPath,
      providerId: metadata.providerId,
    });
  }
  if (matches.length > 1) {
    const uniqueIdentities = new Set(matches.map(mappingKey));
    throw new PortableCompatibilityError(
      uniqueIdentities.size === 1 ? "duplicate_mapping" : "ambiguous_mapping",
      { fieldPath, providerId: metadata.providerId }
    );
  }
  return matches[0];
}

function restoreFunctionCall(
  item: Record<string, unknown>,
  metadata: PortableTransformationMetadata,
  fieldPath: string
): boolean {
  if (item.type !== "function_call" && item.type !== "custom_tool_call") return false;

  if (Object.hasOwn(item, "namespace") && typeof item.namespace !== "string") {
    throw new PortableCompatibilityError("malformed_response", {
      fieldPath: `${fieldPath}.namespace`,
      providerId: metadata.providerId,
    });
  }
  if (typeof item.name !== "string" || item.name.length === 0) {
    throw new PortableCompatibilityError("malformed_response", {
      fieldPath: `${fieldPath}.name`,
      providerId: metadata.providerId,
    });
  }

  const namespace = typeof item.namespace === "string" ? item.namespace : null;
  const name = item.name;

  if (namespace === ORIGINAL_COLLABORATION_NAMESPACE && isCollaborationAction(name)) {
    if (
      !metadata.toolMappings.some(
        (mapping) => mapping.originalNamespace === namespace && mapping.originalName === name
      )
    ) {
      throw new PortableCompatibilityError("missing_mapping", {
        fieldPath: `${fieldPath}.name`,
        providerId: metadata.providerId,
      });
    }
    return false;
  }
  if (namespace === null && name.startsWith(`${ORIGINAL_COLLABORATION_NAMESPACE}__`)) {
    const originalName = name.slice(ORIGINAL_COLLABORATION_NAMESPACE.length + 2);
    if (isCollaborationAction(originalName)) {
      if (
        !metadata.toolMappings.some(
          (mapping) =>
            mapping.originalNamespace === ORIGINAL_COLLABORATION_NAMESPACE &&
            mapping.originalName === originalName
        )
      ) {
        throw new PortableCompatibilityError("missing_mapping", {
          fieldPath: `${fieldPath}.name`,
          providerId: metadata.providerId,
        });
      }
      return false;
    }
  }

  let style: "structured" | "dot" | "double" | "omitted" | null = null;
  let actionName: string | null = null;
  if (namespace === PORTABLE_COLLABORATION_NAMESPACE) {
    style = "structured";
    actionName = name;
  } else if (namespace === null && name.startsWith(`${PORTABLE_COLLABORATION_NAMESPACE}.`)) {
    style = "dot";
    actionName = name.slice(PORTABLE_COLLABORATION_NAMESPACE.length + 1);
  } else if (namespace === null && name.startsWith(`${PORTABLE_COLLABORATION_NAMESPACE}__`)) {
    style = "double";
    actionName = name.slice(PORTABLE_COLLABORATION_NAMESPACE.length + 2);
  } else if (namespace === null && isCollaborationAction(name)) {
    style = "omitted";
    actionName = name;
  }

  if (style === null) return false;
  if (!actionName) {
    throw new PortableCompatibilityError("malformed_response", {
      fieldPath: `${fieldPath}.name`,
      providerId: metadata.providerId,
    });
  }

  const mapping = resolveMapping(
    metadata,
    actionName,
    `${fieldPath}.name`,
    style === "omitted",
    style === "omitted" ? undefined : PORTABLE_COLLABORATION_NAMESPACE
  );
  if (style === "double") {
    delete item.namespace;
    item.name = `${mapping.originalNamespace}__${mapping.originalName}`;
  } else {
    item.namespace = mapping.originalNamespace;
    item.name = mapping.originalName;
  }
  return true;
}

function restoreOutputArray(
  output: unknown,
  metadata: PortableTransformationMetadata,
  fieldPath: string
): number {
  if (!Array.isArray(output)) {
    throw new PortableCompatibilityError("malformed_response", {
      fieldPath,
      providerId: metadata.providerId,
    });
  }
  let restored = 0;
  output.forEach((item, index) => {
    if (!isRecord(item)) {
      throw new PortableCompatibilityError("malformed_response", {
        fieldPath: `${fieldPath}.${index}`,
        providerId: metadata.providerId,
      });
    }
    if (restoreFunctionCall(item, metadata, `${fieldPath}.${index}`)) {
      restored += 1;
    }
  });
  return restored;
}

export function restorePortableCompatibilityPayload(
  payload: unknown,
  metadata: PortableTransformationMetadata
): { payload: unknown; restoredCount: number } {
  if (!isRecord(payload)) {
    throw new PortableCompatibilityError("malformed_response", {
      fieldPath: "response",
      providerId: metadata.providerId,
    });
  }
  validateMappings(metadata);

  const restoredPayload = structuredClone(payload);
  let restoredCount = 0;
  let foundOutput = false;
  if (Object.hasOwn(restoredPayload, "output")) {
    restoredCount += restoreOutputArray(restoredPayload.output, metadata, "output");
    foundOutput = true;
  }
  if (isRecord(restoredPayload.response) && Object.hasOwn(restoredPayload.response, "output")) {
    restoredCount += restoreOutputArray(
      restoredPayload.response.output,
      metadata,
      "response.output"
    );
    foundOutput = true;
  }
  if (!foundOutput) {
    throw new PortableCompatibilityError("malformed_response", {
      fieldPath: "response.output",
      providerId: metadata.providerId,
    });
  }
  return { payload: restoredPayload, restoredCount };
}

export async function restorePortableCompatibilityResponse(
  response: Response,
  metadata: PortableTransformationMetadata
): Promise<Response> {
  try {
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("application/json") && !contentType.includes("+json")) {
      throw new PortableCompatibilityError("malformed_response", {
        fieldPath: "response.content_type",
        providerId: metadata.providerId,
      });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(await response.text());
    } catch {
      throw new PortableCompatibilityError("malformed_response", {
        fieldPath: "response.body",
        providerId: metadata.providerId,
      });
    }

    const restored = restorePortableCompatibilityPayload(payload, metadata);
    metadata.responseRestore = restored.restoredCount > 0 ? "restored" : "not_needed";
    metadata.audit.responseRestore = metadata.responseRestore;
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    return new Response(JSON.stringify(restored.payload), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch (error) {
    metadata.responseRestore = "failed";
    metadata.audit.responseRestore = "failed";
    metadata.audit.errorCode =
      error instanceof PortableCompatibilityError ? error.compatibilityCode : "malformed_response";
    throw error;
  }
}
