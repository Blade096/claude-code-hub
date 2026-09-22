import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterAll, describe, expect, test } from "vitest";
import { resolveCodexInvocation } from "./_helpers/portable-qualification-invocation";

const run = process.env.CCH_CODEX_COLLABORATION_MODE_E2E === "1" ? describe : describe.skip;
const homes = new Set<string>();
const servers = new Set<Server>();

type CapturedRequest = Record<string, unknown>;

function responseEnvelope(id: string, model: string, output: Record<string, unknown>[]) {
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model,
    status: "completed",
    output,
    usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
  };
}

function writeEvents(response: import("node:http").ServerResponse, events: unknown[]) {
  response.statusCode = 200;
  response.setHeader("content-type", "text/event-stream");
  for (const event of events) {
    const type = (event as { type: string }).type;
    response.write(`event: ${type}\n`);
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  response.end();
}

function writeTextResponse(
  response: import("node:http").ServerResponse,
  model: string,
  text: string
) {
  const item = {
    id: `msg_${model}`,
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text }],
  };
  const envelope = responseEnvelope(`resp_${model}`, model, [item]);
  writeEvents(response, [
    { type: "response.created", response: { ...envelope, output: [] } },
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
    { type: "response.output_text.done", output_index: 0, content_index: 0, text },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: envelope },
  ]);
}

function writeSpawnResponse(
  response: import("node:http").ServerResponse,
  plaintext: boolean,
  message: string
) {
  const argumentsJson = JSON.stringify({
    task_name: "probe_worker",
    message,
    agent_type: "probe",
    model: "gpt-5.6-terra",
    fork_turns: "none",
  });
  const item: Record<string, unknown> = {
    id: "fc_spawn",
    type: "function_call",
    status: "completed",
    call_id: "call_spawn",
    namespace: "collaboration",
    name: "spawn_agent",
    arguments: argumentsJson,
  };
  if (plaintext) item.encrypted_function_args = [];
  const envelope = responseEnvelope("resp_spawn", "gpt-5.5", [item]);
  writeEvents(response, [
    { type: "response.created", response: { ...envelope, output: [] } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, arguments: "" },
    },
    {
      type: "response.function_call_arguments.delta",
      item_id: "fc_spawn",
      output_index: 0,
      delta: argumentsJson,
    },
    {
      type: "response.function_call_arguments.done",
      item_id: "fc_spawn",
      output_index: 0,
      arguments: argumentsJson,
    },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: envelope },
  ]);
}

async function readJson(request: import("node:http").IncomingMessage): Promise<CapturedRequest> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as CapturedRequest;
}

async function startServer(plaintext: boolean, sentinel: string) {
  const requests: CapturedRequest[] = [];
  let rootRequests = 0;
  let markChildSeen: (() => void) | undefined;
  const childSeen = new Promise<void>((resolve) => {
    markChildSeen = resolve;
  });
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/v1/models") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          object: "list",
          data: ["gpt-5.5", "gpt-5.6-terra"].map((id) => ({ id, object: "model" })),
        })
      );
      return;
    }
    if (request.method !== "POST" || url.pathname !== "/v1/responses") {
      response.statusCode = 404;
      response.end();
      return;
    }

    const body = await readJson(request);
    requests.push(body);
    if (body.model === "gpt-5.6-terra") {
      markChildSeen?.();
      writeTextResponse(response, "gpt-5.6-terra", "CHILD_DONE");
      return;
    }
    rootRequests += 1;
    if (rootRequests === 1) {
      writeSpawnResponse(response, plaintext, sentinel);
      return;
    }
    await Promise.race([
      childSeen,
      new Promise<void>((resolve) => {
        setTimeout(resolve, 5_000);
      }),
    ]);
    writeTextResponse(response, "gpt-5.5", "ROOT_DONE");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.add(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Mock server did not bind TCP.");
  return { port: address.port, requests };
}

async function writeHome(port: number) {
  const home = await mkdtemp(join(tmpdir(), "cch-collaboration-mode-"));
  homes.add(home);
  await mkdir(join(home, "agents"), { recursive: true });
  await writeFile(
    join(home, "config.toml"),
    [
      'model = "gpt-5.5"',
      'model_provider = "local_probe"',
      'approval_policy = "never"',
      'sandbox_mode = "read-only"',
      "",
      "[features]",
      "multi_agent_v2 = true",
      "plugins = false",
      "",
      "[agents]",
      "enabled = true",
      "max_concurrent_threads_per_session = 2",
      "",
      "[agents.probe]",
      'description = "Isolated collaboration transport probe."',
      'config_file = "agents/probe.toml"',
      "",
      "[model_providers.local_probe]",
      'name = "local_probe"',
      `base_url = "http://127.0.0.1:${port}/v1"`,
      'env_key = "CCH_COLLABORATION_MODE_E2E_KEY"',
      'wire_api = "responses"',
      "supports_websockets = false",
      "request_max_retries = 0",
      "stream_max_retries = 0",
      "",
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    join(home, "agents", "probe.toml"),
    [
      'model = "gpt-5.6-terra"',
      'model_provider = "local_probe"',
      'approval_policy = "never"',
      'sandbox_mode = "read-only"',
      "",
    ].join("\n"),
    "utf8"
  );
  return home;
}

async function runCodex(home: string) {
  const invocation = resolveCodexInvocation(process.env.CCH_CODEX_E2E_BIN ?? "codex.cmd");
  const child = spawn(
    invocation.command,
    [
      ...invocation.prefix,
      "exec",
      "--ignore-rules",
      "--strict-config",
      "--ephemeral",
      "--skip-git-repo-check",
      "--json",
      "-C",
      home,
      "Spawn the probe worker exactly once, then finish.",
    ],
    {
      cwd: home,
      env: {
        ...process.env,
        CODEX_HOME: home,
        CODEX_SQLITE_HOME: home,
        CCH_COLLABORATION_MODE_E2E_KEY: "sk-local-placeholder",
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }
  );
  let stderr = "";
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  const timeout = setTimeout(() => child.kill(), 30_000);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  clearTimeout(timeout);
  expect(code, stderr).toBe(0);
  return { stdout, stderr };
}

function childAgentMessage(requests: CapturedRequest[], diagnostics: unknown) {
  const childRequest = requests.find((request) => request.model === "gpt-5.6-terra");
  expect(childRequest, JSON.stringify({ requests, diagnostics }, null, 2)).toBeDefined();
  const input = childRequest?.input as Array<Record<string, unknown>>;
  return input.findLast((item) => item.type === "agent_message") as Record<string, unknown>;
}

afterAll(async () => {
  await Promise.all(
    [...servers].map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  servers.clear();
  await Promise.all([...homes].map((home) => rm(home, { recursive: true, force: true })));
  homes.clear();
});

run("Codex CLI collaboration message mode", () => {
  test.each([
    [true, "input_text", "PLAINTEXT_SENTINEL"],
    [false, "encrypted_content", "OPAQUE_SENTINEL"],
  ] as const)(
    "marker=%s produces %s",
    async (plaintext, expectedType, sentinel) => {
      const probe = await startServer(plaintext, sentinel);
      const home = await writeHome(probe.port);

      const diagnostics = await runCodex(home);

      const agentMessage = childAgentMessage(probe.requests, diagnostics);
      const content = agentMessage.content as Array<Record<string, unknown>>;
      const payloadPart = content.find((part) => part.type === expectedType);
      expect(payloadPart).toBeDefined();
      expect(JSON.stringify(payloadPart)).toContain(sentinel);

      if (plaintext) {
        const rootRequests = probe.requests.filter((request) => request.model === "gpt-5.5");
        expect(rootRequests.length).toBeGreaterThanOrEqual(2);
        const replayedInput = rootRequests[1].input as Array<Record<string, unknown>>;
        const replayedSpawn = replayedInput.find(
          (item) => item.type === "function_call" && item.name === "spawn_agent"
        );
        expect(replayedSpawn).toBeDefined();
        expect(replayedSpawn).not.toHaveProperty("encrypted_function_args");
      }
    },
    40_000
  );
});
