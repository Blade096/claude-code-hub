import { describe, expect, test } from "vitest";
import {
  buildProxyErrorLogDetails,
  getSafeProxyClientErrorMessage,
  sanitizeProxyErrorMessage,
} from "@/app/v1/_lib/proxy/error-sanitizer";

function sessionWithCredential(credential: string) {
  return {
    headers: new Headers({
      Authorization: `Bearer ${credential}`,
      "x-api-key": credential,
    }),
    authState: { apiKey: credential },
    requestUrl: new URL(`https://example.test/v1/responses?key=${credential}`),
  } as any;
}

describe("proxy error sanitizer", () => {
  test("removes request credentials and structured database query details", () => {
    const credential = "cch-qualification-key-without-a-standard-prefix";
    const session = sessionWithCredential(credential);
    const raw = `Failed query: select * from keys where key = $1 params: ${credential}`;

    expect(sanitizeProxyErrorMessage(session, raw)).toBe("Failed");
    expect(getSafeProxyClientErrorMessage(session, raw, "代理请求发生未知错误")).toBe(
      "代理请求发生未知错误"
    );

    const serialized = JSON.stringify(buildProxyErrorLogDetails(session, new Error(raw)));
    expect(serialized).not.toContain(credential);
    expect(serialized).not.toContain("select * from keys");
    expect(serialized).toContain('"errorName":"Error"');
  });

  test("redacts arbitrary credentials from ordinary errors without hiding the diagnosis", () => {
    const credential = "plain-secret-value-123456";
    const session = sessionWithCredential(credential);

    expect(sanitizeProxyErrorMessage(session, `upstream rejected ${credential}`)).toBe(
      "upstream rejected [REDACTED]"
    );
  });
});
