import { extractAnthropicEffortInfo } from "@/lib/utils/anthropic-effort";
import { extractCodexReasoningEffortInfo } from "@/lib/utils/codex-reasoning-effort";
import { extractOpenAIReasoningEffortFromSpecialSettings } from "@/lib/utils/openai-reasoning-effort";
import type { SpecialSetting } from "@/types/special-settings";

export type ThinkingEffortSource = "codex" | "openai" | "anthropic";

export type ThinkingEffortMessageNamespace = "reasoningEffort" | "reasoningEffortOpenai" | "effort";

export function getThinkingEffortMessageNamespace(
  source: ThinkingEffortSource
): ThinkingEffortMessageNamespace {
  switch (source) {
    case "codex":
      return "reasoningEffort";
    case "openai":
      return "reasoningEffortOpenai";
    case "anthropic":
      return "effort";
  }
}

export interface ThinkingEffortInfo {
  source: ThinkingEffortSource;
  requestedEffort: string | null;
  effectiveEffort: string | null;
  isOverridden: boolean;
}

export function extractThinkingEffortInfo(
  specialSettings: SpecialSetting[] | null | undefined
): ThinkingEffortInfo | null {
  const codexInfo = extractCodexReasoningEffortInfo(specialSettings);
  if (codexInfo) return { source: "codex", ...codexInfo };

  const openaiInfo = extractOpenAIReasoningEffortFromSpecialSettings(specialSettings);
  if (openaiInfo) {
    return {
      source: "openai",
      requestedEffort: openaiInfo.effort,
      effectiveEffort: openaiInfo.effort,
      isOverridden: false,
    };
  }

  const anthropicInfo = extractAnthropicEffortInfo(specialSettings);
  if (!anthropicInfo) return null;

  return {
    source: "anthropic",
    requestedEffort: anthropicInfo.originalEffort,
    effectiveEffort: anthropicInfo.isOverridden
      ? anthropicInfo.overriddenEffort
      : anthropicInfo.originalEffort,
    isOverridden: anthropicInfo.isOverridden,
  };
}
