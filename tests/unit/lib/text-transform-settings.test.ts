import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTextTransformSettings } from "@/repository/text-transform";
import {
  getEffectiveTextTransformSettings,
  invalidateTextTransformSettings,
} from "@/lib/text-transform/settings";
import { readTextTransformConfig } from "@/app/v1/_lib/proxy/text-transform/config";

const config = {
  enabled: true,
  caseSensitive: true,
  rules: [{ source: "wingjoy", target: "site-k7m2" }],
};
beforeEach(() => {
  invalidateTextTransformSettings();
  vi.mocked(getTextTransformSettings).mockResolvedValue(null);
  vi.stubEnv("CCH_TEXT_TRANSFORM", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("后台配置优先级与缓存", () => {
  it("没有保存记录时继承环境，否则使用关闭的空配置", async () => {
    expect((await getEffectiveTextTransformSettings()).source).toBe("default");
    vi.stubEnv("CCH_TEXT_TRANSFORM", JSON.stringify(config));
    expect((await getEffectiveTextTransformSettings()).config).toEqual(config);
    expect(await readTextTransformConfig(1)).toEqual(config);
  });
  it("数据库关闭状态覆盖已启用的环境变量", async () => {
    vi.stubEnv("CCH_TEXT_TRANSFORM", JSON.stringify(config));
    vi.mocked(getTextTransformSettings).mockResolvedValue({
      config: { ...config, enabled: false },
      revision: 3,
    });
    expect((await getEffectiveTextTransformSettings()).source).toBe("database");
    expect(await readTextTransformConfig(1)).toBeNull();
  });
  it("供应商范围在后台配置下仍生效", async () => {
    vi.mocked(getTextTransformSettings).mockResolvedValue({
      config: { ...config, providerIds: [2] },
      revision: 1,
    });
    expect(await readTextTransformConfig(1)).toBeNull();
    expect(await readTextTransformConfig(2)).toMatchObject({ enabled: true });
  });
  it("并发读合并，五秒过期，后台读取绕过缓存", async () => {
    vi.useFakeTimers();
    await Promise.all([getEffectiveTextTransformSettings(), getEffectiveTextTransformSettings()]);
    expect(getTextTransformSettings).toHaveBeenCalledTimes(1);
    await getEffectiveTextTransformSettings(true);
    expect(getTextTransformSettings).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(5001);
    await getEffectiveTextTransformSettings();
    expect(getTextTransformSettings).toHaveBeenCalledTimes(3);
  });
  it("缓存过期且数据库失联时不使用旧值或环境变量", async () => {
    vi.useFakeTimers();
    await getEffectiveTextTransformSettings();
    vi.advanceTimersByTime(5001);
    vi.mocked(getTextTransformSettings).mockRejectedValue(new Error("db-secret"));
    await expect(readTextTransformConfig(1)).rejects.toMatchObject({
      reason: "unavailable",
      statusCode: 503,
    });
    await expect(getEffectiveTextTransformSettings()).rejects.toThrow("db-secret");
  });
  it("旧查询完成后不能覆盖保存时清除的新缓存", async () => {
    let resolve!: (value: null) => void;
    vi.mocked(getTextTransformSettings).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const old = getEffectiveTextTransformSettings();
    invalidateTextTransformSettings();
    vi.mocked(getTextTransformSettings).mockResolvedValue({ config, revision: 2 });
    expect((await getEffectiveTextTransformSettings()).revision).toBe(2);
    resolve(null);
    expect((await old).revision).toBe(2);
    expect((await getEffectiveTextTransformSettings()).revision).toBe(2);
  });
  it("损坏环境配置不会静默关闭保护", async () => {
    vi.stubEnv("CCH_TEXT_TRANSFORM", "broken");
    await expect(readTextTransformConfig(1)).rejects.toMatchObject({ statusCode: 503 });
  });
});
