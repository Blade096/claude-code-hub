import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
  assertEvidencePathOutsideRepository,
  appendSafeEvidence,
  buildEvidence,
  buildQualificationCases,
  findPortableAudits,
  parseCodexJsonl,
  readPortableQualificationConfig,
  serializeSafeEvidence,
  type PortableAudit,
  type PortableQualificationConfig,
  type QualificationCase,
  type QualificationEvidence,
} from "../../e2e/_helpers/portable-qualification";

const repositoryRoot = resolve(__dirname, "../../..");

function completeEnv(): NodeJS.ProcessEnv {
  return {
    CCH_PORTABLE_QUALIFICATION: "1",
    CCH_PORTABLE_QUALIFICATION_BASE_URL: "https://cch.example.test",
    CCH_PORTABLE_QUALIFICATION_ADMIN_TOKEN: "admin-secret-value",
    CCH_PORTABLE_QUALIFICATION_PROXY_KEY: "proxy-secret-value",
    CCH_PORTABLE_QUALIFICATION_EVIDENCE_PATH: resolve(repositoryRoot, "..", "evidence.jsonl"),
    CCH_PORTABLE_QUALIFICATION_LOG_PATHS_JSON: JSON.stringify([
      resolve(repositoryRoot, "..", "cch.log"),
    ]),
    CCH_PORTABLE_QUALIFICATION_CODEX_VERSION: "codex-cli 0.155.0",
    CCH_PORTABLE_QUALIFICATION_CCH_COMMIT: "0123456789abcdef",
    CCH_PORTABLE_QUALIFICATION_NATIVE_TYPE: "codex",
    CCH_PORTABLE_QUALIFICATION_NATIVE_MODE: "native",
    CCH_PORTABLE_QUALIFICATION_NATIVE_PROVIDER_ID: "10",
    CCH_PORTABLE_QUALIFICATION_NATIVE_PROVIDER_NAME: "native-root",
    CCH_PORTABLE_QUALIFICATION_NATIVE_MODEL: "gpt-native",
    CCH_PORTABLE_QUALIFICATION_DEEPSEEK_TYPE: "codex",
    CCH_PORTABLE_QUALIFICATION_DEEPSEEK_MODE: "portable",
    CCH_PORTABLE_QUALIFICATION_DEEPSEEK_PROVIDER_ID: "20",
    CCH_PORTABLE_QUALIFICATION_DEEPSEEK_PROVIDER_NAME: "deepseek-portable",
    CCH_PORTABLE_QUALIFICATION_DEEPSEEK_MODEL: "deepseek-agent",
    CCH_PORTABLE_QUALIFICATION_DEEPSEEK_UPSTREAM_ERROR_MODEL: "deepseek-error-fixture",
    CCH_PORTABLE_QUALIFICATION_DEEPSEEK_WS_CAPABILITY: "unsupported",
    CCH_PORTABLE_QUALIFICATION_GLM_TYPE: "codex",
    CCH_PORTABLE_QUALIFICATION_GLM_MODE: "portable",
    CCH_PORTABLE_QUALIFICATION_GLM_PROVIDER_ID: "30",
    CCH_PORTABLE_QUALIFICATION_GLM_PROVIDER_NAME: "glm-portable",
    CCH_PORTABLE_QUALIFICATION_GLM_MODEL: "glm-agent",
    CCH_PORTABLE_QUALIFICATION_GLM_UPSTREAM_ERROR_MODEL: "glm-error-fixture",
    CCH_PORTABLE_QUALIFICATION_GLM_WS_CAPABILITY: "supported",
  };
}

function audit(overrides: Partial<PortableAudit> = {}): PortableAudit {
  return {
    type: "codex_multi_agent_v2_portable",
    mode: "portable",
    state: "response_restored",
    requestedTransport: "sse",
    actualTransport: "sse",
    requestedProviderId: 20,
    requestedProviderName: "deepseek-portable",
    actualProviderId: 20,
    actualProviderName: "deepseek-portable",
    requestedModel: "deepseek-agent",
    actualModel: "deepseek-agent",
    transformations: ["spawn_agent_message_schema"],
    responseRestore: "restored",
    errorCategory: null,
    requestId: 123,
    sessionId: "session-safe",
    responseId: "response-safe",
    ...overrides,
  };
}

function sampleCase(): QualificationCase {
  return {
    caseId: "deepseek_lifecycle_none_sse",
    providerKind: "deepseek",
    operation: "lifecycle",
    historyMode: "none",
    transport: "sse",
    expected: "success",
  };
}

describe("portable real qualification configuration", () => {
  test("is disabled unless explicitly opted in", () => {
    expect(readPortableQualificationConfig({}, repositoryRoot)).toBeNull();
  });

  test("requires explicit codex provider types and modes", () => {
    const env = completeEnv();
    env.CCH_PORTABLE_QUALIFICATION_GLM_TYPE = "openai-compatible";
    expect(() => readPortableQualificationConfig(env, repositoryRoot)).toThrow(
      "CCH_PORTABLE_QUALIFICATION_GLM_TYPE must be exactly codex"
    );
  });

  test("rejects URLs containing credentials or query parameters", () => {
    for (const baseUrl of [
      "https://user:password@cch.example.test",
      "https://cch.example.test?token=secret",
    ]) {
      const env = completeEnv();
      env.CCH_PORTABLE_QUALIFICATION_BASE_URL = baseUrl;
      expect(() => readPortableQualificationConfig(env, repositoryRoot)).toThrow(
        "must not contain credentials, query, or fragment"
      );
    }
  });

  test("rejects URLs disguised as evidence labels", () => {
    const env = completeEnv();
    env.CCH_PORTABLE_QUALIFICATION_DEEPSEEK_PROVIDER_NAME =
      "https://provider.example.test?tenant=secret";
    expect(() => readPortableQualificationConfig(env, repositoryRoot)).toThrow(
      "is not safe for qualification evidence"
    );
  });

  test("requires at least one absolute ordinary-log path", () => {
    for (const value of ["not-json", "{}", "[]", "[123]", '[""]', '["relative.log"]']) {
      const env = completeEnv();
      env.CCH_PORTABLE_QUALIFICATION_LOG_PATHS_JSON = value;
      expect(() => readPortableQualificationConfig(env, repositoryRoot)).toThrow(
        "CCH_PORTABLE_QUALIFICATION_LOG_PATHS_JSON"
      );
    }
  });

  test("validates numeric, duration, websocket and protocol fields", () => {
    const invalidMutations: Array<[string, string, string]> = [
      ["CCH_PORTABLE_QUALIFICATION_NATIVE_PROVIDER_ID", "0", "positive integer"],
      ["CCH_PORTABLE_QUALIFICATION_NATIVE_PROVIDER_ID", "1.5", "positive integer"],
      ["CCH_PORTABLE_QUALIFICATION_CASE_TIMEOUT_MS", "99", "between 100"],
      ["CCH_PORTABLE_QUALIFICATION_CASE_TIMEOUT_MS", "1800001", "between 100"],
      ["CCH_PORTABLE_QUALIFICATION_CASE_TIMEOUT_MS", "not-a-number", "between 100"],
      ["CCH_PORTABLE_QUALIFICATION_DEEPSEEK_WS_CAPABILITY", "maybe", "supported or unsupported"],
      ["CCH_PORTABLE_QUALIFICATION_BASE_URL", "ftp://cch.example.test", "http or https"],
    ];
    for (const [name, value, message] of invalidMutations) {
      const env = completeEnv();
      env[name] = value;
      expect(() => readPortableQualificationConfig(env, repositoryRoot)).toThrow(message);
    }

    const valid = completeEnv();
    valid.CCH_PORTABLE_QUALIFICATION_CASE_TIMEOUT_MS = "1000";
    valid.CCH_PORTABLE_QUALIFICATION_CANCEL_AFTER_MS = "250";
    expect(readPortableQualificationConfig(valid, repositoryRoot)).toMatchObject({
      caseTimeoutMs: 1000,
      cancelAfterMs: 250,
    });
  });

  test("rejects missing and control-character evidence labels", () => {
    const missing = completeEnv();
    delete missing.CCH_PORTABLE_QUALIFICATION_NATIVE_MODEL;
    expect(() => readPortableQualificationConfig(missing, repositoryRoot)).toThrow("is required");

    for (const providerName of [`portable\nprovider`, "x".repeat(257)]) {
      const env = completeEnv();
      env.CCH_PORTABLE_QUALIFICATION_DEEPSEEK_PROVIDER_NAME = providerName;
      expect(() => readPortableQualificationConfig(env, repositoryRoot)).toThrow(
        "is not safe for qualification evidence"
      );
    }
  });

  test("keeps machine-readable evidence outside the repository", () => {
    expect(() =>
      assertEvidencePathOutsideRepository(resolve(repositoryRoot, "evidence.jsonl"), repositoryRoot)
    ).toThrow("outside the repository");
    expect(() =>
      assertEvidencePathOutsideRepository(
        resolve(repositoryRoot, "..", "evidence.jsonl"),
        repositoryRoot
      )
    ).not.toThrow();
  });

  test("loads secrets without copying them into provider metadata", () => {
    const config = readPortableQualificationConfig(completeEnv(), repositoryRoot);
    expect(config).toMatchObject({
      adminToken: "admin-secret-value",
      proxyKey: "proxy-secret-value",
      deepseek: { kind: "deepseek", mode: "portable", websocketCapability: "unsupported" },
      glm: { kind: "glm", mode: "portable", websocketCapability: "supported" },
      native: { kind: "native", mode: "native" },
    });
    expect(JSON.stringify(config?.deepseek)).not.toContain("secret-value");
  });
});

describe("portable real qualification matrix", () => {
  test("covers both portable families, all history modes, transport capability and faults", () => {
    const cases = buildQualificationCases("unsupported", "supported");
    expect(cases).toHaveLength(15);

    for (const providerKind of ["deepseek", "glm"] as const) {
      const providerCases = cases.filter((item) => item.providerKind === providerKind);
      expect(
        providerCases
          .filter((item) => item.operation === "lifecycle" && item.transport === "sse")
          .map((item) => item.historyMode)
      ).toEqual(["none", "recent", "all"]);
      expect(providerCases.map((item) => item.operation)).toEqual(
        expect.arrayContaining(["cancellation", "timeout", "upstream_error"])
      );
    }

    expect(
      cases.find((item) => item.caseId === "deepseek_lifecycle_none_websocket")?.expected
    ).toBe("capability_error");
    expect(cases.find((item) => item.caseId === "glm_lifecycle_none_websocket")?.expected).toBe(
      "success"
    );
    expect(cases.some((item) => item.providerKind === "native")).toBe(true);
  });
});

describe("portable qualification evidence safety", () => {
  const config = readPortableQualificationConfig(
    completeEnv(),
    repositoryRoot
  ) as PortableQualificationConfig;

  test("extracts only portable audit records from nested usage-log responses", () => {
    const portable = audit();
    const response = {
      items: [
        { specialSettings: [{ type: "response_input_rectifier" }, portable] },
        { specialSettings: null },
      ],
    };
    expect(findPortableAudits(response)).toEqual([portable]);
  });

  test("parses safe status and usage without retaining tool prompts", () => {
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "collab_tool_call",
          tool: "spawn_agent",
          receiver_thread_ids: ["child-1"],
          agents_states: { "child-1": { status: "completed", message: "child-safe-result" } },
          prompt: "PORTABLE_TASK_SENTINEL_must_not_persist",
        },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: '{"ok":true}' },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: {
          input_tokens: 11,
          cached_input_tokens: 2,
          output_tokens: 3,
          reasoning_output_tokens: 1,
        },
      }),
    ].join("\n");

    expect(parseCodexJsonl(stdout)).toEqual({
      threadId: "thread-1",
      relatedThreadIds: ["child-1"],
      usage: { inputTokens: 11, cachedInputTokens: 2, outputTokens: 3, reasoningOutputTokens: 1 },
      finalMessage: '{"ok":true}',
      failed: false,
      collabTools: ["spawn_agent"],
      collabAgentMessages: ["child-safe-result"],
    });
    expect(JSON.stringify(parseCodexJsonl(stdout))).not.toContain("PORTABLE_TASK_SENTINEL");
  });

  test("tolerates malformed JSONL and normalizes failure usage fields", () => {
    const stdout = [
      "not-json",
      JSON.stringify({ type: "error" }),
      JSON.stringify({
        type: "turn.completed",
        usage: {
          input_tokens: "unknown",
          cached_input_tokens: null,
          output_tokens: 2,
          reasoning_output_tokens: null,
        },
      }),
      JSON.stringify({
        type: "item.updated",
        item: {
          type: "collab_tool_call",
          tool: "wait_agent",
          receiver_thread_ids: ["child-1", "child-1", 7],
          agents_states: {
            "child-1": { message: "done" },
            "child-2": { message: "done" },
            "child-3": null,
          },
        },
      }),
    ].join("\n");
    expect(parseCodexJsonl(stdout)).toMatchObject({
      failed: true,
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0 },
      relatedThreadIds: ["child-1"],
      collabTools: ["wait_agent"],
      collabAgentMessages: ["done"],
    });
  });

  test("serializes an allowlisted record without secrets, sentinels or URLs", () => {
    const evidence = buildEvidence({
      caseInfo: sampleCase(),
      config,
      audit: audit(),
      run: {
        threadId: "thread-safe",
        relatedThreadIds: ["child-safe"],
        usage: { inputTokens: 11, cachedInputTokens: 2, outputTokens: 3, reasoningOutputTokens: 1 },
        finalMessage: "PORTABLE_TASK_SENTINEL_not_copied",
        failed: false,
        collabTools: ["spawn_agent"],
        collabAgentMessages: [],
      },
      result: "passed",
    });
    const serialized = serializeSafeEvidence(
      evidence,
      [config.adminToken, config.proxyKey],
      ["PORTABLE_TASK_SENTINEL_not_copied"]
    );

    expect(JSON.parse(serialized)).toMatchObject({
      caseId: "deepseek_lifecycle_none_sse",
      requestedProviderName: "deepseek-portable",
      actualProviderName: "deepseek-portable",
      transport: "sse",
      result: "passed",
      auditState: "response_restored",
    });
    expect(serialized).not.toContain(config.baseUrl);
    expect(serialized).not.toContain("secret-value");
    expect(serialized).not.toContain("PORTABLE_TASK_SENTINEL");
  });

  test("fails closed if a protected value reaches an allowlisted field", () => {
    const evidence = buildEvidence({
      caseInfo: sampleCase(),
      config,
      audit: audit({ actualModel: "PORTABLE_TASK_SENTINEL_leak" }),
      run: {
        threadId: null,
        relatedThreadIds: [],
        usage: null,
        finalMessage: null,
        failed: false,
        collabTools: [],
        collabAgentMessages: [],
      },
      result: "failed",
    });
    expect(() => serializeSafeEvidence(evidence, [], ["PORTABLE_TASK_SENTINEL_leak"])).toThrow(
      "protected value"
    );
  });

  test("fails closed on URLs and forbidden evidence fields", () => {
    const base = buildEvidence({
      caseInfo: sampleCase(),
      config,
      audit: audit(),
      run: {
        threadId: null,
        relatedThreadIds: [],
        usage: null,
        finalMessage: null,
        failed: false,
        collabTools: [],
        collabAgentMessages: [],
      },
      result: "failed",
    });
    expect(() =>
      serializeSafeEvidence({ ...base, actualProviderName: "https://provider.invalid" }, [], [])
    ).toThrow("contains a URL");
    expect(() =>
      serializeSafeEvidence(
        { ...base, prompt: "must never persist" } as unknown as QualificationEvidence,
        [],
        []
      )
    ).toThrow("forbidden field");
  });

  test("builds native evidence from inspected actual identity when no portable audit exists", () => {
    const nativeCase: QualificationCase = {
      caseId: "native_root_control_sse",
      providerKind: "native",
      operation: "recovery",
      historyMode: "none",
      transport: "sse",
      expected: "success",
    };
    const evidence = buildEvidence({
      caseInfo: nativeCase,
      config,
      run: {
        threadId: "native-thread",
        relatedThreadIds: [],
        usage: null,
        finalMessage: null,
        failed: false,
        collabTools: [],
        collabAgentMessages: [],
      },
      result: "passed",
      stableErrorCode: "safe-native-control",
      actual: {
        providerId: config.native.id,
        providerName: config.native.name,
        model: config.native.model,
        transport: "http",
      },
    });
    expect(evidence).toMatchObject({
      actualProviderId: 10,
      actualProviderName: "native-root",
      actualModel: "gpt-native",
      transport: "http",
      stableErrorCode: "safe-native-control",
      sessionId: "native-thread",
      auditState: null,
      transformations: [],
    });
  });

  test("preserves a null actual transport for unsupported websocket evidence", () => {
    const unsupportedCase: QualificationCase = {
      ...sampleCase(),
      caseId: "deepseek_lifecycle_none_websocket",
      transport: "websocket",
      expected: "capability_error",
    };
    const evidence = buildEvidence({
      caseInfo: unsupportedCase,
      config,
      audit: audit({
        state: "failed",
        requestedTransport: "websocket",
        actualTransport: null,
        responseRestore: "not_started",
        errorCategory: "compatibility_transport_unsupported",
      }),
      run: {
        threadId: "thread-safe",
        relatedThreadIds: [],
        usage: null,
        finalMessage: null,
        failed: true,
        collabTools: [],
        collabAgentMessages: [],
      },
      result: "unsupported",
    });

    expect(evidence).toMatchObject({
      transport: null,
      stableErrorCode: "compatibility_transport_unsupported",
    });
  });

  test("writes exactly one allowlisted JSONL record", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "portable-evidence-test-"));
    const path = resolve(directory, "evidence.jsonl");
    try {
      const evidence = buildEvidence({
        caseInfo: sampleCase(),
        config,
        audit: audit(),
        run: {
          threadId: "thread-safe",
          relatedThreadIds: ["child-safe"],
          usage: null,
          finalMessage: null,
          failed: false,
          collabTools: [],
          collabAgentMessages: [],
        },
        result: "passed",
      });
      await appendSafeEvidence(path, evidence, [config.adminToken, config.proxyKey], []);
      const lines = (await readFile(path, "utf8")).trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toMatchObject({
        schemaVersion: 1,
        caseId: "deepseek_lifecycle_none_sse",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
