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
};

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
  if (mode === "recent") return "1";
  return "all";
}

export function buildLifecyclePrompt(
  caseInfo: QualificationCase,
  target: QualificationProvider,
  recentMarker: string,
  liveNonce: string,
  followupNonce: string
): string {
  return [
    `Qualification case ${caseInfo.caseId}.`,
    `Current-turn inherited history marker: ${recentMarker}.`,
    `Spawn exactly one ${target.kind} role agent with agent_type=${target.kind} and fork_turns=${historyForkValue(caseInfo.historyMode)}.`,
    "The spawn task must ask the child to report every inherited marker beginning PORTABLE_HISTORY_ without giving it any marker value, then use its wait collaboration tool until the parent's live nonce arrives; it must not complete before acknowledging that nonce.",
    `Immediately after spawn_agent returns, while the child is still running, call send_message with this live nonce: ${liveNonce}. Do not wait first.`,
    "Wait for that child to complete only while its completion result has not already arrived.",
    `After it is completed, call followup_task with this follow-up nonce: ${followupNonce}. If the follow-up completion result arrives before the next action, do not call wait_agent again; otherwise wait for it once.`,
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
    [...resumeArgs(firstRun.threadId), "Establish one more completed root turn. Reply ACK only."],
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
      buildLifecyclePrompt(caseInfo, target, recentMarker, liveNonce, followupNonce),
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
    caseInfo.expected === "success" && final.code === 0 && !final.cancelled && !final.timedOut
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
  const audits = await inspectPortableAudits(qualification, run, target, target.model, startedAt, [
    sentinel,
  ]);
  return { run, audits, sentinels: [sentinel], status: response.status };
}
