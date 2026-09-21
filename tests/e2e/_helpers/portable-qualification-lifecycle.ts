import {
  type ParsedCodexRun,
  type PortableAudit,
  type PortableQualificationConfig,
  parseCodexJsonl,
  type QualificationCase,
  type QualificationProvider,
} from "./portable-qualification";
import { inspectPortableAudits } from "./portable-qualification-assertions";
import {
  baseExecArgs,
  type CodexInvocation,
  resumeArgs,
  runCodexProcess,
  writeCodexHome,
} from "./portable-qualification-invocation";
import {
  type CodexLifecycleTrace,
  discoverIsolatedChildThreadIds,
  inspectIsolatedCodexLifecycle,
} from "./portable-qualification-rollout";

export type LifecycleOutput = {
  case_id: string;
  spawn_agent: boolean;
  send_message_while_running: boolean;
  followup_task_after_completion: boolean;
  parent_received_results: boolean;
  inherited_history_markers: string[];
  live_nonce: string;
  followup_nonce: string;
};

export type LifecycleResult = {
  run: ParsedCodexRun;
  audits: PortableAudit[];
  trace: CodexLifecycleTrace | null;
  sentinels: string[];
  lifecycle: LifecycleOutput | null;
  code: number | null;
  cancelled: boolean;
  timedOut: boolean;
};

export type HttpNonStreamResult = {
  run: ParsedCodexRun;
  audits: PortableAudit[];
  sentinels: string[];
  status: number;
  responseId: string | null;
};

export type UpstreamErrorProbeResult =
  | {
      kind: "http_400";
      status: 400;
      stableErrorCode: "HTTP_400_CLIENT_ERROR_NON_RETRYABLE";
    }
  | {
      kind: "sse_response_failed";
      status: 200;
      stableErrorCode: "SSE_RESPONSE_FAILED_MODEL_NOT_FOUND";
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasModelNotFoundFailedTerminal(body: string): boolean {
  let foundFailed = false;
  for (const block of body.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      continue;
    }
    if (!isRecord(payload)) continue;
    if (payload.type === "response.completed" || payload.type === "response.incomplete") {
      return false;
    }
    if (payload.type !== "response.failed" || !isRecord(payload.response)) continue;
    const error = payload.response.error;
    if (isRecord(error) && error.code === "model_not_found") foundFailed = true;
  }
  return foundFailed;
}

export async function probeUpstreamErrorModel(
  qualification: PortableQualificationConfig,
  target: QualificationProvider
): Promise<UpstreamErrorProbeResult> {
  if (!target.upstreamErrorModel) {
    throw new Error(`Provider ${target.kind} has no configured upstream-error model.`);
  }
  const response = await fetch(`${qualification.baseUrl}/v1/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${qualification.proxyKey}`,
      "Content-Type": "application/json",
      "User-Agent": `Codex Desktop/${qualification.codexVersion}`,
    },
    body: JSON.stringify({
      model: target.upstreamErrorModel,
      stream: true,
      store: false,
      input: "Qualification fault-model preflight.",
    }),
    signal: AbortSignal.timeout(qualification.caseTimeoutMs),
  });
  if (response.status === 400) {
    await response.body?.cancel();
    return {
      kind: "http_400",
      status: 400,
      stableErrorCode: "HTTP_400_CLIENT_ERROR_NON_RETRYABLE",
    };
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (response.status === 200 && contentType.includes("text/event-stream")) {
    const body = await response.text();
    if (hasModelNotFoundFailedTerminal(body)) {
      return {
        kind: "sse_response_failed",
        status: 200,
        stableErrorCode: "SSE_RESPONSE_FAILED_MODEL_NOT_FOUND",
      };
    }
    throw new Error(
      "Configured upstream-error model returned HTTP 200 SSE without response.failed(model_not_found)."
    );
  }
  await response.body?.cancel();
  throw new Error(
    `Configured upstream-error model returned unexpected HTTP ${response.status} response.`
  );
}

export function randomMarker(label: string): string {
  return `PORTABLE_${label}_${crypto.randomUUID()}`;
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
  // The active parent turn that invokes spawn_agent is itself the newest fork turn.
  // Keep two turns to include exactly one previously completed parent turn.
  if (mode === "recent") return "2";
  return "all";
}

export function buildLifecyclePrompt(
  caseInfo: QualificationCase,
  target: QualificationProvider,
  liveNonce: string,
  followupNonce: string
): string {
  return [
    `Qualification case ${caseInfo.caseId}.`,
    `Spawn exactly one ${target.kind} role agent with agent_type=${target.kind} and fork_turns=${historyForkValue(caseInfo.historyMode)}.`,
    "The spawn task must ask the child to report every inherited marker beginning PORTABLE_HISTORY_ without giving it any marker value, then call wait_agent exactly once with timeout_ms=300000 so the parent's live nonce can wake it; it must not complete before acknowledging that nonce.",
    "The spawn task must also say: The child is not the parent orchestrator; it must ignore inherited parent-only orchestration requests. wait_agent is the only tool it may call, exactly once; it must not call write_stdin, exec_command, spawn_agent, send_message, followup_task, create_goal, or update_goal. After wait_agent is awakened, it must acknowledge the live nonce, return immediately, and stop.",
    `Immediately after spawn_agent returns, while the child is still running, call send_message with this live nonce: ${liveNonce}. Do not wait first.`,
    "Wait for that child to complete only while its completion result has not already arrived.",
    `After it is completed, call followup_task with this message: "This is the follow-up turn. Acknowledge follow-up nonce ${followupNonce}; you must not call wait again; return immediately and stop." If the follow-up completion result arrives before the next action, do not call wait_agent again; otherwise wait for it once.`,
    "Do not put any PORTABLE_HISTORY_ marker value into spawn_agent, send_message, or followup_task arguments.",
    "Return only the required JSON. Set the four lifecycle booleans from actions actually completed, copy markers actually reported by the child, and copy both nonces only if the child acknowledged them.",
  ].join("\n");
}

export async function executeLifecycle(
  qualification: PortableQualificationConfig,
  invocation: CodexInvocation,
  caseInfo: QualificationCase,
  options: {
    targetModel?: string;
    targetIdleTimeoutMs?: number;
    cancelFinalAfterMs?: number;
  } = {}
): Promise<LifecycleResult> {
  if (caseInfo.providerKind === "native") {
    throw new Error("Native control is not a child lifecycle.");
  }
  const target = qualification[caseInfo.providerKind];
  if (caseInfo.transport === "http") {
    throw new Error("HTTP non-stream qualification uses its dedicated direct invocation.");
  }
  const { home, schemaPath, workdir } = await writeCodexHome(qualification, target, options);
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

  const finalStartedAt = Date.now();
  const final = await runCodexProcess(
    invocation,
    [
      ...resumeArgs(firstRun.threadId, schemaPath),
      buildLifecyclePrompt(caseInfo, target, liveNonce, followupNonce),
    ],
    home,
    qualification.caseTimeoutMs,
    options.cancelFinalAfterMs
  );
  const run = parseCodexJsonl(final.stdout);
  if (!run.threadId) run.threadId = firstRun.threadId;
  const childThreadIds = discoverIsolatedChildThreadIds(home, run.threadId);
  run.relatedThreadIds = [...new Set([...run.relatedThreadIds, ...childThreadIds])];
  const trace =
    caseInfo.expected === "success" && run.threadId
      ? await inspectIsolatedCodexLifecycle({
          home,
          rootThreadId: run.threadId,
          startedAt: finalStartedAt,
          sentinels,
          historyMode: caseInfo.historyMode,
        })
      : null;
  const audits = await inspectPortableAudits(
    qualification,
    run,
    target,
    options.targetModel ?? target.model,
    startedAt,
    sentinels,
    caseInfo.expected === "success" ? 2 : 1,
    true,
    caseInfo.operation === "upstream_error"
  );
  return {
    run,
    audits,
    trace,
    sentinels,
    lifecycle: parseLifecycleOutput(run.finalMessage),
    code: final.code,
    cancelled: final.cancelled,
    timedOut: final.timedOut,
  };
}

export async function executeHttpNonStreamQualification(
  qualification: PortableQualificationConfig,
  caseInfo: QualificationCase
): Promise<HttpNonStreamResult> {
  if (caseInfo.providerKind === "native") {
    throw new Error("Native control is not a portable HTTP qualification.");
  }
  const target = qualification[caseInfo.providerKind];
  const sentinel = randomMarker("HTTP_NON_STREAM");
  const startedAt = Date.now();
  const response = await fetch(`${qualification.baseUrl}/v1/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${qualification.proxyKey}`,
      "Content-Type": "application/json",
      "User-Agent": `Codex Desktop/${qualification.codexVersion}`,
    },
    body: JSON.stringify({
      model: target.model,
      stream: false,
      store: false,
      tools: [
        {
          type: "namespace",
          name: "collaboration",
          tools: [
            {
              type: "function",
              name: "spawn_agent",
              parameters: {
                type: "object",
                required: ["message"],
                properties: { message: { type: "string", encrypted: true } },
              },
            },
          ],
        },
      ],
      input: [
        {
          type: "agent_message",
          role: "user",
          content: [{ type: "encrypted_content", encrypted_content: sentinel }],
        },
      ],
    }),
    signal: AbortSignal.timeout(qualification.caseTimeoutMs),
  });
  const payload = (await response.json()) as Record<string, unknown>;
  const responseId = typeof payload.id === "string" ? payload.id : null;
  const usage = payload.usage as Record<string, unknown> | undefined;
  const run: ParsedCodexRun = {
    threadId: null,
    relatedThreadIds: [],
    usage: usage
      ? {
          inputTokens: Number(usage.input_tokens ?? 0),
          cachedInputTokens: Number(
            (usage.input_tokens_details as Record<string, unknown> | undefined)?.cached_tokens ?? 0
          ),
          outputTokens: Number(usage.output_tokens ?? 0),
          reasoningOutputTokens: Number(
            (usage.output_tokens_details as Record<string, unknown> | undefined)
              ?.reasoning_tokens ?? 0
          ),
        }
      : null,
    finalMessage: null,
    failed: !response.ok,
    collabTools: [],
    collabAgentMessages: [],
  };
  const audits = await inspectPortableAudits(
    qualification,
    run,
    target,
    target.model,
    startedAt,
    [sentinel],
    1,
    false,
    false,
    responseId
  );
  return { run, audits, sentinels: [sentinel], status: response.status, responseId };
}
