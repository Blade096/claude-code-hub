import { describe, expect, it } from "vitest";
import {
  getSupportedProxyErrorLocales,
  resolveProxyErrorLocale,
  translateProxyError,
} from "@/app/v1/_lib/proxy/proxy-error-i18n";

describe("proxy error i18n boundary", () => {
  it("covers all five supported locales", () => {
    expect(getSupportedProxyErrorLocales()).toEqual(["zh-CN", "zh-TW", "en", "ja", "ru"]);

    for (const locale of getSupportedProxyErrorLocales()) {
      const message = translateProxyError("remote_compaction_failed", locale);
      expect(message.length).toBeGreaterThan(0);
    }
  });

  it.each([
    ["en-US,en;q=0.9", "en"],
    ["ja", "ja"],
    ["ru-RU,ru;q=0.8,en;q=0.5", "ru"],
    ["zh-TW", "zh-TW"],
    ["zh-HK", "zh-TW"],
    ["zh-Hant", "zh-TW"],
    ["zh-CN", "zh-CN"],
    ["zh-Hans-CN", "zh-CN"],
    ["fr-FR,de;q=0.8", "zh-CN"],
    ["", "zh-CN"],
  ])("resolves %s to %s", (header, expected) => {
    expect(resolveProxyErrorLocale(header)).toBe(expected);
  });

  it("honours q-values instead of header order", () => {
    expect(resolveProxyErrorLocale("zh-CN;q=0.3,en;q=0.9")).toBe("en");
  });

  it("ignores entries with q=0", () => {
    expect(resolveProxyErrorLocale("en;q=0,ja;q=0.5")).toBe("ja");
  });

  it("returns the localized generic message for the compaction failure code", () => {
    expect(translateProxyError("remote_compaction_failed", "en")).toBe(
      "Remote compaction failed. Please try again later."
    );
    expect(translateProxyError("remote_compaction_failed", "zh-CN")).toBe(
      "远程压缩失败，请稍后重试。"
    );
  });

  it("keeps the error code table closed", () => {
    // 错误码类型只允许登记过的码，新增文案必须一起登记，不会静默回退到别的错误
    const codes: string[] = ["remote_compaction_failed"];
    expect(codes.every((code) => translateProxyError(code as never, "en").length > 0)).toBe(true);
  });
});
