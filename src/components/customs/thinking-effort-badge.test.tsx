import { describe, expect, test } from "vitest";
import {
  AnthropicEffortBadge,
  getAnthropicEffortBadgeClassName,
} from "@/components/customs/anthropic-effort-badge";
import {
  ThinkingEffortBadge,
  getThinkingEffortBadgeClassName,
} from "@/components/customs/thinking-effort-badge";

describe("ThinkingEffortBadge", () => {
  test("旧 Anthropic 导出复用统一实现", () => {
    expect(AnthropicEffortBadge).toBe(ThinkingEffortBadge);
    expect(getAnthropicEffortBadgeClassName).toBe(getThinkingEffortBadgeClassName);
  });

  test.each(["none", "minimal", "auto", "low", "medium", "high", "xhigh", "max"])(
    "%s 有明确样式",
    (effort) => {
      expect(getThinkingEffortBadgeClassName(effort)).not.toContain("bg-muted/40");
    }
  );
});
