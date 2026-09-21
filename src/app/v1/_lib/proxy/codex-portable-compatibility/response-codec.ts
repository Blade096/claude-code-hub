import { translateProxyError } from "../proxy-error-i18n";
import {
  capturePortableResponseId,
  markPortableResponseFailed,
  markPortableResponseStarted,
  markPortableResponseSucceeded,
  markPortableUpstreamResponseFailed,
  portableAuditCorrelation,
} from "./audit";
import { PortableCompatibilityError } from "./errors";
import { isRecord } from "./guards";
import { transformPortableSseResponse } from "./sse-transform";
import {
  CODEX_COLLABORATION_NAMESPACE,
  PORTABLE_COLLABORATION_ACTIONS,
  PORTABLE_COLLABORATION_NAMESPACE,
  type PortableCollaborationAction,
  type PortableResponseRestoreState,
  type PortableToolIdentityMapping,
  type PortableTransformationMetadata,
} from "./types";

const ORIGINAL_COLLABORATION_NAMESPACE = CODEX_COLLABORATION_NAMESPACE;
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
      mapping.originalName.length === 0
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
  const matches = metadata.toolMappings.filter(
    (mapping) =>
      mapping.originalName === name &&
      (omittedNamespace || mapping.encodedNamespace === encodedNamespace)
  );
  if (matches.length === 0) {
    throw new PortableCompatibilityError(
      isCollaborationAction(name) ? "missing_mapping" : "unknown_tool",
      {
        fieldPath,
        providerId: metadata.providerId,
      }
    );
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

type RestoredFunctionCall = {
  identity: string;
  restored: boolean;
};

function canonicalIdentity(namespace: string | null, name: string): string {
  return `${namespace ?? ""}\u0000${name}`;
}

function restoreFunctionCall(
  item: Record<string, unknown>,
  metadata: PortableTransformationMetadata,
  fieldPath: string
): RestoredFunctionCall | null {
  if (item.type !== "function_call" && item.type !== "custom_tool_call") return null;

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

  if (namespace === ORIGINAL_COLLABORATION_NAMESPACE) {
    const mapped = metadata.toolMappings.some(
      (mapping) => mapping.originalNamespace === namespace && mapping.originalName === name
    );
    if (!mapped) {
      throw new PortableCompatibilityError(
        isCollaborationAction(name) ? "missing_mapping" : "unknown_tool",
        {
          fieldPath: `${fieldPath}.name`,
          providerId: metadata.providerId,
        }
      );
    }
    return { identity: canonicalIdentity(namespace, name), restored: false };
  }
  if (namespace === null && name.startsWith(`${ORIGINAL_COLLABORATION_NAMESPACE}__`)) {
    const originalName = name.slice(ORIGINAL_COLLABORATION_NAMESPACE.length + 2);
    const mapped = metadata.toolMappings.some(
      (mapping) =>
        mapping.originalNamespace === ORIGINAL_COLLABORATION_NAMESPACE &&
        mapping.originalName === originalName
    );
    if (!mapped) {
      throw new PortableCompatibilityError(
        isCollaborationAction(originalName) ? "missing_mapping" : "unknown_tool",
        {
          fieldPath: `${fieldPath}.name`,
          providerId: metadata.providerId,
        }
      );
    }
    return {
      identity: canonicalIdentity(ORIGINAL_COLLABORATION_NAMESPACE, originalName),
      restored: false,
    };
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
  } else if (
    namespace === null &&
    (isCollaborationAction(name) ||
      metadata.toolMappings.some((mapping) => mapping.originalName === name))
  ) {
    style = "omitted";
    actionName = name;
  }

  if (style === null) {
    return null;
  }
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
  return {
    identity: canonicalIdentity(mapping.originalNamespace, mapping.originalName),
    restored: true,
  };
}

function callKeys(item: Record<string, unknown>, outputIndex?: unknown): string[] {
  const keys: string[] = [];
  if (typeof item.id === "string" && item.id.length > 0) keys.push(`item:${item.id}`);
  if (typeof item.call_id === "string" && item.call_id.length > 0) {
    keys.push(`call:${item.call_id}`);
  }
  if (typeof outputIndex === "number" && Number.isInteger(outputIndex) && outputIndex >= 0) {
    keys.push(`output:${outputIndex}`);
  }
  return keys;
}

function registerCallIdentity(
  state: PortableResponseRestoreState,
  keys: string[],
  identity: string,
  metadata: PortableTransformationMetadata,
  fieldPath: string
): void {
  if (keys.length === 0) {
    throw new PortableCompatibilityError("malformed_response", {
      fieldPath,
      providerId: metadata.providerId,
    });
  }
  const existingBindings = new Set(
    keys.map((key) => state.callIdentities.get(key)).filter((value) => value !== undefined)
  );
  if (existingBindings.size > 1) {
    throw new PortableCompatibilityError("response_identity_mismatch", {
      fieldPath,
      providerId: metadata.providerId,
    });
  }
  const existingBinding = existingBindings.values().next().value;
  const binding = existingBinding ?? { callToken: keys[0], toolIdentity: identity };
  if (existingBinding !== undefined && existingBinding.toolIdentity !== identity) {
    throw new PortableCompatibilityError("response_identity_mismatch", {
      fieldPath,
      providerId: metadata.providerId,
    });
  }
  for (const key of keys) state.callIdentities.set(key, binding);
}

function requireKnownCallIdentity(
  state: PortableResponseRestoreState,
  keys: string[],
  metadata: PortableTransformationMetadata,
  fieldPath: string
): void {
  if (keys.length === 0) {
    throw new PortableCompatibilityError("malformed_response", {
      fieldPath,
      providerId: metadata.providerId,
    });
  }
  const bindings = keys.map((key) => state.callIdentities.get(key));
  if (bindings.every((binding) => binding === undefined)) return;
  if (bindings.some((binding) => binding === undefined) || new Set(bindings).size !== 1) {
    throw new PortableCompatibilityError("response_identity_mismatch", {
      fieldPath,
      providerId: metadata.providerId,
    });
  }
}

function restoreOutputArray(
  output: unknown,
  metadata: PortableTransformationMetadata,
  fieldPath: string,
  state?: PortableResponseRestoreState
): number {
  if (!Array.isArray(output)) {
    throw new PortableCompatibilityError("malformed_response", {
      fieldPath,
      providerId: metadata.providerId,
    });
  }
  let restoredCount = 0;
  output.forEach((item, index) => {
    if (!isRecord(item)) {
      throw new PortableCompatibilityError("malformed_response", {
        fieldPath: `${fieldPath}.${index}`,
        providerId: metadata.providerId,
      });
    }
    const restoredCall = restoreFunctionCall(item, metadata, `${fieldPath}.${index}`);
    if (restoredCall && state) {
      registerCallIdentity(
        state,
        callKeys(item, index),
        restoredCall.identity,
        metadata,
        `${fieldPath}.${index}`
      );
    }
    if (restoredCall?.restored) {
      restoredCount += 1;
    }
  });
  return restoredCount;
}

function eventCallKeys(event: Record<string, unknown>): string[] {
  const keys: string[] = [];
  if (typeof event.item_id === "string" && event.item_id.length > 0) {
    keys.push(`item:${event.item_id}`);
  }
  if (typeof event.call_id === "string" && event.call_id.length > 0) {
    keys.push(`call:${event.call_id}`);
  }
  if (
    typeof event.output_index === "number" &&
    Number.isInteger(event.output_index) &&
    event.output_index >= 0
  ) {
    keys.push(`output:${event.output_index}`);
  }
  return keys;
}

export function createPortableResponseRestoreState(): PortableResponseRestoreState {
  return { callIdentities: new Map() };
}

export function restorePortableCompatibilityEventPayload(
  payload: unknown,
  metadata: PortableTransformationMetadata,
  state: PortableResponseRestoreState
): { payload: unknown; restoredCount: number } {
  if (!isRecord(payload) || typeof payload.type !== "string") {
    throw new PortableCompatibilityError("malformed_response", {
      fieldPath: "event",
      providerId: metadata.providerId,
    });
  }
  validateMappings(metadata);
  capturePortableResponseId(metadata, payload);

  if (metadata.toolMappings.length === 0) {
    return { payload: structuredClone(payload), restoredCount: 0 };
  }

  const restoredPayload = structuredClone(payload);
  const eventType = restoredPayload.type;

  if (eventType === "response.output_item.added" || eventType === "response.output_item.done") {
    if (!isRecord(restoredPayload.item)) {
      throw new PortableCompatibilityError("malformed_response", {
        fieldPath: "event.item",
        providerId: metadata.providerId,
      });
    }
    const restoredCall = restoreFunctionCall(restoredPayload.item, metadata, "event.item");
    if (!restoredCall) return { payload: restoredPayload, restoredCount: 0 };

    const keys = [
      ...callKeys(restoredPayload.item, restoredPayload.output_index),
      ...eventCallKeys(restoredPayload),
    ];
    registerCallIdentity(state, [...new Set(keys)], restoredCall.identity, metadata, "event.item");
    return { payload: restoredPayload, restoredCount: restoredCall.restored ? 1 : 0 };
  }

  if (
    eventType === "response.function_call_arguments.delta" ||
    eventType === "response.function_call_arguments.done"
  ) {
    const valueKey = eventType === "response.function_call_arguments.delta" ? "delta" : "arguments";
    if (typeof restoredPayload[valueKey] !== "string") {
      throw new PortableCompatibilityError("malformed_response", {
        fieldPath: `event.${valueKey}`,
        providerId: metadata.providerId,
      });
    }
    requireKnownCallIdentity(state, eventCallKeys(restoredPayload), metadata, "event.item_id");
    return { payload: restoredPayload, restoredCount: 0 };
  }

  if (eventType === "response.completed") {
    if (!isRecord(restoredPayload.response)) {
      throw new PortableCompatibilityError("malformed_response", {
        fieldPath: "event.response",
        providerId: metadata.providerId,
      });
    }
    return {
      payload: restoredPayload,
      restoredCount: restoreOutputArray(
        restoredPayload.response.output,
        metadata,
        "event.response.output",
        state
      ),
    };
  }

  return { payload: restoredPayload, restoredCount: 0 };
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
  capturePortableResponseId(metadata, payload);

  if (metadata.toolMappings.length === 0) {
    return { payload: structuredClone(payload), restoredCount: 0 };
  }

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
  metadata: PortableTransformationMetadata,
  lifecycle: { onFinalize?: () => void; acceptLanguage?: string | null } = {}
): Promise<Response> {
  markPortableResponseStarted(metadata, response);
  if (!response.ok) {
    metadata.responseRestore = "not_needed";
    metadata.audit.responseRestore = "not_needed";
    markPortableUpstreamResponseFailed(metadata);
    lifecycle.onFinalize?.();
    return response;
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("text/event-stream")) {
    const state = createPortableResponseRestoreState();
    let restoredCount = 0;
    let failed = false;
    let terminal: "completed" | "failed" | null = null;
    const failRestore = (error: unknown) => {
      if (failed) return;
      failed = true;
      const compatibilityError =
        error instanceof PortableCompatibilityError
          ? error
          : new PortableCompatibilityError("malformed_response", {
              providerId: metadata.providerId,
            });
      metadata.responseRestore = "failed";
      markPortableResponseFailed(metadata, compatibilityError);
    };
    return transformPortableSseResponse(response, {
      transformJson(payload) {
        if (terminal !== null) {
          throw new PortableCompatibilityError("malformed_response", {
            fieldPath: "event.after_terminal",
            providerId: metadata.providerId,
          });
        }
        const restored = restorePortableCompatibilityEventPayload(payload, metadata, state);
        restoredCount += restored.restoredCount;
        if (isRecord(payload)) {
          if (payload.type === "response.completed") terminal = "completed";
          if (payload.type === "response.failed" || payload.type === "response.incomplete") {
            terminal = "failed";
          }
        }
        return { payload: restored.payload, changed: restored.restoredCount > 0 };
      },
      onFailure(error) {
        failRestore(error);
      },
      validateEnd() {
        if (terminal === null) {
          throw new PortableCompatibilityError("malformed_response", {
            fieldPath: "event.terminal",
            providerId: metadata.providerId,
          });
        }
      },
      onCancel() {
        if (terminal === null) {
          failRestore(
            new PortableCompatibilityError("malformed_response", {
              fieldPath: "response.cancelled",
              providerId: metadata.providerId,
            })
          );
        }
      },
      onFinalize() {
        if (!failed) {
          metadata.responseRestore = restoredCount > 0 ? "restored" : "not_needed";
          metadata.audit.responseRestore = metadata.responseRestore;
          if (terminal === "completed") markPortableResponseSucceeded(metadata);
          else markPortableUpstreamResponseFailed(metadata);
        }
        lifecycle.onFinalize?.();
      },
      safeError(error) {
        const compatibilityError =
          error instanceof PortableCompatibilityError
            ? error
            : new PortableCompatibilityError("malformed_response", {
                providerId: metadata.providerId,
              });
        return {
          type: compatibilityError.errorType,
          message: translateProxyError(compatibilityError.category, lifecycle.acceptLanguage),
          details: {
            ...compatibilityError.toSafeDetails(),
            ...portableAuditCorrelation(metadata.audit),
          },
        };
      },
    });
  }

  try {
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

    capturePortableResponseId(metadata, payload);
    const payloadRecord = isRecord(payload) ? payload : null;
    const nestedResponse =
      payloadRecord && isRecord(payloadRecord.response) ? payloadRecord.response : null;
    const responseStatus = nestedResponse?.status ?? payloadRecord?.status;
    if (
      responseStatus === "failed" ||
      responseStatus === "incomplete" ||
      responseStatus === "cancelled"
    ) {
      metadata.responseRestore = "not_needed";
      metadata.audit.responseRestore = "not_needed";
      markPortableUpstreamResponseFailed(metadata);
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      return new Response(JSON.stringify(payload), {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
    if (typeof responseStatus === "string" && responseStatus !== "completed") {
      throw new PortableCompatibilityError("malformed_response", {
        fieldPath: nestedResponse ? "response.status" : "status",
        providerId: metadata.providerId,
      });
    }

    const restored = restorePortableCompatibilityPayload(payload, metadata);
    metadata.responseRestore = restored.restoredCount > 0 ? "restored" : "not_needed";
    metadata.audit.responseRestore = metadata.responseRestore;
    markPortableResponseSucceeded(metadata);
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    return new Response(JSON.stringify(restored.payload), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch (error) {
    const compatibilityError =
      error instanceof PortableCompatibilityError
        ? error
        : new PortableCompatibilityError("malformed_response", {
            providerId: metadata.providerId,
          });
    metadata.responseRestore = "failed";
    markPortableResponseFailed(metadata, compatibilityError);
    throw error;
  } finally {
    lifecycle.onFinalize?.();
  }
}
