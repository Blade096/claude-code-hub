import { describe, expect, test } from "vitest";
import { extractCodexReasoningEffortInfo } from "@/lib/utils/codex-reasoning-effort";
import { extractOpenAIReasoningEffortFromRequestBody } from "@/lib/utils/openai-reasoning-effort";
import {
  extractThinkingEffortInfo,
  getThinkingEffortMessageNamespace,
} from "@/lib/utils/thinking-effort";

describe("思考强度解析", () => {
  test.each([
    ["codex", "reasoningEffort"],
    ["openai", "reasoningEffortOpenai"],
    ["anthropic", "effort"],
  ] as const)("%s 使用统一的翻译命名空间", (source, expected) => {
    expect(getThinkingEffortMessageNamespace(source)).toBe(expected);
  });

  test("Codex 合并请求值与最终供应商覆写值", () => {
    const result = extractCodexReasoningEffortInfo([
      { type: "codex_reasoning_effort", scope: "request", hit: true, effort: "low" },
      {
        type: "provider_parameter_override",
        scope: "provider",
        providerId: 1,
        providerName: "Codex A",
        providerType: "codex",
        hit: true,
        changed: true,
        changes: [{ path: "reasoning.effort", before: "low", after: "high", changed: true }],
      },
      {
        type: "provider_parameter_override",
        scope: "provider",
        providerId: 2,
        providerName: "Codex B",
        providerType: "codex",
        hit: true,
        changed: true,
        changes: [{ path: "reasoning.effort", before: "high", after: "max", changed: true }],
      },
    ]);

    expect(result).toEqual({
      requestedEffort: "low",
      effectiveEffort: "max",
      isOverridden: true,
    });
  });

  test("Codex 兼容只有供应商覆写审计的历史记录", () => {
    expect(
      extractCodexReasoningEffortInfo([
        {
          type: "provider_parameter_override",
          scope: "provider",
          providerId: 1,
          providerName: "Codex",
          providerType: "codex",
          hit: true,
          changed: false,
          changes: [
            { path: "reasoning.effort", before: "medium", after: "medium", changed: false },
          ],
        },
      ])
    ).toEqual({
      requestedEffort: "medium",
      effectiveEffort: "medium",
      isOverridden: false,
    });
  });

  test("OpenAI 顶层 reasoning_effort 优先于嵌套字段", () => {
    expect(
      extractOpenAIReasoningEffortFromRequestBody({
        reasoning_effort: "high",
        reasoning: { effort: "low" },
      })
    ).toEqual({ effort: "high", source: "reasoning_effort" });
  });

  test("OpenAI 顶层无效时读取 reasoning.effort", () => {
    expect(
      extractOpenAIReasoningEffortFromRequestBody({
        reasoning_effort: " ",
        reasoning: { effort: "xhigh" },
      })
    ).toEqual({ effort: "xhigh", source: "reasoning.effort" });
  });

  test("统一提取按 Codex、OpenAI、Anthropic 顺序识别来源", () => {
    expect(
      extractThinkingEffortInfo([
        {
          type: "openai_reasoning_effort",
          scope: "request",
          hit: true,
          effort: "high",
          source: "reasoning_effort",
        },
      ])
    ).toEqual({
      source: "openai",
      requestedEffort: "high",
      effectiveEffort: "high",
      isOverridden: false,
    });
  });
});
