import type { OpenAIReasoningEffortFieldSource, SpecialSetting } from "@/types/special-settings";

export interface OpenAIReasoningEffortExtraction {
  effort: string;
  source: OpenAIReasoningEffortFieldSource;
}

function normalizeOpenAIReasoningEffort(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.trim().length > 0 ? value : null;
}

export function extractOpenAIReasoningEffortFromRequestBody(
  requestBody: unknown
): OpenAIReasoningEffortExtraction | null {
  if (!requestBody || typeof requestBody !== "object" || Array.isArray(requestBody)) return null;

  const record = requestBody as Record<string, unknown>;
  const topLevel = normalizeOpenAIReasoningEffort(record.reasoning_effort);
  if (topLevel) return { effort: topLevel, source: "reasoning_effort" };

  const reasoning = record.reasoning;
  if (!reasoning || typeof reasoning !== "object" || Array.isArray(reasoning)) return null;

  const nested = normalizeOpenAIReasoningEffort((reasoning as Record<string, unknown>).effort);
  return nested ? { effort: nested, source: "reasoning.effort" } : null;
}

export function extractOpenAIReasoningEffortFromSpecialSettings(
  specialSettings: SpecialSetting[] | null | undefined
): OpenAIReasoningEffortExtraction | null {
  if (!Array.isArray(specialSettings)) return null;

  for (const setting of specialSettings) {
    if (
      setting.type === "openai_reasoning_effort" &&
      typeof setting.effort === "string" &&
      setting.effort.trim().length > 0
    ) {
      return { effort: setting.effort, source: setting.source };
    }
  }
  return null;
}
