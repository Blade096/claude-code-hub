import { describe, expect, it } from "vitest";
import {
  buildProviderBatchApplyUpdates,
  normalizeProviderBatchPatchDraft,
} from "@/lib/provider-patch-contract";

describe("provider-patch-contract - codex service tier", () => {
  it("normalizes codex_service_tier_preference patch draft", () => {
    const result = normalizeProviderBatchPatchDraft({
      codex_service_tier_preference: { set: "priority" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.codex_service_tier_preference).toEqual({
      mode: "set",
      value: "priority",
    });
  });

  it("builds apply updates for codex_service_tier_preference", () => {
    const normalized = normalizeProviderBatchPatchDraft({
      codex_service_tier_preference: { set: "priority" },
    });

    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;

    const updates = buildProviderBatchApplyUpdates(normalized.data);
    expect(updates.ok).toBe(true);
    if (!updates.ok) return;

    expect(updates.data.codex_service_tier_preference).toBe("priority");
  });

  it("builds apply updates for codex_image_generation_preference", () => {
    const normalized = normalizeProviderBatchPatchDraft({
      codex_image_generation_preference: { set: "false" },
    });

    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;

    const updates = buildProviderBatchApplyUpdates(normalized.data);
    expect(updates.ok).toBe(true);
    if (!updates.ok) return;

    expect(updates.data.codex_image_generation_preference).toBe("false");
  });
});

describe("provider-patch-contract - remote compaction toggle", () => {
  it("normalizes the remote_compaction_v2 patch draft", () => {
    const normalized = normalizeProviderBatchPatchDraft({
      remote_compaction_v2: { set: true },
    });

    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;

    const updates = buildProviderBatchApplyUpdates(normalized.data);
    expect(updates.ok).toBe(true);
    if (!updates.ok) return;

    expect(updates.data.remote_compaction_v2).toBe(true);
  });

  it("rejects a non-boolean value for remote_compaction_v2", () => {
    const normalized = normalizeProviderBatchPatchDraft({
      remote_compaction_v2: { set: "yes" },
    });

    expect(normalized.ok).toBe(false);
  });
});
