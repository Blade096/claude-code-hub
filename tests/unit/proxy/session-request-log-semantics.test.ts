import { describe, expect, test } from "vitest";
import { ProxySession } from "@/app/v1/_lib/proxy/session";
import { makeCollaborationNamespace } from "./_helpers/codex-portable-fixtures";

function createContext(request: Request) {
  return {
    req: {
      method: request.method,
      url: request.url,
      raw: request,
      header(name?: string) {
        if (name) return request.headers.get(name) ?? undefined;
        return Object.fromEntries(request.headers.entries());
      },
    },
  } as Parameters<typeof ProxySession.fromContext>[0];
}

async function parseRequestLog(body: Record<string, unknown>): Promise<string> {
  const request = new Request("https://proxy.example.com/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await ProxySession.fromContext(createContext(request))).request.log;
}

describe("ProxySession request-log payload semantics", () => {
  test("does not irreversibly pre-redact ordinary request content", async () => {
    const sentinel = "ORDINARY_FULL_PAYLOAD_SENTINEL_73A1";
    const log = await parseRequestLog({
      model: "gpt-5.5",
      input: [{ role: "user", content: sentinel }],
    });

    expect(log).toContain(sentinel);
  });

  test("defers portable default-storage redaction until eligibility is known", async () => {
    const sentinel = "PORTABLE_STORAGE_SENTINEL_4C92";
    const log = await parseRequestLog({
      model: "gpt-5.5",
      tools: [makeCollaborationNamespace()],
      input: [{ role: "user", content: sentinel }],
    });

    expect(log).toContain(sentinel);
  });
});
