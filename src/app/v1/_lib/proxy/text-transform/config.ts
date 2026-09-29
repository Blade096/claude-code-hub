import {
  foldCase,
  type TextTransformConfig,
  textTransformConfigSchema,
} from "@/lib/text-transform/schema";
import { getEffectiveTextTransformSettings } from "@/lib/text-transform/settings";

export { foldCase, type TextTransformConfig } from "@/lib/text-transform/schema";

import { ProxyError } from "../errors";
import { translateProxyError } from "../proxy-error-i18n";

export class TextTransformError extends ProxyError {
  constructor(
    readonly reason:
      | "config"
      | "collision"
      | "residual"
      | "unsupported"
      | "response"
      | "unavailable",
    language?: string | null
  ) {
    super(
      translateProxyError(`text_transform_${reason}`, language),
      reason === "unavailable" ? 503 : reason === "response" ? 502 : 400
    );
    this.name = "TextTransformError";
  }
}

/** 配置快照归属于单次上游 attempt，不在重试之间共享可变映射。 */
export async function readTextTransformConfig(
  providerId: number,
  language?: string | null
): Promise<TextTransformConfig | null> {
  try {
    const { config } = await getEffectiveTextTransformSettings();
    return config.enabled && (!config.providerIds || config.providerIds.includes(providerId))
      ? config
      : null;
  } catch {
    throw new TextTransformError("unavailable", language);
  }
}

export function parseTextTransformConfig(
  raw: string,
  providerId: number,
  language?: string | null
): TextTransformConfig | null {
  try {
    const config = textTransformConfigSchema.parse(JSON.parse(raw));
    return config.enabled && (!config.providerIds || config.providerIds.includes(providerId))
      ? config
      : null;
  } catch {
    throw new TextTransformError("config", language);
  }
}

export class LiteralMatcher {
  private readonly rules: { from: string; to: string; normalized: string }[];
  constructor(config: TextTransformConfig, reverse = false) {
    this.caseSensitive = config.caseSensitive;
    this.rules = config.rules
      .map((r) => ({
        from: reverse ? r.target : r.source,
        to: reverse ? r.source : r.target,
        normalized: this.normalize(reverse ? r.target : r.source),
      }))
      .sort((a, b) => b.from.length - a.from.length);
  }
  private readonly caseSensitive: boolean;
  private normalize(s: string): string {
    return this.caseSensitive ? s : foldCase(s);
  }
  contains(text: string): boolean {
    const normalized = this.normalize(text);
    return this.rules.some((r) => normalized.includes(r.normalized));
  }
  replace(text: string): string {
    return this.consume(text, true).output;
  }
  /** 只保留可能构成更长匹配的尾部，禁止短代称抢先吞掉域名代称。 */
  consume(text: string, final = false): { output: string; tail: string } {
    const normalized = this.normalize(text);
    let output = "";
    let index = 0;
    while (index < text.length) {
      const rest = normalized.slice(index);
      if (
        !final &&
        this.rules.some((r) => r.normalized.length > rest.length && r.normalized.startsWith(rest))
      ) {
        return { output, tail: text.slice(index) };
      }
      const rule = this.rules.find((r) => normalized.startsWith(r.normalized, index));
      if (rule) {
        output += rule.to;
        index += rule.from.length;
      } else {
        output += text[index];
        index++;
      }
    }
    return { output, tail: "" };
  }
}
