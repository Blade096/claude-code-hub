import { spawn, spawnSync } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  appendSafeEvidence,
  buildEvidence,
  buildQualificationCases,
  findPortableAudits,
  parseCodexJsonl,
  readPortableQualificationConfig,
  type ParsedCodexRun,
  type PortableAudit,
  type PortableQualificationConfig,
  type QualificationCase,
  type QualificationProvider,
} from "./_helpers/portable-qualification";

/**
 * Real-provider qualification for Codex MultiAgentV2 portable mode.
 *
 * This suite is deliberately absent from default CI execution. It runs only
 * when CCH_PORTABLE_QUALIFICATION=1 and every required, explicit provider
 * identity is supplied. See docs/codex-multi-agent-v2-portable-operations.md.
 * Raw Codex JSONL, stderr, tool arguments and upstream bodies are not written
 * as long-lived harness artifacts. Multi-turn history uses a temporary
 * CODEX_HOME which may contain prompt plaintext and is deleted after the suite.
 * The only intended persistent artifact is allowlisted JSONL evidence.
 */

type CodexInvocation = { command: string; prefix: string[]; display: string };
type CodexProcessResult = {
  code: number | null;
  stdout: string;
  cancelled: boolean;
  timedOut: boolean;
};
type LifecycleResult = {
  run: ParsedCodexRun;
  audits: PortableAudit[];
  sentinels: string[];
  lifecycle: LifecycleOutput | null;
  code: number | null;
  cancelled: boolean;
  timedOut: boolean;
};

type LifecycleOutput = {
  case_id: string;
  spawn_agent: boolean;
  send_message_while_running: boolean;
  followup_task_after_completion: boolean;
  parent_received_results: boolean;
  inherited_history_markers: string[];
  live_nonce: string;
  followup_nonce: string;
};

const repositoryRoot = resolve(__dirname, "../..");
const config = readPortableQualificationConfig(process.env, repositoryRoot);
const runReal = config ? describe : describe.skip;
const tempHomes = new Set<string>();
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function randomMarker(label: string): string {
  return `PORTABLE_${label}_${crypto.randomUUID()}`;
}

function resolveWindowsCmdPath(cmdPath: string): string {
  if (isAbsolute(cmdPath) || cmdPath.includes("/") || cmdPath.includes("\\")) return cmdPath;
  const result = spawnSync("where.exe", [cmdPath], { encoding: "utf8", windowsHide: true });
  const resolved = result.stdout
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!resolved) throw new Error("Configured Codex CLI could not be resolved on PATH.");
  return resolved;
}

function resolveCodexInvocation(codexBin: string): CodexInvocation {
  if (process.platform !== "win32") {
    return { command: codexBin, prefix: [], display: codexBin };
  }
  const cmdPath = resolveWindowsCmdPath(codexBin);
  if (!/\.cmd$/i.test(cmdPath)) {
    return { command: cmdPath, prefix: [], display: codexBin };
  }
  const scriptPath = join(dirname(cmdPath), "node_modules", "@openai", "codex", "bin", "codex.js");
  if (!existsSync(scriptPath)) throw new Error("Codex CLI JavaScript entrypoint is missing.");
  const bundledNode = join(dirname(cmdPath), "node.exe");
  return {
    command: existsSync(bundledNode) ? bundledNode : process.execPath,
    prefix: [scriptPath],
    display: codexBin,
  };
}

async function writeCodexHome(
  qualification: PortableQualificationConfig,
  target: QualificationProvider,
  transport: "sse" | "websocket",
  options: { targetModel?: string; targetIdleTimeoutMs?: number } = {}
): Promise<{ home: string; schemaPath: string; workdir: string }> {
  const home = await mkdtemp(join(tmpdir(), "cch-portable-qualification-"));
  tempHomes.add(home);
  const agentsDir = join(home, "agents");
  const workdir = join(home, "workspace");
  await Promise.all([mkdir(agentsDir, { recursive: true }), mkdir(workdir, { recursive: true })]);

  const supportsWebsockets = transport === "websocket";
  const providerToml = (name: string, idleTimeout?: number) => [
    `[model_providers.${name}]`,
    `name = ${tomlString(name)}`,
    `base_url = ${tomlString(`${qualification.baseUrl}/v1`)}`,
    'env_key = "CCH_PORTABLE_QUALIFICATION_PROXY_KEY"',
    'wire_api = "responses"',
    `supports_websockets = ${supportsWebsockets}`,
    "request_max_retries = 0",
    "stream_max_retries = 0",
    ...(idleTimeout ? [`stream_idle_timeout_ms = ${idleTimeout}`] : []),
    "",
  ];
  const configToml = [
    `model = ${tomlString(qualification.native.model)}`,
    'model_provider = "cch_qualification_root"',
    'approval_policy = "never"',
    'sandbox_mode = "read-only"',
    "",
    "[features]",
    "multi_agent_v2 = true",
    "",
    "[agents]",
    "enabled = true",
    "max_concurrent_threads_per_session = 4",
    "",
    `[agents.${target.kind}]`,
    `description = ${tomlString(`Real ${target.kind} portable qualification role.`)}`,
    `config_file = ${tomlString(`agents/${target.kind}.toml`)}`,
    "",
    ...providerToml("cch_qualification_root"),
    ...providerToml("cch_qualification_target", options.targetIdleTimeoutMs),
  ].join("\n");
  const roleToml = [
    `model = ${tomlString(options.targetModel ?? target.model)}`,
    'model_provider = "cch_qualification_target"',
    'approval_policy = "never"',
    'sandbox_mode = "read-only"',
    "",
  ].join("\n");
  const schemaPath = join(home, "lifecycle-output.schema.json");
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      case_id: { type: "string" },
      spawn_agent: { type: "boolean" },
      send_message_while_running: { type: "boolean" },
      followup_task_after_completion: { type: "boolean" },
      parent_received_results: { type: "boolean" },
      inherited_history_markers: { type: "array", items: { type: "string" } },
      live_nonce: { type: "string" },
      followup_nonce: { type: "string" },
    },
    required: [
      "case_id",
      "spawn_agent",
      "send_message_while_running",
      "followup_task_after_completion",
      "parent_received_results",
      "inherited_history_markers",
      "live_nonce",
      "followup_nonce",
    ],
  };

  await Promise.all([
    writeFile(join(home, "config.toml"), configToml, { encoding: "utf8", mode: 0o600 }),
    writeFile(join(agentsDir, `${target.kind}.toml`), roleToml, { encoding: "utf8", mode: 0o600 }),
    writeFile(schemaPath, JSON.stringify(schema), { encoding: "utf8", mode: 0o600 }),
  ]);
  return { home, schemaPath, workdir };
}

function terminateOwnedProcess(child: ReturnType<typeof spawn>): void {
  if (!child.pid || child.killed) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
      windowsHide: true,
      stdio: "ignore",
    });
  } else {
    child.kill("SIGTERM");
  }
}

async function runCodexProcess(
  invocation: CodexInvocation,
  args: string[],
  home: string,
  timeoutMs: number,
  cancelAfterMs?: number
): Promise<CodexProcessResult> {
  const child = spawn(invocation.command, [...invocation.prefix, ...args], {
    cwd: home,
    env: { ...process.env, CODEX_HOME: home, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let capturedBytes = 0;
  let cancelled = false;
  let timedOut = false;
  let cancelTimer: ReturnType<typeof setTimeout> | undefined;
  const capture = (chunk: Buffer) => {
    capturedBytes += chunk.byteLength;
    if (capturedBytes > MAX_CAPTURE_BYTES) {
      timedOut = true;
      terminateOwnedProcess(child);
      return;
    }
    stdout += chunk.toString("utf8");
    if (
      cancelAfterMs &&
      !cancelTimer &&
      /"type":"collab_tool_call".*"tool":"spawn_agent"/.test(stdout)
    ) {
      cancelTimer = setTimeout(() => {
        cancelled = true;
        terminateOwnedProcess(child);
      }, cancelAfterMs);
    }
  };
  child.stdout.on("data", capture);
  // stderr is deliberately consumed but never retained or included in failures/evidence.
  child.stderr.on("data", () => undefined);

  const timeout = setTimeout(() => {
    timedOut = true;
    terminateOwnedProcess(child);
  }, timeoutMs);

  let code: number | null;
  try {
    code = await new Promise<number | null>((resolveCode, reject) => {
      child.once("error", reject);
      child.once("close", resolveCode);
    });
  } finally {
    clearTimeout(timeout);
    if (cancelTimer) clearTimeout(cancelTimer);
  }
  return { code, stdout, cancelled, timedOut };
}

function parseLifecycleOutput(message: string | null): LifecycleOutput | null {
  if (!message) return null;
  try {
    const parsed = JSON.parse(message) as Partial<LifecycleOutput>;
    if (
      typeof parsed.case_id !== "string" ||
      typeof parsed.spawn_agent !== "boolean" ||
      typeof parsed.send_message_while_running !== "boolean" ||
      typeof parsed.followup_task_after_completion !== "boolean" ||
      typeof parsed.parent_received_results !== "boolean" ||
      !Array.isArray(parsed.inherited_history_markers) ||
      !parsed.inherited_history_markers.every((item) => typeof item === "string") ||
      typeof parsed.live_nonce !== "string" ||
      typeof parsed.followup_nonce !== "string"
    ) {
      return null;
    }
    return parsed as LifecycleOutput;
  } catch {
    return null;
  }
}

function historyForkValue(mode: QualificationCase["historyMode"]): string {
  if (mode === "none") return "none";
  if (mode === "recent") return "1";
  return "all";
}

function lifecyclePrompt(
  caseInfo: QualificationCase,
  target: QualificationProvider,
  liveNonce: string,
  followupNonce: string
): string {
  return [
    `Qualification case ${caseInfo.caseId}.`,
    `Spawn exactly one ${target.kind} role agent with agent_type=${target.kind} and fork_turns=${historyForkValue(caseInfo.historyMode)}.`,
    "The spawn task must ask the child to report every inherited marker beginning PORTABLE_HISTORY_ without giving it any marker value.",
    `Immediately after spawn_agent returns, while the child is still running, call send_message with this live nonce: ${liveNonce}. Do not wait first.`,
    "Wait for that child to complete.",
    `After it is completed, call followup_task with this follow-up nonce: ${followupNonce}, then wait for completion again.`,
    "Do not put any PORTABLE_HISTORY_ marker value into spawn_agent, send_message, or followup_task arguments.",
    "Return only the required JSON. Set the four lifecycle booleans from actions actually completed, copy markers actually reported by the child, and copy both nonces only if the child acknowledged them.",
  ].join("\n");
}

function baseExecArgs(workdir: string): string[] {
  return [
    "exec",
    "--ignore-rules",
    "--strict-config",
    "--skip-git-repo-check",
    "--json",
    "-C",
    workdir,
  ];
}

function resumeArgs(threadId: string, schemaPath?: string): string[] {
  return [
    "exec",
    "resume",
    "--all",
    "--ignore-rules",
    "--strict-config",
    "--skip-git-repo-check",
    "--json",
    ...(schemaPath ? ["--output-schema", schemaPath] : []),
    threadId,
  ];
}

function usageLogUrl(
  qualification: PortableQualificationConfig,
  filters: Record<string, string | number>
): string {
  const url = new URL(`${qualification.baseUrl}/api/v1/usage-logs`);
  url.searchParams.set("limit", "100");
  for (const [key, value] of Object.entries(filters)) url.searchParams.set(key, String(value));
  return url.toString();
}

async function fetchUsageLogs(
  qualification: PortableQualificationConfig,
  filters: Record<string, string | number>
): Promise<unknown> {
  const response = await fetch(usageLogUrl(qualification, filters), {
    headers: { Authorization: `Bearer ${qualification.adminToken}` },
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Usage-log inspection failed with HTTP ${response.status}.`);
  }
  return response.json();
}

function assertNoProtectedText(value: unknown, protectedValues: string[]): void {
  const serialized = JSON.stringify(value);
  for (const protectedValue of protectedValues) {
    if (protectedValue && serialized.includes(protectedValue)) {
      throw new Error("A qualification sentinel appeared in the usage-log API response.");
    }
  }
}

async function assertOperationalLogsClean(
  paths: string[],
  protectedValues: string[]
): Promise<void> {
  await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  const longest = Math.max(1, ...protectedValues.map((value) => value.length));
  for (const path of paths) {
    let tail = "";
    try {
      for await (const chunk of createReadStream(path, { encoding: "utf8" })) {
        const text = tail + chunk;
        if (protectedValues.some((value) => value && text.includes(value))) {
          throw new Error("An operational log contains a protected qualification value.");
        }
        tail = text.slice(-Math.max(0, longest - 1));
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("protected qualification value")) {
        throw error;
      }
      throw new Error("An operational log could not be scanned.");
    }
  }
}

async function inspectPortableAudits(
  qualification: PortableQualificationConfig,
  run: ParsedCodexRun,
  target: QualificationProvider,
  targetModel: string,
  startedAt: number,
  protectedValues: string[]
): Promise<PortableAudit[]> {
  const sessionIds = [run.threadId, ...run.relatedThreadIds].filter((value): value is string =>
    Boolean(value)
  );
  let inspected: unknown[] = [];
  for (let attempt = 0; attempt < 15; attempt++) {
    inspected = [];
    for (const sessionId of sessionIds) {
      inspected.push(await fetchUsageLogs(qualification, { sessionId }));
    }
    let audits = findPortableAudits(inspected);
    if (audits.length === 0) {
      const providerLogs = await fetchUsageLogs(qualification, {
        providerId: target.id,
        model: targetModel,
        startTime: startedAt - 5_000,
      });
      inspected.push(providerLogs);
      audits = findPortableAudits(inspected);
    }
    assertNoProtectedText(inspected, protectedValues);
    if (audits.some((item) => item.state === "response_restored" || item.state === "failed")) {
      return audits;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
  return findPortableAudits(inspected);
}

function terminalAudit(audits: PortableAudit[]): PortableAudit | null {
  return (
    audits.find((item) => item.state === "failed") ??
    audits.find((item) => item.state === "response_restored") ??
    null
  );
}

async function executeLifecycle(
  qualification: PortableQualificationConfig,
  invocation: CodexInvocation,
  caseInfo: QualificationCase,
  options: {
    targetModel?: string;
    targetIdleTimeoutMs?: number;
    cancelFinalAfterMs?: number;
  } = {}
): Promise<LifecycleResult> {
  if (caseInfo.providerKind === "native")
    throw new Error("Native control is not a child lifecycle.");
  const target = qualification[caseInfo.providerKind];
  const { home, schemaPath, workdir } = await writeCodexHome(
    qualification,
    target,
    caseInfo.transport,
    options
  );
  const oldMarker = randomMarker("HISTORY_OLD");
  const recentMarker = randomMarker("HISTORY_RECENT");
  const liveNonce = randomMarker("LIVE_NONCE");
  const followupNonce = randomMarker("FOLLOWUP_NONCE");
  const sentinels = [oldMarker, recentMarker, liveNonce, followupNonce];
  const startedAt = Date.now();

  const first = await runCodexProcess(
    invocation,
    [...baseExecArgs(workdir), `Remember completed-turn marker ${oldMarker}. Reply ACK only.`],
    home,
    qualification.caseTimeoutMs
  );
  const firstRun = parseCodexJsonl(first.stdout);
  if (first.code !== 0 || !firstRun.threadId) {
    throw new Error(`Qualification ${caseInfo.caseId} could not establish its first root turn.`);
  }

  const second = await runCodexProcess(
    invocation,
    [
      ...resumeArgs(firstRun.threadId),
      `Remember completed-turn marker ${recentMarker}. Reply ACK only.`,
    ],
    home,
    qualification.caseTimeoutMs
  );
  if (second.code !== 0) {
    throw new Error(`Qualification ${caseInfo.caseId} could not establish its recent root turn.`);
  }

  const final = await runCodexProcess(
    invocation,
    [
      ...resumeArgs(firstRun.threadId, schemaPath),
      lifecyclePrompt(caseInfo, target, liveNonce, followupNonce),
    ],
    home,
    qualification.caseTimeoutMs,
    options.cancelFinalAfterMs
  );
  const run = parseCodexJsonl(final.stdout);
  if (!run.threadId) run.threadId = firstRun.threadId;
  const audits = await inspectPortableAudits(
    qualification,
    run,
    target,
    options.targetModel ?? target.model,
    startedAt,
    sentinels
  );
  return {
    run,
    audits,
    sentinels,
    lifecycle: parseLifecycleOutput(run.finalMessage),
    code: final.code,
    cancelled: final.cancelled,
    timedOut: final.timedOut,
  };
}

function requireQualification(
  condition: unknown,
  caseId: string,
  reason: string
): asserts condition {
  if (!condition) throw new Error(`Qualification ${caseId} failed: ${reason}.`);
}

function expectedHistoryMarkers(mode: QualificationCase["historyMode"], sentinels: string[]) {
  if (mode === "none") return [];
  if (mode === "recent") return [sentinels[1]!];
  return [sentinels[0]!, sentinels[1]!];
}

function validateSuccessfulLifecycle(
  caseInfo: QualificationCase,
  target: QualificationProvider,
  result: LifecycleResult
): PortableAudit {
  requireQualification(
    result.code === 0 && !result.cancelled,
    caseInfo.caseId,
    "CLI did not finish"
  );
  requireQualification(result.lifecycle, caseInfo.caseId, "structured lifecycle result is missing");
  const lifecycle = result.lifecycle;
  requireQualification(lifecycle.case_id === caseInfo.caseId, caseInfo.caseId, "case id mismatch");
  requireQualification(
    lifecycle.spawn_agent &&
      lifecycle.send_message_while_running &&
      lifecycle.followup_task_after_completion &&
      lifecycle.parent_received_results,
    caseInfo.caseId,
    "the full collaboration lifecycle was not observed"
  );
  requireQualification(
    lifecycle.live_nonce === result.sentinels[2] &&
      lifecycle.followup_nonce === result.sentinels[3],
    caseInfo.caseId,
    "the child did not return both lifecycle nonces"
  );
  const expectedMarkers = expectedHistoryMarkers(caseInfo.historyMode, result.sentinels);
  requireQualification(
    lifecycle.inherited_history_markers.length === expectedMarkers.length &&
      expectedMarkers.every((marker) => lifecycle.inherited_history_markers.includes(marker)),
    caseInfo.caseId,
    "history inheritance did not match fork_turns"
  );
  requireQualification(
    ["spawn_agent", "send_message", "followup_task"].every((tool) =>
      result.run.collabTools.includes(tool)
    ),
    caseInfo.caseId,
    "Codex JSONL did not contain the complete collaboration action sequence"
  );
  const directChildText = result.run.collabAgentMessages.join("\n");
  requireQualification(
    directChildText.includes(result.sentinels[2]!) &&
      directChildText.includes(result.sentinels[3]!),
    caseInfo.caseId,
    "Codex child result events did not contain both lifecycle nonces"
  );
  requireQualification(
    expectedMarkers.every((marker) => directChildText.includes(marker)) &&
      result.sentinels
        .slice(0, 2)
        .filter((marker) => !expectedMarkers.includes(marker))
        .every((marker) => !directChildText.includes(marker)),
    caseInfo.caseId,
    "direct child result events did not match the requested history boundary"
  );

  const restored = result.audits.filter((item) => item.state === "response_restored");
  requireQualification(restored.length >= 2, caseInfo.caseId, "child turns lack restored audits");
  for (const item of restored) {
    requireQualification(
      item.requestedProviderId === target.id &&
        item.requestedProviderName === target.name &&
        item.actualProviderId === target.id &&
        item.actualProviderName === target.name,
      caseInfo.caseId,
      "requested or actual provider differs from the configured portable provider"
    );
    requireQualification(
      item.requestedModel === target.model && item.actualModel === target.model,
      caseInfo.caseId,
      "requested or actual model differs from the configured portable model"
    );
    requireQualification(
      item.actualTransport === caseInfo.transport,
      caseInfo.caseId,
      "actual transport differs from the requested transport"
    );
    requireQualification(
      item.responseRestore === "restored" && item.errorCategory === null,
      caseInfo.caseId,
      "response restore did not finish cleanly"
    );
    requireQualification(
      item.requestId !== null && item.sessionId !== null && item.responseId !== null,
      caseInfo.caseId,
      "portable audit correlation identifiers are incomplete"
    );
  }
  requireQualification(
    restored.some((item) => item.transformations.includes("agent_message_input")),
    caseInfo.caseId,
    "agent_message compatibility transformation was not audited"
  );
  return restored[0]!;
}

function validateUnsupportedWebsocket(
  caseInfo: QualificationCase,
  target: QualificationProvider,
  result: LifecycleResult
): PortableAudit {
  const failed = result.audits.find(
    (item) =>
      item.state === "failed" && item.errorCategory === "compatibility_transport_unsupported"
  );
  requireQualification(failed, caseInfo.caseId, "stable transport capability error is missing");
  requireQualification(
    failed.requestedTransport === "websocket" &&
      failed.actualTransport !== "http" &&
      failed.actualTransport !== "sse",
    caseInfo.caseId,
    "unsupported websocket silently changed transport"
  );
  requireQualification(
    (failed.actualProviderId === null || failed.actualProviderId === target.id) &&
      (failed.requestedProviderId === null || failed.requestedProviderId === target.id),
    caseInfo.caseId,
    "unsupported websocket switched providers"
  );
  return failed;
}

function lifecycleCaseForRecovery(source: QualificationCase): QualificationCase {
  return {
    caseId: `${source.caseId}_recovery`,
    providerKind: source.providerKind,
    operation: "recovery",
    historyMode: "none",
    transport: "sse",
    expected: "success",
  };
}

function auditSessionIds(audits: PortableAudit[]): Set<string> {
  return new Set(
    audits
      .map((item) => item.sessionId)
      .filter((value): value is string => typeof value === "string")
  );
}

function usageItems(value: unknown): Array<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const items = (value as Record<string, unknown>).items;
  return Array.isArray(items)
    ? items.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item)
      )
    : [];
}

async function assertNativeRootUsage(
  qualification: PortableQualificationConfig,
  run: ParsedCodexRun,
  caseId: string,
  protectedValues: string[]
): Promise<void> {
  requireQualification(run.threadId, caseId, "native root thread id is missing");
  let inspected: unknown = null;
  for (let attempt = 0; attempt < 15; attempt++) {
    inspected = await fetchUsageLogs(qualification, { sessionId: run.threadId });
    assertNoProtectedText(inspected, protectedValues);
    const nativeLog = usageItems(inspected).find(
      (item) =>
        item.providerId === qualification.native.id &&
        item.providerName === qualification.native.name &&
        (item.model === qualification.native.model ||
          item.originalModel === qualification.native.model)
    );
    if (nativeLog) {
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
  throw new Error(`Qualification ${caseId} failed: native root usage log is missing.`);
}

runReal("real Codex MultiAgentV2 portable qualification", () => {
  if (!config) {
    test.skip("requires CCH_PORTABLE_QUALIFICATION=1 and explicit real-provider config", () => {});
    return;
  }
  const qualification: PortableQualificationConfig = config;
  const invocation = resolveCodexInvocation(qualification.codexBin);
  const cases = buildQualificationCases(
    qualification.deepseek.websocketCapability as "supported" | "unsupported",
    qualification.glm.websocketCapability as "supported" | "unsupported"
  );
  const secrets = [qualification.adminToken, qualification.proxyKey];

  beforeAll(() => {
    const version = spawnSync(invocation.command, [...invocation.prefix, "--version"], {
      encoding: "utf8",
      windowsHide: true,
    });
    requireQualification(version.status === 0, "preflight", "Codex CLI is unavailable");
    requireQualification(
      version.stdout.trim() === qualification.codexVersion,
      "preflight",
      "configured Codex version differs from the executable"
    );
  });

  afterAll(async () => {
    for (const home of tempHomes) {
      await rm(home, { recursive: true, force: true });
    }
    tempHomes.clear();
  });

  for (const caseInfo of cases.filter((item) => item.operation === "lifecycle")) {
    test(
      caseInfo.caseId,
      async () => {
        const target = qualification[caseInfo.providerKind as "deepseek" | "glm"];
        const result = await executeLifecycle(qualification, invocation, caseInfo);
        await assertNativeRootUsage(
          qualification,
          result.run,
          caseInfo.caseId,
          result.sentinels
        );
        const audit =
          caseInfo.expected === "capability_error"
            ? validateUnsupportedWebsocket(caseInfo, target, result)
            : validateSuccessfulLifecycle(caseInfo, target, result);
        const evidence = buildEvidence({
          caseInfo,
          config: qualification,
          audit,
          run: result.run,
          result: caseInfo.expected === "capability_error" ? "unsupported" : "passed",
        });
        await assertOperationalLogsClean(qualification.logPaths, [...secrets, ...result.sentinels]);
        await appendSafeEvidence(qualification.evidencePath, evidence, secrets, result.sentinels);
      },
      qualification.caseTimeoutMs * 5
    );
  }

  for (const caseInfo of cases.filter(
    (item) =>
      item.operation === "cancellation" ||
      item.operation === "timeout" ||
      item.operation === "upstream_error"
  )) {
    test(
      caseInfo.caseId,
      async () => {
        const target = qualification[caseInfo.providerKind as "deepseek" | "glm"];
        const faultOptions =
          caseInfo.operation === "cancellation"
            ? { cancelFinalAfterMs: qualification.cancelAfterMs }
            : caseInfo.operation === "timeout"
              ? { targetIdleTimeoutMs: 250 }
              : { targetModel: target.upstreamErrorModel ?? undefined };
        const fault = await executeLifecycle(qualification, invocation, caseInfo, faultOptions);
        if (caseInfo.operation === "cancellation") {
          requireQualification(
            fault.cancelled && !fault.timedOut,
            caseInfo.caseId,
            "Codex process was not cancelled after the child spawn event"
          );
        } else {
          requireQualification(
            fault.audits.some((item) => item.state === "failed") || fault.run.failed,
            caseInfo.caseId,
            "the injected fault did not fail"
          );
        }

        const recoveryCase = lifecycleCaseForRecovery(caseInfo);
        const recovery = await executeLifecycle(qualification, invocation, recoveryCase);
        const recoveryAudit = validateSuccessfulLifecycle(recoveryCase, target, recovery);
        const faultSessions = auditSessionIds(fault.audits);
        const recoverySessions = auditSessionIds(recovery.audits);
        requireQualification(
          [...faultSessions].every((sessionId) => !recoverySessions.has(sessionId)),
          caseInfo.caseId,
          "fault and recovery reused logical-thread audit metadata"
        );
        const faultResponseIds = new Set(
          fault.audits
            .map((item) => item.responseId)
            .filter((item): item is string => Boolean(item))
        );
        requireQualification(
          recovery.audits.every(
            (item) => item.responseId === null || !faultResponseIds.has(item.responseId)
          ),
          caseInfo.caseId,
          "fault response metadata leaked into recovery"
        );

        await assertOperationalLogsClean(qualification.logPaths, [
          ...secrets,
          ...fault.sentinels,
          ...recovery.sentinels,
        ]);

        await appendSafeEvidence(
          qualification.evidencePath,
          buildEvidence({
            caseInfo,
            config: qualification,
            audit: terminalAudit(fault.audits) ?? fault.audits.at(-1) ?? null,
            run: fault.run,
            result: "passed",
          }),
          secrets,
          fault.sentinels
        );
        await appendSafeEvidence(
          qualification.evidencePath,
          buildEvidence({
            caseInfo: recoveryCase,
            config: qualification,
            audit: recoveryAudit,
            run: recovery.run,
            result: "passed",
          }),
          secrets,
          recovery.sentinels
        );
      },
      qualification.caseTimeoutMs * 10
    );
  }

  const nativeCase = cases.find((item) => item.providerKind === "native")!;
  test(
    nativeCase.caseId,
    async () => {
      const { home, workdir } = await writeCodexHome(qualification, qualification.deepseek, "sse");
      const sentinel = randomMarker("NATIVE_CONTROL");
      const startedAt = Date.now();
      const processResult = await runCodexProcess(
        invocation,
        [...baseExecArgs(workdir), `Reply exactly ${sentinel}. Do not use tools.`],
        home,
        qualification.caseTimeoutMs
      );
      const run = parseCodexJsonl(processResult.stdout);
      requireQualification(
        processResult.code === 0 && run.finalMessage?.includes(sentinel) && run.threadId,
        nativeCase.caseId,
        "native root control did not complete"
      );
      const logs = await fetchUsageLogs(qualification, {
        sessionId: run.threadId,
        startTime: startedAt - 5_000,
      });
      assertNoProtectedText(logs, [sentinel]);
      const nativeLog = usageItems(logs).find(
        (item) =>
          item.providerName === qualification.native.name &&
          (item.model === qualification.native.model ||
            item.originalModel === qualification.native.model)
      );
      requireQualification(nativeLog, nativeCase.caseId, "native provider usage log is missing");
      requireQualification(
        findPortableAudits(logs).length === 0,
        nativeCase.caseId,
        "native control unexpectedly produced a portable audit"
      );
      await assertOperationalLogsClean(qualification.logPaths, [...secrets, sentinel]);
      await appendSafeEvidence(
        qualification.evidencePath,
        buildEvidence({
          caseInfo: nativeCase,
          config: qualification,
          run,
          result: "passed",
          actual: {
            providerId: qualification.native.id,
            providerName: qualification.native.name,
            model: qualification.native.model,
            transport: "sse",
          },
        }),
        secrets,
        [sentinel]
      );
    },
    qualification.caseTimeoutMs * 2
  );
});
