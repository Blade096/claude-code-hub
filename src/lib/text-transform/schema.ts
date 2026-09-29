import { z } from "zod";

export function foldCase(text: string): string {
  return text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

export const textTransformConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    providerIds: z.array(z.number().int().positive()).min(1).optional(),
    caseSensitive: z.boolean().default(true),
    rules: z
      .array(
        z
          .object({ source: z.string().min(1).max(256), target: z.string().min(1).max(256) })
          .strict()
      )
      .max(100),
  })
  .strict()
  .superRefine((config, ctx) => {
    const normalize = (s: string) => (config.caseSensitive ? s : foldCase(s));
    const sources = config.rules.map((r) => normalize(r.source));
    const targets = config.rules.map((r) => normalize(r.target));
    if (
      (config.enabled && !config.rules.length) ||
      new Set(sources).size !== sources.length ||
      new Set(targets).size !== targets.length ||
      sources.some((s) => targets.some((t) => t.includes(s) || s.includes(t))) ||
      config.rules.some(
        (r) =>
          /["\\]/.test(r.source + r.target) ||
          [...(r.source + r.target)].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
      )
    ) {
      ctx.addIssue({ code: "custom", path: ["rules"], message: "text_transform_config" });
    }
  });

export type TextTransformConfig = z.infer<typeof textTransformConfigSchema>;
export type TextTransformSettings = {
  config: TextTransformConfig;
  revision: number;
  source: "database" | "environment" | "default";
};
export const emptyTextTransformConfig: TextTransformConfig = {
  enabled: false,
  caseSensitive: true,
  rules: [],
};
