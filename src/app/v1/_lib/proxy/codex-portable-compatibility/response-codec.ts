import { PortableCompatibilityError } from "./errors";
import {
  PORTABLE_COLLABORATION_NAMESPACE,
  type PortableToolIdentityMapping,
  type PortableTransformationMetadata,
} from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findMapping(
  metadata: PortableTransformationMetadata,
  name: string
): PortableToolIdentityMapping | null {
  const matches = metadata.toolMappings.filter((mapping) => mapping.originalName === name);
  return matches.length === 1 ? matches[0] : null;
}

function restoreFunctionCall(
  item: Record<string, unknown>,
  metadata: PortableTransformationMetadata,
  fieldPath: string
): boolean {
  if (item.type !== "function_call" && item.type !== "custom_tool_call") return false;

  const namespace = typeof item.namespace === "string" ? item.namespace : null;
  const name = typeof item.name === "string" ? item.name : null;
  if (namespace === "collaboration" && name === "spawn_agent") return false;
  if (namespace === null && name === "collaboration__spawn_agent") return false;

  let encodedStyle: "structured" | "dot" | "double" | "omitted" | null = null;
  let toolName: string | null = null;
  if (namespace === PORTABLE_COLLABORATION_NAMESPACE) {
    encodedStyle = "structured";
    toolName = name;
  } else if (namespace === null && name?.startsWith(`${PORTABLE_COLLABORATION_NAMESPACE}.`)) {
    encodedStyle = "dot";
    toolName = name.slice(PORTABLE_COLLABORATION_NAMESPACE.length + 1);
  } else if (namespace === null && name?.startsWith(`${PORTABLE_COLLABORATION_NAMESPACE}__`)) {
    encodedStyle = "double";
    toolName = name.slice(PORTABLE_COLLABORATION_NAMESPACE.length + 2);
  } else if (namespace === null && name !== null && findMapping(metadata, name)) {
    encodedStyle = "omitted";
    toolName = name;
  }

  if (encodedStyle === null) return false;
  if (!toolName) {
    throw new PortableCompatibilityError("malformed_response", {
      fieldPath: `${fieldPath}.name`,
      providerId: metadata.providerId,
    });
  }

  const mapping = findMapping(metadata, toolName);
  if (!mapping) {
    throw new PortableCompatibilityError("missing_mapping", {
      fieldPath: `${fieldPath}.name`,
      providerId: metadata.providerId,
    });
  }

  if (encodedStyle === "double") {
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
  if (!Array.isArray(output)) return 0;
  let restored = 0;
  output.forEach((item, index) => {
    if (isRecord(item) && restoreFunctionCall(item, metadata, `${fieldPath}.${index}`)) {
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

  const restoredPayload = structuredClone(payload);
  let restoredCount = restoreOutputArray(restoredPayload.output, metadata, "output");
  if (isRecord(restoredPayload.response)) {
    restoredCount += restoreOutputArray(
      restoredPayload.response.output,
      metadata,
      "response.output"
    );
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
