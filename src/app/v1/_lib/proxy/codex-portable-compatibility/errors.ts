import { ProxyError } from "../errors";
import { translateProxyError } from "../proxy-error-i18n";
import type { PortableCompatibilityErrorCategory } from "./types";

export type PortableCompatibilityErrorCode =
  | "feature_disabled"
  | "provider_disabled"
  | "client_or_protocol_mismatch"
  | "opaque_content"
  | "name_collision"
  | "unknown_tool"
  | "missing_mapping"
  | "duplicate_mapping"
  | "ambiguous_mapping"
  | "malformed_response"
  | "response_identity_mismatch"
  | "provider_transport_unsupported";

const ERROR_CATEGORIES: Record<PortableCompatibilityErrorCode, PortableCompatibilityErrorCategory> =
  {
    feature_disabled: "compatibility_feature_disabled",
    provider_disabled: "compatibility_provider_disabled",
    client_or_protocol_mismatch: "compatibility_client_or_protocol_mismatch",
    opaque_content: "compatibility_opaque_content",
    name_collision: "compatibility_name_collision",
    unknown_tool: "compatibility_restore_failed",
    missing_mapping: "compatibility_restore_failed",
    duplicate_mapping: "compatibility_restore_failed",
    ambiguous_mapping: "compatibility_restore_failed",
    malformed_response: "compatibility_restore_failed",
    response_identity_mismatch: "compatibility_restore_failed",
    provider_transport_unsupported: "compatibility_transport_unsupported",
  };

export class PortableCompatibilityError extends ProxyError {
  readonly compatibilityCode: PortableCompatibilityErrorCode;
  readonly category: PortableCompatibilityErrorCategory;
  readonly fieldPath: string | null;
  readonly providerId: number | null;

  constructor(
    code: PortableCompatibilityErrorCode,
    options: { fieldPath?: string; providerId?: number } = {}
  ) {
    const category = ERROR_CATEGORIES[code];
    super(translateProxyError(category, "en"), 400);
    this.name = "PortableCompatibilityError";
    this.compatibilityCode = code;
    this.category = category;
    this.fieldPath = options.fieldPath ?? null;
    this.providerId = options.providerId ?? null;
  }

  get errorType(): string {
    return this.category;
  }

  toSafeDetails(): Record<string, unknown> {
    return {
      compatibilityCode: this.compatibilityCode,
      errorCategory: this.category,
      fieldPath: this.fieldPath,
      providerId: this.providerId,
    };
  }
}

export function isPortableCompatibilityError(error: unknown): error is PortableCompatibilityError {
  return error instanceof PortableCompatibilityError;
}
