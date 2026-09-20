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

export type ProxyErrorCode =
  | "remote_compaction_failed"
  | "compatibility_feature_disabled"
  | "compatibility_provider_disabled"
  | "compatibility_client_or_protocol_mismatch"
  | "compatibility_opaque_content"
  | "compatibility_name_collision"
  | "compatibility_restore_failed"
  | "compatibility_transport_unsupported";

const PROXY_ERROR_MESSAGES: Record<ProxyErrorCode, Record<ProxyErrorLocale, string>> = {
  remote_compaction_failed: {
    "zh-CN": "远程压缩失败，请稍后重试。",
    "zh-TW": "遠端壓縮失敗，請稍後重試。",
    en: "Remote compaction failed. Please try again later.",
    ja: "リモート圧縮に失敗しました。しばらくしてから再試行してください。",
    ru: "Не удалось выполнить удалённое сжатие. Повторите попытку позже.",
  },
  compatibility_feature_disabled: {
    "zh-CN": "Codex MultiAgentV2 portable compatibility 尚未启用。",
    "zh-TW": "Codex MultiAgentV2 portable compatibility 尚未啟用。",
    en: "Codex MultiAgentV2 portable compatibility is not enabled.",
    ja: "Codex MultiAgentV2 portable compatibility は有効になっていません。",
    ru: "Совместимость Codex MultiAgentV2 portable не включена.",
  },
  compatibility_provider_disabled: {
    "zh-CN": "所选 Provider 已禁用 Codex MultiAgentV2 请求。",
    "zh-TW": "所選 Provider 已停用 Codex MultiAgentV2 請求。",
    en: "The selected provider has disabled Codex MultiAgentV2 requests.",
    ja: "選択した Provider では Codex MultiAgentV2 リクエストが無効です。",
    ru: "Выбранный поставщик отключил запросы Codex MultiAgentV2.",
  },
  compatibility_client_or_protocol_mismatch: {
    "zh-CN": "当前客户端或协议不支持 Codex MultiAgentV2 portable compatibility。",
    "zh-TW": "目前用戶端或協定不支援 Codex MultiAgentV2 portable compatibility。",
    en: "The client or protocol is not supported by Codex MultiAgentV2 portable compatibility.",
    ja: "現在のクライアントまたはプロトコルは Codex MultiAgentV2 portable compatibility に対応していません。",
    ru: "Клиент или протокол не поддерживается режимом Codex MultiAgentV2 portable.",
  },
  compatibility_opaque_content: {
    "zh-CN": "Portable 输入包含无法读取的 opaque content。",
    "zh-TW": "Portable 輸入包含無法讀取的 opaque content。",
    en: "The portable input contains unreadable opaque content.",
    ja: "Portable 入力に読み取れない opaque content が含まれています。",
    ru: "Portable-ввод содержит нечитаемые непрозрачные данные.",
  },
  compatibility_name_collision: {
    "zh-CN": "Portable 工具名称发生冲突或无法唯一解析。",
    "zh-TW": "Portable 工具名稱發生衝突或無法唯一解析。",
    en: "Portable tool names conflict or cannot be resolved uniquely.",
    ja: "Portable ツール名が競合しているか、一意に解決できません。",
    ru: "Имена portable-инструментов конфликтуют или определяются неоднозначно.",
  },
  compatibility_restore_failed: {
    "zh-CN": "Portable 响应恢复失败。",
    "zh-TW": "Portable 回應還原失敗。",
    en: "The portable response could not be restored.",
    ja: "Portable レスポンスを復元できませんでした。",
    ru: "Не удалось восстановить portable-ответ.",
  },
  compatibility_transport_unsupported: {
    "zh-CN": "所选 Provider 不支持所需的 Responses 传输方式。",
    "zh-TW": "所選 Provider 不支援所需的 Responses 傳輸方式。",
    en: "The selected provider does not support the required Responses transport.",
    ja: "選択した Provider は必要な Responses トランスポートに対応していません。",
    ru: "Выбранный поставщик не поддерживает требуемый транспорт Responses.",
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
