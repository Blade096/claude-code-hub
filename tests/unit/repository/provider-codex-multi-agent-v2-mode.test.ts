import { describe, expect, test, vi } from "vitest";

vi.mock("server-only", () => ({}));

describe("Codex MultiAgentV2 provider mode transformer", () => {
  test("defaults existing rows to native and preserves stored modes", async () => {
    const { toProvider } = await import("@/repository/_shared/transformers");

    expect(toProvider({ id: 1, name: "legacy" }).codexMultiAgentV2Mode).toBe("native");
    expect(
      toProvider({ id: 2, name: "portable", codexMultiAgentV2Mode: "portable" })
        .codexMultiAgentV2Mode
    ).toBe("portable");
    expect(
      toProvider({ id: 3, name: "disabled", codexMultiAgentV2Mode: "disabled" })
        .codexMultiAgentV2Mode
    ).toBe("disabled");
  });
});
