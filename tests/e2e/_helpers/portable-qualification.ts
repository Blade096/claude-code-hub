import { appendFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export type QualificationProviderKind = "deepseek" | "glm";
export type QualificationHistoryMode = "none" | "recent" | "all";
export type QualificationTransport = "http" | "sse";
export type QualificationResult = "passed" | "failed" | "blocked";

export type QualificationProvider = {
  kind: QualificationProviderKind | "native";
  id: number;
  name: string;
  model: string;
  mode: "native" | "portable";
  upstreamErrorModel: string | null;
};

export type PortableQualificationConfig = {
  baseUrl: string;
  adminToken: string;
  proxyKey: string;
  evidencePath: string;
  logPaths: string[];
  codexBin: string;
  codexVersion: string;
  cchCommit: string;
  caseTimeoutMs: number;
  cancelAfterMs: number;
  native: QualificationProvider;
  deepseek: QualificationProvider;
  glm: QualificationProvider;
};

export type QualificationCase = {
  caseId: string;
  providerKind: QualificationProviderKind | "native";
  operation:
    | "lifecycle"
    | "http_non_stream"
    | "cancellation"
    | "timeout"
    | "upstream_error"
    | "recovery";
  historyMode: QualificationHistoryMode;
  transport: QualificationTransport;
  expected: "success" | "failure_then_recovery";
};

export type PortableAudit = {
  type: "codex_multi_agent_v2_portable";
  mode: "portable";
  state: "request_transformed" | "upstream_sent" | "response_restored" | "failed";
  requestedTransport: "http" | "sse" | "websocket";
  actualTransport: "http" | "sse" | "websocket" | null;
  requestedProviderId: number | null;
  requestedProviderName: string | null;
  actualProviderId: number | null;
  actualProviderName: string | null;
  requestedModel: string | null;
  actualModel: string | null;
  transformations: string[];
  responseRestore: "not_started" | "pending" | "restored" | "not_needed" | "failed";
  errorCategory: string | null;
  requestId: number | null;
  sessionId: string | null;
  responseId: string | null;
};

export type QualificationUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
};

export type QualificationEvidence = {
  schemaVersion: 1;
  caseId: string;
  recordedAt: string;
  codexVersion: string;
  cchCommit: string;
  providerKind: QualificationProviderKind | "native";
  requestedProviderId: number | null;
  requestedProviderName: string | null;
  actualProviderId: number | null;
  actualProviderName: string | null;
  requestedModel: string | null;
  actualModel: string | null;
  transport: "http" | "sse" | "websocket" | null;
  operation: QualificationCase["operation"];
  historyMode: QualificationHistoryMode;
  result: QualificationResult;
  stableErrorCode: string | null;
  requestId: number | null;
  sessionId: string | null;
  responseId: string | null;
  usage: QualificationUsage | null;
  auditState: PortableAudit["state"] | null;
  responseRestore: PortableAudit["responseRestore"] | null;
  transformations: string[];
};

export type ParsedCodexRun = {
  threadId: string | null;
  relatedThreadIds: string[];
  usage: QualificationUsage | null;
  finalMessage: string | null;
  failed: boolean;
  collabTools: string[];
  collabAgentMessages: string[];
};

const FORBIDDEN_EVIDENCE_KEYS = new Set([
  "prompt",
  "message",
  "tool_args",
  "arguments",
  "encrypted_content",
  "raw_body",
  "body_preview",
  "stdout",
  "stderr",
  "url",
  "base_url",
  "api_key",
  "proxy_key",
  "admin_token",
  "authorization",
]);

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required when real qualification is enabled.`);
  return value;
}

function positiveInt(env: NodeJS.ProcessEnv, name: string): number {
  const raw = required(env, name);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function duration(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 100 || value > 30 * 60 * 1000) {
    throw new Error(`${name} must be between 100 and 1800000 milliseconds.`);
  }
  return value;
}

function expectedValue(env: NodeJS.ProcessEnv, name: string, expected: string): string {
  const value = required(env, name);
  if (value !== expected) throw new Error(`${name} must be exactly ${expected}.`);
  return value;
}

function safeEvidenceLabel(value: string, name: string): string {
  const hasControlCharacter = [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });
  if (value.length > 256 || hasControlCharacter || /:\/\//.test(value)) {
    throw new Error(`${name} is not safe for qualification evidence.`);
  }
  return value;
}

function provider(
  env: NodeJS.ProcessEnv,
  prefix: string,
  kind: QualificationProviderKind
): QualificationProvider {
  expectedValue(env, `${prefix}_TYPE`, "codex");
  expectedValue(env, `${prefix}_MODE`, "portable");
  return {
    kind,
    id: positiveInt(env, `${prefix}_PROVIDER_ID`),
    name: safeEvidenceLabel(required(env, `${prefix}_PROVIDER_NAME`), `${prefix}_PROVIDER_NAME`),
    model: safeEvidenceLabel(required(env, `${prefix}_MODEL`), `${prefix}_MODEL`),
    mode: "portable",
    upstreamErrorModel: safeEvidenceLabel(
      required(env, `${prefix}_UPSTREAM_ERROR_MODEL`),
      `${prefix}_UPSTREAM_ERROR_MODEL`
    ),
  };
}

function normalizedBaseUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("CCH_PORTABLE_QUALIFICATION_BASE_URL must use http or https.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("The qualification base URL must not contain credentials, query, or fragment.");
  }
  return url.toString().replace(/\/$/, "").replace(/\/v1$/, "");
}

function absoluteLogPaths(env: NodeJS.ProcessEnv): string[] {
  const raw = required(env, "CCH_PORTABLE_QUALIFICATION_LOG_PATHS_JSON");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("CCH_PORTABLE_QUALIFICATION_LOG_PATHS_JSON must be a JSON array.");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every((item) => typeof item === "string" && item.trim() && isAbsolute(item))
  ) {
    throw new Error(
      "CCH_PORTABLE_QUALIFICATION_LOG_PATHS_JSON must contain absolute log file paths."
    );
  }
  return parsed.map((item) => resolve(item));
}

export function readPortableQualificationConfig(
  env: NodeJS.ProcessEnv,
  repositoryRoot: string
): PortableQualificationConfig | null {
  if (env.CCH_PORTABLE_QUALIFICATION !== "1") return null;

  expectedValue(env, "CCH_PORTABLE_QUALIFICATION_NATIVE_TYPE", "codex");
  expectedValue(env, "CCH_PORTABLE_QUALIFICATION_NATIVE_MODE", "native");
  const evidencePath = resolve(required(env, "CCH_PORTABLE_QUALIFICATION_EVIDENCE_PATH"));
  assertEvidencePathOutsideRepository(evidencePath, repositoryRoot);

  return {
    baseUrl: normalizedBaseUrl(required(env, "CCH_PORTABLE_QUALIFICATION_BASE_URL")),
    adminToken: required(env, "CCH_PORTABLE_QUALIFICATION_ADMIN_TOKEN"),
    proxyKey: required(env, "CCH_PORTABLE_QUALIFICATION_PROXY_KEY"),
    evidencePath,
    logPaths: absoluteLogPaths(env),
    codexBin: env.CCH_PORTABLE_QUALIFICATION_CODEX_BIN?.trim() || "codex",
    codexVersion: safeEvidenceLabel(
      required(env, "CCH_PORTABLE_QUALIFICATION_CODEX_VERSION"),
      "CCH_PORTABLE_QUALIFICATION_CODEX_VERSION"
    ),
    cchCommit: safeEvidenceLabel(
      required(env, "CCH_PORTABLE_QUALIFICATION_CCH_COMMIT"),
      "CCH_PORTABLE_QUALIFICATION_CCH_COMMIT"
    ),
    caseTimeoutMs: duration(env, "CCH_PORTABLE_QUALIFICATION_CASE_TIMEOUT_MS", 180_000),
    cancelAfterMs: duration(env, "CCH_PORTABLE_QUALIFICATION_CANCEL_AFTER_MS", 100),
    native: {
      kind: "native",
      id: positiveInt(env, "CCH_PORTABLE_QUALIFICATION_NATIVE_PROVIDER_ID"),
      name: safeEvidenceLabel(
        required(env, "CCH_PORTABLE_QUALIFICATION_NATIVE_PROVIDER_NAME"),
        "CCH_PORTABLE_QUALIFICATION_NATIVE_PROVIDER_NAME"
      ),
      model: safeEvidenceLabel(
        required(env, "CCH_PORTABLE_QUALIFICATION_NATIVE_MODEL"),
        "CCH_PORTABLE_QUALIFICATION_NATIVE_MODEL"
      ),
      mode: "native",
      upstreamErrorModel: null,
    },
    deepseek: provider(env, "CCH_PORTABLE_QUALIFICATION_DEEPSEEK", "deepseek"),
    glm: provider(env, "CCH_PORTABLE_QUALIFICATION_GLM", "glm"),
  };
}

export function assertEvidencePathOutsideRepository(path: string, repositoryRoot: string): void {
  if (!isAbsolute(path)) throw new Error("Qualification evidence path must be absolute.");
  const rel = relative(resolve(repositoryRoot), resolve(path));
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    throw new Error("Qualification evidence must be written outside the repository.");
  }
}

export function buildQualificationCases(): QualificationCase[] {
  const cases: QualificationCase[] = [];
  for (const kind of ["deepseek", "glm"] as const) {
    for (const historyMode of ["none", "recent", "all"] as const) {
      cases.push({
        caseId: `${kind}_lifecycle_${historyMode}_sse`,
        providerKind: kind,
        operation: "lifecycle",
        historyMode,
        transport: "sse",
        expected: "success",
      });
    }
    cases.push({
      caseId: `${kind}_http_non_stream`,
      providerKind: kind,
      operation: "http_non_stream",
      historyMode: "none",
      transport: "http",
      expected: "success",
    });
    for (const operation of ["cancellation", "timeout", "upstream_error"] as const) {
      cases.push({
        caseId: `${kind}_${operation}_isolation_sse`,
        providerKind: kind,
        operation,
        historyMode: "none",
        transport: "sse",
        expected: "failure_then_recovery",
      });
    }
  }
  cases.push({
    caseId: "native_child_lifecycle_none_sse",
    providerKind: "native",
    operation: "lifecycle",
    historyMode: "none",
    transport: "sse",
    expected: "success",
  });
  cases.push({
    caseId: "native_root_control_sse",
    providerKind: "native",
    operation: "recovery",
    historyMode: "none",
    transport: "sse",
    expected: "success",
  });
  return cases;
}

export function parseCodexJsonl(stdout: string): ParsedCodexRun {
  const parsed: ParsedCodexRun = {
    threadId: null,
    relatedThreadIds: [],
    usage: null,
    finalMessage: null,
    failed: false,
    collabTools: [],
    collabAgentMessages: [],
  };
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type === "thread.started" && typeof event.thread_id === "string") {
      parsed.threadId = event.thread_id;
    }
    if (event.type === "turn.failed" || event.type === "error") parsed.failed = true;
    if (event.type === "turn.completed" && isObject(event.usage)) {
      parsed.usage = {
        inputTokens: numberOrZero(event.usage.input_tokens),
        cachedInputTokens: numberOrZero(event.usage.cached_input_tokens),
        outputTokens: numberOrZero(event.usage.output_tokens),
        reasoningOutputTokens: numberOrZero(event.usage.reasoning_output_tokens),
      };
    }
    if (
      (event.type === "item.completed" || event.type === "item.updated") &&
      isObject(event.item)
    ) {
      if (event.item.type === "agent_message" && typeof event.item.text === "string") {
        parsed.finalMessage = event.item.text;
      }
      if (event.item.type === "collab_tool_call" && typeof event.item.tool === "string") {
        parsed.collabTools.push(event.item.tool);
        if (Array.isArray(event.item.receiver_thread_ids)) {
          for (const receiver of event.item.receiver_thread_ids) {
            if (typeof receiver === "string" && !parsed.relatedThreadIds.includes(receiver)) {
              parsed.relatedThreadIds.push(receiver);
            }
          }
        }
        if (isObject(event.item.agents_states)) {
          for (const state of Object.values(event.item.agents_states)) {
            if (
              isObject(state) &&
              typeof state.message === "string" &&
              !parsed.collabAgentMessages.includes(state.message)
            ) {
              parsed.collabAgentMessages.push(state.message);
            }
          }
        }
      }
    }
  }
  return parsed;
}

export function findPortableAudits(value: unknown): PortableAudit[] {
  const audits: PortableAudit[] = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (!isObject(node)) return;
    if (node.type === "codex_multi_agent_v2_portable" && node.mode === "portable") {
      audits.push(node as unknown as PortableAudit);
    }
    for (const child of Object.values(node)) visit(child);
  };
  visit(value);
  return audits;
}

export function buildEvidence(input: {
  caseInfo: QualificationCase;
  config: PortableQualificationConfig;
  audit?: PortableAudit | null;
  run: ParsedCodexRun;
  /** Usage from the exact usage-log row identified by audit.requestId. */
  usage?: QualificationUsage | null;
  result: QualificationResult;
  stableErrorCode?: string | null;
  actual?: {
    providerId: number | null;
    providerName: string | null;
    model: string | null;
    transport?: "http" | "sse" | "websocket";
  };
}): QualificationEvidence {
  const { caseInfo, config, audit, run, result } = input;
  const configuredProvider = config[caseInfo.providerKind];
  return {
    schemaVersion: 1,
    caseId: caseInfo.caseId,
    recordedAt: new Date().toISOString(),
    codexVersion: config.codexVersion,
    cchCommit: config.cchCommit,
    providerKind: caseInfo.providerKind,
    requestedProviderId: audit?.requestedProviderId ?? configuredProvider.id,
    requestedProviderName: audit?.requestedProviderName ?? configuredProvider.name,
    actualProviderId: audit?.actualProviderId ?? input.actual?.providerId ?? null,
    actualProviderName: audit?.actualProviderName ?? input.actual?.providerName ?? null,
    requestedModel: audit?.requestedModel ?? configuredProvider.model,
    actualModel: audit?.actualModel ?? input.actual?.model ?? null,
    transport: audit ? audit.actualTransport : (input.actual?.transport ?? caseInfo.transport),
    operation: caseInfo.operation,
    historyMode: caseInfo.historyMode,
    result,
    stableErrorCode: input.stableErrorCode ?? audit?.errorCategory ?? null,
    requestId: audit?.requestId ?? null,
    sessionId: audit?.sessionId ?? run.threadId,
    responseId: audit?.responseId ?? null,
    // A root Codex CLI turn may orchestrate a child Provider request. Never label
    // root CLI usage as child usage merely because a child audit was selected.
    usage: Object.hasOwn(input, "usage") ? (input.usage ?? null) : audit ? null : run.usage,
    auditState: audit?.state ?? null,
    responseRestore: audit?.responseRestore ?? null,
    transformations: Array.isArray(audit?.transformations) ? [...audit.transformations] : [],
  };
}

export function serializeSafeEvidence(
  evidence: QualificationEvidence,
  secrets: string[],
  sentinels: string[]
): string {
  assertAllowedEvidenceShape(evidence);
  const serialized = JSON.stringify(evidence);
  if (/https?:\/\//i.test(serialized)) {
    throw new Error("Qualification evidence contains a URL.");
  }
  for (const value of [...secrets, ...sentinels]) {
    if (value && serialized.includes(value)) {
      throw new Error("Qualification evidence contains a protected value.");
    }
  }
  return serialized;
}

export async function appendSafeEvidence(
  path: string,
  evidence: QualificationEvidence,
  secrets: string[],
  sentinels: string[]
): Promise<void> {
  const serialized = serializeSafeEvidence(evidence, secrets, sentinels);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${serialized}\n`, { encoding: "utf8", mode: 0o600 });
}

function assertAllowedEvidenceShape(value: unknown): void {
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (!isObject(node)) return;
    for (const [key, child] of Object.entries(node)) {
      if (FORBIDDEN_EVIDENCE_KEYS.has(key.toLowerCase())) {
        throw new Error(`Qualification evidence contains forbidden field: ${key}`);
      }
      visit(child);
    }
  };
  visit(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
