import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

const undiciMocks = vi.hoisted(() => {
  return {
    Agent: vi.fn(),
    ProxyAgent: vi.fn(),
    setGlobalDispatcher: vi.fn(),
    request: vi.fn(),
    fetch: vi.fn(),
  };
});

vi.mock("undici", () => undiciMocks);

describe("ProxyForwarder - statusText", () => {
  it("标准状态码应写入对应的 statusText（例如 200 -> OK）", async () => {
    vi.resetModules();
    undiciMocks.request.mockResolvedValue({
      statusCode: 200,
      headers: { "content-type": "text/plain" },
      body: Readable.from(["ok"]),
    });

    const { ProxyForwarder } = await import("@/app/v1/_lib/proxy/forwarder");
    const fetchWithoutAutoDecode = (ProxyForwarder as any).fetchWithoutAutoDecode as (
      url: string,
      init: RequestInit,
      providerId: number,
      providerName: string
    ) => Promise<Response>;

    const response = await fetchWithoutAutoDecode(
      "https://example.com/test",
      { method: "GET" },
      1,
      "test-provider"
    );

    expect(response.status).toBe(200);
    expect(response.statusText).toBe("OK");
  });

  it("未知/非标准状态码不应兜底为 OK（避免误导）", async () => {
    vi.resetModules();
    undiciMocks.request.mockResolvedValue({
      statusCode: 499,
      headers: { "content-type": "text/plain" },
      body: Readable.from(["unknown"]),
    });

    const { ProxyForwarder } = await import("@/app/v1/_lib/proxy/forwarder");
    const fetchWithoutAutoDecode = (ProxyForwarder as any).fetchWithoutAutoDecode as (
      url: string,
      init: RequestInit,
      providerId: number,
      providerName: string
    ) => Promise<Response>;

    const response = await fetchWithoutAutoDecode(
      "https://example.com/test",
      { method: "GET" },
      1,
      "test-provider"
    );

    expect(response.status).toBe(499);
    expect(response.statusText).toBe("");
  });

  it("自定义 dispatcher 应直接调用实例且不回传 dispatcher 选项", async () => {
    vi.resetModules();
    undiciMocks.request.mockImplementation(() => {
      throw new Error(
        "opts.dispatcher is not supported by instance methods. Pass opts.dispatcher to the top-level undici functions or call the dispatcher instance method directly."
      );
    });
    const dispatcherRequest = vi.fn().mockResolvedValue({
      statusCode: 200,
      headers: { "content-type": "text/plain" },
      body: Readable.from(["ok"]),
    });

    const { ProxyForwarder } = await import("@/app/v1/_lib/proxy/forwarder");
    const fetchWithoutAutoDecode = (ProxyForwarder as any).fetchWithoutAutoDecode as (
      url: string,
      init: RequestInit & { dispatcher?: { request: typeof dispatcherRequest } },
      providerId: number,
      providerName: string
    ) => Promise<Response>;

    const response = await fetchWithoutAutoDecode(
      "https://example.com/test?mode=compact",
      { method: "GET", dispatcher: { request: dispatcherRequest } },
      1,
      "test-provider"
    );

    expect(response.status).toBe(200);
    expect(undiciMocks.request).not.toHaveBeenCalled();
    expect(dispatcherRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: "https://example.com",
        path: "/test?mode=compact",
      })
    );
    expect(dispatcherRequest.mock.calls[0]?.[0]).not.toHaveProperty("dispatcher");
  });
});
