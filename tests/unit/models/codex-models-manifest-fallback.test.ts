import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/repository/key", () => ({
  resolveApiKeyAuthOutcome: vi.fn(),
}));

vi.mock("@/repository/provider", () => ({
  findAllProviders: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/proxy-agent", () => ({
  createProxyAgentForProvider: vi.fn(),
}));

vi.mock("@/lib/utils/timezone", () => ({
  resolveSystemTimezone: vi.fn().mockResolvedValue("UTC"),
}));

vi.mock("@/lib/utils/provider-schedule", () => ({
  isProviderActiveNow: vi.fn().mockReturnValue(true),
}));

vi.mock("@/app/v1/_lib/proxy/provider-selector", () => ({
  checkProviderGroupMatch: vi.fn().mockReturnValue(true),
}));

vi.mock("next-intl/server", () => ({
  getLocale: vi.fn().mockResolvedValue("en"),
}));

vi.mock("@/lib/utils/error-messages", async () => {
  const actual = await vi.importActual<typeof import("@/lib/utils/error-messages")>(
    "@/lib/utils/error-messages"
  );
  return {
    ...actual,
    getErrorMessageServer: vi.fn(async (_locale: string, code: string) => code),
  };
});

import { handleAvailableModels } from "@/app/v1/_lib/models/available-models";
import { resolveApiKeyAuthOutcome } from "@/repository/key";
import { findAllProviders } from "@/repository/provider";

const CODEX_MODELS_ETAG = 'W/"cch-codex-bundled-v1"';

function createApp() {
  const app = new Hono();
  app.get("/v1/models", handleAvailableModels);
  app.get("/v1beta/models", handleAvailableModels);
  return app;
}

function authenticatedRequest(path: string, headers?: Record<string, string>) {
  return createApp().request(`http://localhost${path}`, {
    headers: {
      authorization: "Bearer sk-test",
      ...headers,
    },
  });
}

describe("Codex models manifest fallback", () => {
  beforeEach(() => {
    vi.mocked(resolveApiKeyAuthOutcome).mockResolvedValue({
      ok: true,
      user: { id: 1, providerGroup: null, isEnabled: true, expiresAt: null },
      key: { providerGroup: null, name: "test-key" },
    } as never);
    vi.mocked(findAllProviders).mockResolvedValue([]);
  });

  it("returns an empty manifest for Codex client_version requests", async () => {
    const response = await authenticatedRequest("/v1/models?client_version=0.144.1");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ models: [] });
    expect(response.headers.get("etag")).toBe(CODEX_MODELS_ETAG);
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(findAllProviders).not.toHaveBeenCalled();
  });

  it("honors matching cache validators", async () => {
    const response = await authenticatedRequest("/v1/models?client_version=0.144.1", {
      "if-none-match": CODEX_MODELS_ETAG,
    });

    expect(response.status).toBe(304);
    expect(await response.text()).toBe("");
    expect(findAllProviders).not.toHaveBeenCalled();
  });

  it("keeps normal and explicitly overridden model discovery unchanged", async () => {
    const normal = await authenticatedRequest("/v1/models");
    expect(normal.status).toBe(200);
    expect(await normal.json()).toEqual({ object: "list", data: [] });

    vi.mocked(findAllProviders).mockClear();
    const gemini = await authenticatedRequest("/v1/models?client_version=0.144.1&format=gemini");
    expect(gemini.status).toBe(200);
    expect(gemini.headers.get("etag")).toBeNull();
    expect(findAllProviders).toHaveBeenCalledTimes(1);
  });
});
