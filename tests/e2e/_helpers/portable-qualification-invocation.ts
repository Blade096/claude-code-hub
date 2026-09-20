import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import process from "node:process";
import type { PortableQualificationConfig, QualificationProvider } from "./portable-qualification";

export type CodexInvocation = { command: string; prefix: string[]; display: string };
export type CodexProcessResult = {
  code: number | null;
  stdout: string;
  cancelled: boolean;
  timedOut: boolean;
};

const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const tempHomes = new Set<string>();

function tomlString(value: string): string {
  return JSON.stringify(value);
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

export function resolveCodexInvocation(codexBin: string): CodexInvocation {
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

export async function writeCodexHome(
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

export async function runCodexProcess(
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

export function baseExecArgs(workdir: string): string[] {
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

export function resumeArgs(threadId: string, schemaPath?: string): string[] {
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

export async function cleanupQualificationHomes(): Promise<void> {
  for (const home of tempHomes) await rm(home, { recursive: true, force: true });
  tempHomes.clear();
}
