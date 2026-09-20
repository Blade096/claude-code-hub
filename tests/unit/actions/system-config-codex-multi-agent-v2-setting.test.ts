import { describe, expect, test, vi } from "vitest";

vi.mock("server-only", () => ({}));

describe("enableCodexMultiAgentV2Compatibility system setting", () => {
  test("defaults to disabled in the DB-row transformer", async () => {
    const { toSystemSettings } = await import("@/repository/_shared/transformers");

    expect(toSystemSettings(undefined).enableCodexMultiAgentV2Compatibility).toBe(false);
    expect(
      toSystemSettings({ id: 1, siteTitle: "Claude Code Hub" }).enableCodexMultiAgentV2Compatibility
    ).toBe(false);
    expect(
      toSystemSettings({ id: 1, enableCodexMultiAgentV2Compatibility: true })
        .enableCodexMultiAgentV2Compatibility
    ).toBe(true);
  });

  test("is accepted by the settings update validation schema", async () => {
    const { UpdateSystemSettingsSchema } = await import("@/lib/validation/schemas");

    const parsed = UpdateSystemSettingsSchema.parse({
      enableCodexMultiAgentV2Compatibility: true,
    });
    expect(parsed.enableCodexMultiAgentV2Compatibility).toBe(true);
    expect(
      UpdateSystemSettingsSchema.parse({}).enableCodexMultiAgentV2Compatibility
    ).toBeUndefined();
  });

  test("is exposed by the v1 system settings response schema", async () => {
    const { SystemSettingsSchema } = await import("@/lib/api/v1/schemas/system-config");

    expect(Object.keys(SystemSettingsSchema.shape)).toContain(
      "enableCodexMultiAgentV2Compatibility"
    );
  });
});
