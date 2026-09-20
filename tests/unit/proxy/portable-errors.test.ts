import {
  PortableCompatibilityError,
  type PortableCompatibilityErrorCode,
} from "@/app/v1/_lib/proxy/codex-portable-compatibility/errors";
import { describe, expect, test } from "vitest";

describe("portable compatibility stable errors", () => {
  test.each<[PortableCompatibilityErrorCode, string]>([
    ["feature_disabled", "compatibility_feature_disabled"],
    ["provider_disabled", "compatibility_provider_disabled"],
    ["client_or_protocol_mismatch", "compatibility_client_or_protocol_mismatch"],
    ["opaque_content", "compatibility_opaque_content"],
    ["name_collision", "compatibility_name_collision"],
    ["unknown_tool", "compatibility_restore_failed"],
    ["missing_mapping", "compatibility_restore_failed"],
    ["duplicate_mapping", "compatibility_restore_failed"],
    ["ambiguous_mapping", "compatibility_restore_failed"],
    ["malformed_response", "compatibility_restore_failed"],
    ["response_identity_mismatch", "compatibility_restore_failed"],
    ["provider_transport_unsupported", "compatibility_transport_unsupported"],
  ])("maps %s to %s without carrying content", (code, category) => {
    const sentinel = "PORTABLE_TASK_SENTINEL_ERROR_6F0C";
    const error = new PortableCompatibilityError(code, {
      fieldPath: "input[0].content",
      providerId: 42,
    });

    expect(error.errorType).toBe(category);
    expect(error.category).toBe(category);
    expect(error.toSafeDetails()).toEqual({
      compatibilityCode: code,
      errorCategory: category,
      fieldPath: "input[0].content",
      providerId: 42,
    });
    expect(JSON.stringify(error)).not.toContain(sentinel);
    expect(error.message).not.toContain(sentinel);
  });
});
