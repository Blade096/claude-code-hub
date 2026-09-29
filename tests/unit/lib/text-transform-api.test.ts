// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/auth", () => ({
  AUTH_COOKIE_NAME: "auth-token",
  getSessionTokenMode: () => "legacy",
  detectSessionTokenKind: () => "legacy",
  isSignedAdminAuthToken: async () => false,
  runWithAuthSession: (_session: unknown, fn: () => unknown) => fn(),
  validateAuthToken: async (token: string) =>
    token === "bad" ? null : { user: { id: 1, role: token === "reader" ? "user" : "admin" } },
}));
vi.mock("@/lib/config/config", () => ({ config: { auth: { adminToken: "admin" } } }));
import { textTransformRouter } from "@/app/api/v1/resources/text-transform/router";
import { getTextTransformSettings, saveTextTransformSettings } from "@/repository/text-transform";
import {
  getEffectiveTextTransformSettings,
  invalidateTextTransformSettings,
} from "@/lib/text-transform/settings";

const config = { enabled: false, caseSensitive: true, rules: [] };
afterEach(() => vi.unstubAllEnvs());
const request = (method = "GET", body?: unknown, token = "admin") =>
  textTransformRouter.request("/text-transform", {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
beforeEach(() => {
  vi.stubEnv("CCH_TEXT_TRANSFORM", "");
  invalidateTextTransformSettings();
  vi.mocked(getTextTransformSettings).mockResolvedValue(null);
});
describe("文本保护管理 API", () => {
  it("无登录401，普通用户403，管理员可读且不缓存敏感配置", async () => {
    expect((await textTransformRouter.request("/text-transform")).status).toBe(401);
    expect((await request("GET", undefined, "reader")).status).toBe(403);
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ revision: 0, source: "default" });
  });
  it("Cookie 保存要求 CSRF", async () => {
    const response = await textTransformRouter.request("/text-transform", {
      method: "PUT",
      headers: { cookie: "auth-token=admin", "content-type": "application/json" },
      body: JSON.stringify({ config, revision: 0 }),
    });
    expect(response.status).toBe(403);
    expect(saveTextTransformSettings).not.toHaveBeenCalled();
  });
  it("保存配置并使已有缓存失效", async () => {
    await getEffectiveTextTransformSettings();
    vi.mocked(saveTextTransformSettings).mockResolvedValue({ config, revision: 1 });
    vi.mocked(getTextTransformSettings).mockResolvedValue({ config, revision: 1 });
    const response = await request("PUT", { config, revision: 0 });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ source: "database", revision: 1 });
    expect((await getEffectiveTextTransformSettings()).revision).toBe(1);
  });
  it("过期版本返回409，不假装保存成功", async () => {
    vi.mocked(saveTextTransformSettings).mockResolvedValue(null);
    expect((await request("PUT", { config, revision: 1 })).status).toBe(409);
  });
  it.each([
    { config: { ...config, enabled: true }, revision: 0 },
    { config: { ...config, rules: [{ source: "x", target: "xx" }] }, revision: 0 },
    { config, revision: -1 },
    { config, revision: 0, unknown: true },
  ])("拒绝非法配置 %j", async (body) => {
    expect((await request("PUT", body)).status).toBe(400);
    expect(saveTextTransformSettings).not.toHaveBeenCalled();
  });
  it("读写数据库失败返回不含细节的503", async () => {
    vi.mocked(getTextTransformSettings).mockRejectedValue(new Error("db-secret"));
    const response = await request();
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("db-secret");
    vi.mocked(saveTextTransformSettings).mockRejectedValue(new Error("db-secret"));
    expect((await request("PUT", { config, revision: 0 })).status).toBe(503);
  });
});
