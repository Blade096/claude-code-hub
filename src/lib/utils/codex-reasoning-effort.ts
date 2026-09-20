import type { SpecialSetting } from "@/types/special-settings";

export interface CodexReasoningEffortInfo {
  requestedEffort: string | null;
  effectiveEffort: string;
  isOverridden: boolean;
}

function normalizeCodexReasoningEffort(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function extractCodexReasoningEffortFromRequestBody(requestBody: unknown): string | null {
  if (!requestBody || typeof requestBody !== "object" || Array.isArray(requestBody)) return null;

  const reasoning = (requestBody as Record<string, unknown>).reasoning;
  if (!reasoning || typeof reasoning !== "object" || Array.isArray(reasoning)) return null;

  return normalizeCodexReasoningEffort((reasoning as Record<string, unknown>).effort);
}

export function extractCodexReasoningEffortFromSpecialSettings(
  specialSettings: SpecialSetting[] | null | undefined
): string | null {
  if (!Array.isArray(specialSettings)) return null;

  for (const setting of specialSettings) {
    if (setting.type !== "codex_reasoning_effort") continue;
    const effort = normalizeCodexReasoningEffort(setting.effort);
    if (effort) return effort;
  }
  return null;
}

export function extractCodexReasoningEffortInfo(
  specialSettings: SpecialSetting[] | null | undefined
): CodexReasoningEffortInfo | null {
  if (!Array.isArray(specialSettings) || specialSettings.length === 0) return null;

  const requestedEffort = extractCodexReasoningEffortFromSpecialSettings(specialSettings);
  let hasOverrideAudit = false;
  let initialBefore: string | null = null;
  let finalAfter: string | null = null;

  for (const setting of specialSettings) {
    if (setting.type !== "provider_parameter_override" || setting.providerType !== "codex") {
      continue;
    }
    const change = setting.changes?.find((item) => item.path === "reasoning.effort");
    if (!change) continue;

    if (!hasOverrideAudit) initialBefore = normalizeCodexReasoningEffort(change.before);
    finalAfter = normalizeCodexReasoningEffort(change.after);
    hasOverrideAudit = true;
  }

  const originalEffort = requestedEffort ?? initialBefore;
  const effectiveEffort = finalAfter ?? originalEffort;
  if (!effectiveEffort) return null;

  return {
    requestedEffort: originalEffort,
    effectiveEffort,
    isOverridden: hasOverrideAudit && originalEffort !== effectiveEffort,
  };
}
