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
