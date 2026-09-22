import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, test, vi } from "vitest";
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
import {
  cleanupQualificationHomes,
  writeCodexHome,
} from "../../e2e/_helpers/portable-qualification-invocation";
import {
  buildLifecyclePrompt,
  type LifecycleResult,
  probeUpstreamErrorModel,
} from "../../e2e/_helpers/portable-qualification-lifecycle";
import {
  isTargetChildAudit,
  targetTerminalAudit,
  usageItemMatchesProvider,
  validateExpectedClientAbortAudit,
  validateInjectedFaultUsage,
  validateInjectedFaultProcess,
  validateSuccessfulLifecycle,
} from "../../e2e/_helpers/portable-qualification-assertions";
import { analyzeLifecycleRollouts } from "../../e2e/_helpers/portable-qualification-rollout";

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
    CCH_PORTABLE_QUALIFICATION_GLM_TYPE: "codex",
    CCH_PORTABLE_QUALIFICATION_GLM_MODE: "portable",
    CCH_PORTABLE_QUALIFICATION_GLM_PROVIDER_ID: "30",
    CCH_PORTABLE_QUALIFICATION_GLM_PROVIDER_NAME: "glm-portable",
    CCH_PORTABLE_QUALIFICATION_GLM_MODEL: "glm-agent",
    CCH_PORTABLE_QUALIFICATION_GLM_UPSTREAM_ERROR_MODEL: "glm-error-fixture",
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

function timeoutCase(): QualificationCase {
  return {
    ...sampleCase(),
    caseId: "deepseek_timeout_sse",
    operation: "timeout",
    expected: "failure",
  };
}

function upstreamErrorCase(): QualificationCase {
  return {
    ...sampleCase(),
    caseId: "deepseek_upstream_error_sse",
    operation: "upstream_error",
    expected: "failure_then_recovery",
  };
}

function successfulLifecycleResult(
  audits: PortableAudit[] = [
    audit({
      transformations: ["agent_message_input"],
      responseRestore: "not_needed",
      requestId: 101,
      sessionId: "root-thread",
      responseId: "response-1",
    }),
    audit({
      transformations: ["agent_message_input"],
      responseRestore: "not_needed",
      requestId: 102,
      sessionId: "root-thread",
      responseId: "response-2",
    }),
  ]
): LifecycleResult {
  return {
    run: {
      threadId: "root-thread",
      relatedThreadIds: ["child-thread"],
      usage: null,
      finalMessage: null,
      failed: false,
      collabTools: ["spawn_agent", "send_message", "followup_task"],
      collabAgentMessages: [],
    },
    audits,
    trace: {
      rootThreadId: "root-thread",
      childThreadId: "child-thread",
      childAgentPath: "/root/deepseek-child",
      observedActions: ["spawn_agent", "send_message", "followup_task"],
      stateEdgeVerified: true,
      actionSequenceComplete: true,
      toolOutputsComplete: true,
      sendWhileRunning: true,
      followupAfterCompletion: true,
      parentReceivedResults: true,
      childReturnedLiveNonce: true,
      childReturnedFollowupNonce: true,
      historyBoundaryMatches: true,
      historyOldMarkerObserved: false,
      historyRecentMarkerObserved: false,
      toolArgumentsExcludeHistoryMarkers: true,
    },
    sentinels: ["old", "recent", "live", "followup"],
    lifecycle: {
      case_id: sampleCase().caseId,
      spawn_agent: true,
      send_message_while_running: true,
      followup_task_after_completion: true,
      parent_received_results: true,
      inherited_history_markers: [],
      live_nonce: "live",
      followup_nonce: "followup",
    },
    code: 0,
    cancelled: false,
    timedOut: false,
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

  test("validates numeric, duration and protocol fields", () => {
    const invalidMutations: Array<[string, string, string]> = [
      ["CCH_PORTABLE_QUALIFICATION_NATIVE_PROVIDER_ID", "0", "positive integer"],
      ["CCH_PORTABLE_QUALIFICATION_NATIVE_PROVIDER_ID", "1.5", "positive integer"],
      ["CCH_PORTABLE_QUALIFICATION_CASE_TIMEOUT_MS", "99", "between 100"],
      ["CCH_PORTABLE_QUALIFICATION_CASE_TIMEOUT_MS", "1800001", "between 100"],
      ["CCH_PORTABLE_QUALIFICATION_CASE_TIMEOUT_MS", "not-a-number", "between 100"],
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
      deepseek: { kind: "deepseek", mode: "portable" },
      glm: { kind: "glm", mode: "portable" },
      native: { kind: "native", mode: "native" },
    });
    expect(JSON.stringify(config?.deepseek)).not.toContain("secret-value");
  });

  test("disables plugin synchronization in isolated Codex homes", async () => {
    const config = readPortableQualificationConfig(
      completeEnv(),
      repositoryRoot
    ) as PortableQualificationConfig;

    try {
      const { home } = await writeCodexHome(config, config.deepseek);
      const toml = await readFile(resolve(home, "config.toml"), "utf8");
      expect(toml).toContain("multi_agent_v2 = true");
      expect(toml).toContain("plugins = false");
    } finally {
      await cleanupQualificationHomes();
    }
  });
});

describe("portable real qualification matrix", () => {
  test("covers portable families plus native GPT child communication", () => {
    const cases = buildQualificationCases();
    expect(cases).toHaveLength(16);

    for (const providerKind of ["deepseek", "glm"] as const) {
      const providerCases = cases.filter((item) => item.providerKind === providerKind);
      expect(
        providerCases
          .filter((item) => item.operation === "lifecycle" && item.transport === "sse")
          .map((item) => item.historyMode)
      ).toEqual(["none", "recent", "all"]);
      expect(providerCases.map((item) => item.operation)).toEqual(
        expect.arrayContaining(["http_non_stream", "cancellation", "timeout", "upstream_error"])
      );
      expect(
        providerCases.some(
          (item) => item.operation === "http_non_stream" && item.transport === "http"
        )
      ).toBe(true);
    }

    expect(cases.map((item) => item.transport)).not.toContain("websocket");
    expect(cases).toContainEqual({
      caseId: "native_child_lifecycle_none_sse",
      providerKind: "native",
      operation: "lifecycle",
      historyMode: "none",
      transport: "sse",
      expected: "success",
    });
  });
});

describe("portable qualification evidence safety", () => {
  const config = readPortableQualificationConfig(
    completeEnv(),
    repositoryRoot
  ) as PortableQualificationConfig;

  test("rejects a process-level deadline as proof of the child idle-timeout fault", () => {
    expect(() =>
      validateInjectedFaultProcess(timeoutCase(), { cancelled: false, timedOut: true })
    ).toThrow("process-level timeout/cancellation");
    expect(() =>
      validateInjectedFaultProcess(timeoutCase(), { cancelled: false, timedOut: false })
    ).not.toThrow();
  });

  test("accepts an HTTP 400 fault-model preflight before starting a lifecycle", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response('{"error":"invalid model"}', { status: 400 }));
    try {
      await expect(probeUpstreamErrorModel(config, config.deepseek)).resolves.toEqual({
        kind: "http_400",
        status: 400,
        stableErrorCode: "HTTP_400_CLIENT_ERROR_NON_RETRYABLE",
      });
      const request = fetchMock.mock.calls[0];
      expect(request?.[0]).toBe("https://cch.example.test/v1/responses");
      expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({
        model: "deepseek-error-fixture",
        stream: true,
        store: false,
      });
    } finally {
      fetchMock.mockRestore();
    }
  });

  test("accepts a model_not_found response.failed SSE fault-model preflight", async () => {
    const body = [
      "event: response.failed",
      'data: {"type":"response.failed","response":{"id":"resp_failed","error":{"code":"model_not_found"}}}',
      "",
      "event: error",
      'data: {"type":"error","code":"model_not_found"}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })
    );
    try {
      await expect(probeUpstreamErrorModel(config, config.glm)).resolves.toEqual({
        kind: "sse_response_failed",
        status: 200,
        stableErrorCode: "SSE_RESPONSE_FAILED_MODEL_NOT_FOUND",
      });
    } finally {
      fetchMock.mockRestore();
    }
  });

  test("rejects HTTP 200 when the fault-model preflight completes successfully", async () => {
    const body = [
      "event: response.completed",
      'data: {"type":"response.completed","response":{"id":"resp_completed"}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })
    );
    try {
      await expect(probeUpstreamErrorModel(config, config.glm)).rejects.toThrow(
        "without response.failed(model_not_found)"
      );
    } finally {
      fetchMock.mockRestore();
    }
  });

  test("accepts a timeout audit only when it is a neutral client-abort failure", () => {
    const configTarget = config.deepseek;
    const timeoutAudit = audit({
      state: "failed",
      responseRestore: "not_needed",
      errorCategory: null,
      requestId: 901,
      sessionId: "timeout-session",
    });
    const usageItem = {
      id: 901,
      sessionId: "timeout-session",
      providerId: configTarget.id,
      providerName: configTarget.name,
      model: configTarget.model,
      statusCode: 499,
      errorMessage: "CLIENT_ABORTED",
    };

    expect(() =>
      validateInjectedFaultUsage(
        timeoutCase(),
        configTarget,
        configTarget.model,
        timeoutAudit,
        usageItem
      )
    ).not.toThrow();
    expect(() =>
      validateInjectedFaultUsage(
        timeoutCase(),
        configTarget,
        configTarget.model,
        { ...timeoutAudit, errorCategory: "compatibility_restore_failed" },
        usageItem
      )
    ).toThrow("expected 499/CLIENT_ABORTED");
  });

  test("accepts a failed SSE terminal event as a provider-native upstream error", () => {
    const target = config.glm;
    const failedAudit = audit({
      state: "failed",
      requestedProviderId: target.id,
      requestedProviderName: target.name,
      actualProviderId: target.id,
      actualProviderName: target.name,
      requestedModel: target.upstreamErrorModel,
      actualModel: "provider-invalid-model",
      responseRestore: "not_needed",
      errorCategory: null,
      responseId: "resp_failed",
    });
    const usageItem = {
      id: failedAudit.requestId,
      sessionId: failedAudit.sessionId,
      providerId: target.id,
      providerName: target.name,
      model: "provider-invalid-model",
      originalModel: target.upstreamErrorModel,
      statusCode: 200,
      errorMessage: null,
      providerChain: [
        { id: target.id, name: target.name, reason: "request_success", statusCode: 200 },
      ],
    };

    expect(() =>
      validateInjectedFaultUsage(
        { ...upstreamErrorCase(), providerKind: "glm" },
        target,
        target.upstreamErrorModel!,
        failedAudit,
        usageItem,
        {
          kind: "sse_response_failed",
          status: 200,
          stableErrorCode: "SSE_RESPONSE_FAILED_MODEL_NOT_FOUND",
        }
      )
    ).not.toThrow();
  });

  test("correlates child audits to the shared root session tree", () => {
    expect(() =>
      validateSuccessfulLifecycle(sampleCase(), config.deepseek, successfulLifecycleResult())
    ).not.toThrow();
  });

  test("rejects a child thread id used as the shared audit session id", () => {
    const result = successfulLifecycleResult(
      successfulLifecycleResult().audits.map((item) => ({
        ...item,
        sessionId: "child-thread",
      }))
    );

    expect(() => validateSuccessfulLifecycle(sampleCase(), config.deepseek, result)).toThrow(
      "restored audits are not correlated to the shared root session tree"
    );
  });

  test("rejects failed portable audits mixed into a successful lifecycle", () => {
    const result = successfulLifecycleResult([
      ...successfulLifecycleResult().audits,
      audit({
        state: "failed",
        transformations: ["agent_message_input"],
        responseRestore: "failed",
        errorCategory: "compatibility_restore_failed",
        requestId: 103,
        sessionId: "root-thread",
        responseId: "response-3",
      }),
    ]);

    expect(() => validateSuccessfulLifecycle(sampleCase(), config.deepseek, result)).toThrow(
      "successful lifecycle contains a compatibility failure"
    );
  });

  test("allows only a failed audit correlated to an expected client cancellation", () => {
    const result = successfulLifecycleResult();
    const cancelled = audit({
      state: "failed",
      responseRestore: "not_needed",
      errorCategory: null,
      requestId: 901,
    });
    result.audits.push(cancelled);

    expect(() =>
      validateExpectedClientAbortAudit("client_abort", cancelled, {
        id: 901,
        statusCode: 499,
        errorMessage: "CLIENT_ABORTED",
      })
    ).not.toThrow();
    expect(() =>
      validateExpectedClientAbortAudit("upstream_abort", cancelled, {
        id: 901,
        statusCode: 502,
        errorMessage: "STREAM_UPSTREAM_ABORTED",
      })
    ).toThrow("not correlated to an expected client cancellation");
    expect(() => validateSuccessfulLifecycle(sampleCase(), config.deepseek, result)).not.toThrow();
  });

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

  test("matches native provider identity from the real usage API provider chain", () => {
    const item = {
      providerName: "native-root",
      model: "gpt-native",
      providerChain: [
        { id: 10, name: "native-root", reason: "initial_selection" },
        { id: 10, name: "native-root", reason: "request_success" },
      ],
    };
    expect(usageItemMatchesProvider(item, 10, "native-root")).toBe(true);
    expect(usageItemMatchesProvider(item, 11, "native-root")).toBe(false);
    expect(usageItemMatchesProvider(item, 10, "different-provider")).toBe(false);
  });

  test("separates target child audits from native root audits sharing one session", () => {
    const target = config.deepseek;
    const child = audit({
      sessionId: "shared-root-session",
      transformations: ["agent_message_input"],
      responseRestore: "not_needed",
    });
    const root = audit({
      sessionId: "shared-root-session",
      requestedProviderId: config.native.id,
      requestedProviderName: config.native.name,
      actualProviderId: config.native.id,
      actualProviderName: config.native.name,
      requestedModel: config.native.model,
      actualModel: config.native.model,
      transformations: ["collaboration_namespace"],
    });

    expect(isTargetChildAudit(child, target, target.model)).toBe(true);
    expect(isTargetChildAudit(root, target, target.model)).toBe(false);
    expect(targetTerminalAudit([root, child], target, target.model)).toBe(child);
  });

  test("never accepts a native root failure as the target child fault", () => {
    const target = config.deepseek;
    const rootFailure = audit({
      state: "failed",
      requestedProviderId: config.native.id,
      requestedProviderName: config.native.name,
      actualProviderId: config.native.id,
      actualProviderName: config.native.name,
      requestedModel: config.native.model,
      actualModel: config.native.model,
      transformations: ["collaboration_namespace"],
    });
    const redirectedChildFailure = audit({
      state: "failed",
      requestedModel: target.upstreamErrorModel,
      actualModel: "provider-invalid-model",
      transformations: ["agent_message_input"],
    });

    expect(targetTerminalAudit([rootFailure], target, target.model)).toBeNull();
    expect(
      targetTerminalAudit(
        [rootFailure, redirectedChildFailure],
        target,
        target.upstreamErrorModel!,
        true
      )
    ).toBe(redirectedChildFailure);
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

  test("does not label root CLI usage as child Provider usage", () => {
    const evidence = buildEvidence({
      caseInfo: sampleCase(),
      config,
      audit: audit({ sessionId: "child-thread" }),
      run: {
        threadId: "root-thread",
        relatedThreadIds: ["child-thread"],
        usage: { inputTokens: 99, cachedInputTokens: 9, outputTokens: 8, reasoningOutputTokens: 7 },
        finalMessage: null,
        failed: false,
        collabTools: [],
        collabAgentMessages: [],
      },
      result: "passed",
    });

    expect(evidence.usage).toBeNull();
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

describe("portable qualification isolated rollout evidence", () => {
  const rootThread = {
    id: "root-thread",
    rolloutPath: "root.jsonl",
    agentPath: null,
  };
  const childThread = {
    id: "child-thread",
    rolloutPath: "child.jsonl",
    agentPath: "/root/deepseek-child",
  };
  const startedAt = Date.parse("2026-09-21T00:00:00.000Z");
  const sentinels = ["OLD_MARKER", "RECENT_MARKER", "LIVE_NONCE", "FOLLOWUP_NONCE"];

  test("keeps the recent-history marker out of the current parent turn", () => {
    const prompt = buildLifecyclePrompt(
      { ...sampleCase(), historyMode: "recent" },
      {
        kind: "deepseek",
        id: 20,
        name: "deepseek-portable",
        model: "deepseek-agent",
        mode: "portable",
        upstreamErrorModel: "deepseek-error-fixture",
      },
      sentinels[2]!,
      sentinels[3]!
    );

    expect(prompt).not.toContain(sentinels[1]);
    expect(prompt).toContain("fork_turns=2");
    expect(prompt).toContain("call wait_agent exactly once with timeout_ms=300000");
    expect(prompt).toContain("must not complete before acknowledging that nonce");
    expect(prompt).toContain("The child is not the parent orchestrator");
    expect(prompt).toContain("wait_agent is the only tool it may call, exactly once");
    expect(prompt).toContain("must not call write_stdin, exec_command");
    expect(prompt).toContain("spawn_agent, send_message, followup_task");
    expect(prompt).toContain("create_goal, or update_goal");
    expect(prompt).toContain("return immediately and stop");
    expect(prompt).toContain("This is the follow-up turn");
    expect(prompt).toContain("must not call wait again");
  });

  function line(offsetMs: number, type: string, payload: Record<string, unknown>): string {
    return JSON.stringify({
      timestamp: new Date(startedAt + offsetMs).toISOString(),
      type,
      payload,
    });
  }

  function functionCall(
    offsetMs: number,
    name: string,
    callId: string,
    args: Record<string, unknown>
  ): string {
    return line(offsetMs, "response_item", {
      type: "function_call",
      name,
      call_id: callId,
      arguments: JSON.stringify(args),
    });
  }

  function functionOutput(offsetMs: number, callId: string): string {
    return line(offsetMs, "response_item", {
      type: "function_call_output",
      call_id: callId,
      output: JSON.stringify({ ok: true }),
    });
  }

  function activity(offsetMs: number, id: string, kind: string): string {
    return line(offsetMs, "event_msg", {
      type: "item_completed",
      item: {
        type: "SubAgentActivity",
        id,
        kind,
        agent_thread_id: childThread.id,
        agent_path: childThread.agentPath,
      },
    });
  }

  function completeRootRollout(): string {
    return [
      functionCall(10, "spawn_agent", "call-spawn", {
        task_name: "deepseek-child",
        agent_type: "deepseek",
        fork_turns: "1",
        message:
          "Report inherited markers; wait_agent is the only tool and do not call write_stdin.",
      }),
      functionOutput(20, "call-spawn"),
      activity(30, "call-spawn", "started"),
      functionCall(40, "send_message", "call-send", {
        target: childThread.agentPath,
        message: sentinels[2],
      }),
      functionOutput(50, "call-send"),
      activity(60, "call-send", "interacted"),
      activity(70, "completion-one", "completed"),
      functionCall(80, "followup_task", "call-followup", {
        target: childThread.agentPath,
        message: sentinels[3],
      }),
      functionOutput(90, "call-followup"),
      activity(100, "call-followup", "interacted"),
      activity(110, "completion-two", "completed"),
      line(120, "response_item", {
        type: "agent_message",
        content: [{ type: "input_text", text: `${sentinels[2]} ${sentinels[3]}` }],
      }),
    ].join("\n");
  }

  const childRollout = [
    line(-500, "response_item", {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: sentinels[1] }],
    }),
    line(115, "response_item", {
      type: "message",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: `${sentinels[2]} ${sentinels[3]}`,
        },
      ],
    }),
    line(5, "response_item", {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: "wait_agent is the only tool and do not call write_stdin",
        },
      ],
    }),
  ].join("\n");

  test("proves the lifecycle from full rollout even when exec JSON only exposes wait", () => {
    const trace = analyzeLifecycleRollouts({
      rootThread,
      childThread,
      rootJsonl: completeRootRollout(),
      childJsonl: childRollout,
      startedAt,
      sentinels,
      historyMode: "recent",
    });

    expect(trace).toMatchObject({
      rootThreadId: rootThread.id,
      childThreadId: childThread.id,
      childAgentPath: childThread.agentPath,
      observedActions: ["spawn_agent", "send_message", "followup_task"],
      stateEdgeVerified: true,
      actionSequenceComplete: true,
      toolOutputsComplete: true,
      sendWhileRunning: true,
      followupAfterCompletion: true,
      parentReceivedResults: true,
      childReturnedLiveNonce: true,
      childReturnedFollowupNonce: true,
      historyBoundaryMatches: true,
      historyOldMarkerObserved: false,
      historyRecentMarkerObserved: true,
      toolArgumentsExcludeHistoryMarkers: true,
      spawnTaskProhibitsTools: true,
      childReceivedToolProhibition: true,
    });
  });

  test("uses rollout order when send and completion share one timestamp", () => {
    const rootJsonl = completeRootRollout().replace(
      new Date(startedAt + 70).toISOString(),
      new Date(startedAt + 40).toISOString()
    );
    const trace = analyzeLifecycleRollouts({
      rootThread,
      childThread,
      rootJsonl,
      childJsonl: childRollout,
      startedAt,
      sentinels,
      historyMode: "recent",
    });

    expect(trace.sendWhileRunning).toBe(true);
  });

  test("does not accept model self-report when the stored follow-up call is absent", () => {
    const incompleteRoot = completeRootRollout()
      .split("\n")
      .filter((entry) => !entry.includes("call-followup") && !entry.includes("completion-two"))
      .join("\n");
    const trace = analyzeLifecycleRollouts({
      rootThread,
      childThread,
      rootJsonl: incompleteRoot,
      childJsonl: childRollout,
      startedAt,
      sentinels,
      historyMode: "recent",
    });

    expect(trace.actionSequenceComplete).toBe(false);
    expect(trace.toolOutputsComplete).toBe(false);
    expect(trace.followupAfterCompletion).toBe(false);
  });

  test("rejects inherited history leaked into collaboration arguments", () => {
    const leaked = completeRootRollout().replace(
      "Report inherited markers; wait_agent is the only tool and do not call write_stdin.",
      `Leaked ${sentinels[0]}`
    );
    const trace = analyzeLifecycleRollouts({
      rootThread,
      childThread,
      rootJsonl: leaked,
      childJsonl: childRollout,
      startedAt,
      sentinels,
      historyMode: "recent",
    });

    expect(trace.toolArgumentsExcludeHistoryMarkers).toBe(false);
  });
});
