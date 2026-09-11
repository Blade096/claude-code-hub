/**
 * 代理层的错误本地化边界（最小范围）。
 *
 * `/v1/*` 路由没有 next-intl 的 locale 上下文，所以这里只做两件事：
 * 1. 从 `Accept-Language` 解析出受支持的语言；
 * 2. 按稳定错误码返回本地化的通用文案。
 *
 * 对外绝不透传上游原始错误：上游细节只写日志与请求记录。
 * 既有 proxy 层的其它硬编码错误不在这里迁移，另行排期。
 */

export type ProxyErrorLocale = "zh-CN" | "zh-TW" | "en" | "ja" | "ru";

/** 受支持的 locale，顺序即无 Accept-Language 时的回退顺序。 */
const SUPPORTED_LOCALES: ProxyErrorLocale[] = ["zh-CN", "zh-TW", "en", "ja", "ru"];

const DEFAULT_LOCALE: ProxyErrorLocale = "zh-CN";

export type ProxyErrorCode = "remote_compaction_failed";

const PROXY_ERROR_MESSAGES: Record<ProxyErrorCode, Record<ProxyErrorLocale, string>> = {
  remote_compaction_failed: {
    "zh-CN": "远程压缩失败，请稍后重试。",
    "zh-TW": "遠端壓縮失敗，請稍後重試。",
    en: "Remote compaction failed. Please try again later.",
    ja: "リモート圧縮に失敗しました。しばらくしてから再試行してください。",
    ru: "Не удалось выполнить удалённое сжатие. Повторите попытку позже.",
  },
};

/** 把 `zh-cn`、`zh_Hant`、`en-US` 这类写法归一成受支持的 locale。 */
function normalizeLocaleTag(tag: string): ProxyErrorLocale | null {
  const normalized = tag.trim().toLowerCase().replace(/_/g, "-");
  if (!normalized) return null;

  if (normalized.startsWith("zh")) {
    if (normalized.includes("tw") || normalized.includes("hk") || normalized.includes("hant")) {
      return "zh-TW";
    }
    return "zh-CN";
  }
  if (normalized.startsWith("en")) return "en";
  if (normalized.startsWith("ja")) return "ja";
  if (normalized.startsWith("ru")) return "ru";
  return null;
}

/**
 * 解析 Accept-Language，按 q 值排序后取第一个受支持的语言。
 * 解析失败一律回退到默认语言，不抛错。
 */
export function resolveProxyErrorLocale(
  acceptLanguage: string | null | undefined
): ProxyErrorLocale {
  if (!acceptLanguage?.trim()) {
    return DEFAULT_LOCALE;
  }

  const candidates = acceptLanguage
    .split(",")
    .map((entry) => {
      const [tag, ...params] = entry.split(";");
      const qParam = params.find((param) => param.trim().startsWith("q="));
      const quality = qParam ? Number.parseFloat(qParam.split("=")[1] ?? "") : 1;
      return { tag: tag ?? "", quality: Number.isFinite(quality) ? quality : 0 };
    })
    .filter((candidate) => candidate.quality > 0)
    .sort((a, b) => b.quality - a.quality);

  for (const candidate of candidates) {
    const locale = normalizeLocaleTag(candidate.tag);
    if (locale) {
      return locale;
    }
  }

  return DEFAULT_LOCALE;
}

/** 按错误码与请求语言取本地化文案。错误码受类型约束，没有未知码回退。 */
export function translateProxyError(
  code: ProxyErrorCode,
  acceptLanguage: string | null | undefined
): string {
  const locale = resolveProxyErrorLocale(acceptLanguage);
  return PROXY_ERROR_MESSAGES[code][locale];
}

/** 供测试确认语言覆盖范围。 */
export function getSupportedProxyErrorLocales(): ProxyErrorLocale[] {
  return [...SUPPORTED_LOCALES];
}
