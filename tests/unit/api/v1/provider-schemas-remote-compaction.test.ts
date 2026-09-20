import { describe, expect, test } from "vitest";

import { ProviderCreateSchema, ProviderUpdateSchema } from "@/lib/api/v1/schemas/providers";

describe("v1 Provider schemas - remote compaction", () => {
  test("ProviderCreateSchema accepts remote_compaction_v2", () => {
    expect(
      ProviderCreateSchema.safeParse({
        name: "test-provider",
        url: "https://api.example.com",
        key: "test-key",
        remote_compaction_v2: true,
      }).success
    ).toBe(true);
  });

  test("ProviderUpdateSchema accepts remote_compaction_v2", () => {
    expect(ProviderUpdateSchema.safeParse({ remote_compaction_v2: true }).success).toBe(true);
  });

  test("ProviderUpdateSchema rejects a non-boolean remote_compaction_v2", () => {
    expect(ProviderUpdateSchema.safeParse({ remote_compaction_v2: "true" }).success).toBe(false);
  });
});

describe("v1 Provider schemas - Codex MultiAgentV2 mode", () => {
  test("ProviderCreateSchema defaults to native", () => {
    const result = ProviderCreateSchema.safeParse({
      name: "test-provider",
      url: "https://api.example.com",
      key: "test-key",
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.codex_multi_agent_v2_mode).toBe("native");
  });

  test.each(["native", "portable", "disabled"] as const)(
    "ProviderUpdateSchema accepts %s",
    (mode) => {
      expect(ProviderUpdateSchema.safeParse({ codex_multi_agent_v2_mode: mode }).success).toBe(
        true
      );
    }
  );

  test("ProviderUpdateSchema rejects an unknown mode", () => {
    expect(ProviderUpdateSchema.safeParse({ codex_multi_agent_v2_mode: "automatic" }).success).toBe(
      false
    );
  });

  test("ProviderUpdateSchema does not default an omitted mode", () => {
    const result = ProviderUpdateSchema.parse({ name: "unchanged-mode" });
    expect(result).not.toHaveProperty("codex_multi_agent_v2_mode");
  });
});
