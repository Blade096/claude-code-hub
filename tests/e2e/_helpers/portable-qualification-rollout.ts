import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { QualificationHistoryMode } from "./portable-qualification";

const LIFECYCLE_ACTIONS = ["spawn_agent", "send_message", "followup_task"] as const;

type LifecycleAction = (typeof LIFECYCLE_ACTIONS)[number];

export type StoredThread = {
  id: string;
  rolloutPath: string;
  agentPath: string | null;
};

type ToolCall = {
  name: LifecycleAction;
  callId: string;
  order: number;
  argumentsText: string;
  arguments: Record<string, unknown> | null;
};

type SubAgentActivity = {
  id: string;
  kind: string;
  agentThreadId: string;
  agentPath: string | null;
  order: number;
};

type ParsedRollout = {
  toolCalls: ToolCall[];
  toolOutputs: Set<string>;
  activities: SubAgentActivity[];
  parentAgentMessages: string[];
  assistantMessages: string[];
  allMessageTexts: string[];
};

export type CodexLifecycleTrace = {
  rootThreadId: string;
  childThreadId: string;
  childAgentPath: string;
  observedActions: string[];
  stateEdgeVerified: boolean;
  actionSequenceComplete: boolean;
  toolOutputsComplete: boolean;
  sendWhileRunning: boolean;
  followupAfterCompletion: boolean;
  parentReceivedResults: boolean;
  childReturnedLiveNonce: boolean;
  childReturnedFollowupNonce: boolean;
  historyBoundaryMatches: boolean;
  historyOldMarkerObserved: boolean;
  historyRecentMarkerObserved: boolean;
  toolArgumentsExcludeHistoryMarkers: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function timestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseArguments(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function textParts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((part) =>
    isRecord(part) && typeof part.text === "string" ? [part.text] : []
  );
}

function activityFromPayload(
  payload: Record<string, unknown>,
  order: number
): SubAgentActivity | null {
  const candidate =
    payload.type === "item_completed" && isRecord(payload.item)
      ? payload.item
      : payload.type === "sub_agent_activity"
        ? payload
        : null;
  if (
    !candidate ||
    (candidate.type !== "SubAgentActivity" && payload.type !== "sub_agent_activity") ||
    typeof candidate.id !== "string" ||
    typeof candidate.kind !== "string" ||
    typeof candidate.agent_thread_id !== "string"
  ) {
    return null;
  }
  return {
    id: candidate.id,
    kind: candidate.kind,
    agentThreadId: candidate.agent_thread_id,
    agentPath: typeof candidate.agent_path === "string" ? candidate.agent_path : null,
    order,
  };
}

export function parseRolloutForQualification(jsonl: string, startedAt: number): ParsedRollout {
  const parsed: ParsedRollout = {
    toolCalls: [],
    toolOutputs: new Set(),
    activities: [],
    parentAgentMessages: [],
    assistantMessages: [],
    allMessageTexts: [],
  };

  for (const [order, line] of jsonl.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(line);
      if (!isRecord(value)) continue;
      event = value;
    } catch {
      continue;
    }
    const at = timestamp(event.timestamp);
    if (at === null || at < startedAt || !isRecord(event.payload)) continue;
    const payload = event.payload;

    if (event.type === "response_item") {
      if (
        payload.type === "function_call" &&
        typeof payload.name === "string" &&
        LIFECYCLE_ACTIONS.includes(payload.name as LifecycleAction) &&
        typeof payload.call_id === "string" &&
        typeof payload.arguments === "string"
      ) {
        parsed.toolCalls.push({
          name: payload.name as LifecycleAction,
          callId: payload.call_id,
          order,
          argumentsText: payload.arguments,
          arguments: parseArguments(payload.arguments),
        });
      }
      if (payload.type === "function_call_output" && typeof payload.call_id === "string") {
        parsed.toolOutputs.add(payload.call_id);
      }
      if (payload.type === "agent_message") {
        const texts = textParts(payload.content);
        parsed.parentAgentMessages.push(...texts);
        parsed.allMessageTexts.push(...texts);
      }
      if (payload.type === "message") {
        const texts = textParts(payload.content);
        parsed.allMessageTexts.push(...texts);
        if (payload.role === "assistant") parsed.assistantMessages.push(...texts);
      }
    }

    if (event.type === "event_msg") {
      const activity = activityFromPayload(payload, order);
      if (activity) parsed.activities.push(activity);
    }
  }
  return parsed;
}

function expectedHistoryMarkers(mode: QualificationHistoryMode, sentinels: string[]): string[] {
  if (mode === "none") return [];
  if (mode === "recent") return [sentinels[1]!];
  return [sentinels[0]!, sentinels[1]!];
}

function stringArgument(call: ToolCall, key: string): string | null {
  const value = call.arguments?.[key];
  return typeof value === "string" ? value : null;
}

export function analyzeLifecycleRollouts(options: {
  rootThread: StoredThread;
  childThread: StoredThread;
  rootJsonl: string;
  childJsonl: string;
  startedAt: number;
  sentinels: string[];
  historyMode: QualificationHistoryMode;
}): CodexLifecycleTrace {
  const { rootThread, childThread, startedAt, sentinels, historyMode } = options;
  const root = parseRolloutForQualification(options.rootJsonl, startedAt);
  const child = parseRolloutForQualification(options.childJsonl, startedAt);
  const childHistory = parseRolloutForQualification(options.childJsonl, 0);
  const calls = Object.fromEntries(
    LIFECYCLE_ACTIONS.map((name) => [name, root.toolCalls.filter((call) => call.name === name)])
  ) as Record<LifecycleAction, ToolCall[]>;
  const spawn = calls.spawn_agent.length === 1 ? calls.spawn_agent[0]! : null;
  const send = calls.send_message.length === 1 ? calls.send_message[0]! : null;
  const followup = calls.followup_task.length === 1 ? calls.followup_task[0]! : null;
  const childAgentPath = childThread.agentPath ?? "";
  const activities = root.activities.filter(
    (activity) =>
      activity.agentThreadId === childThread.id &&
      (activity.agentPath === null || activity.agentPath === childAgentPath)
  );
  const started = spawn
    ? activities.find((activity) => activity.kind === "started" && activity.id === spawn.callId)
    : null;
  const sendInteraction = send
    ? activities.find((activity) => activity.kind === "interacted" && activity.id === send.callId)
    : null;
  const followupInteraction = followup
    ? activities.find(
        (activity) => activity.kind === "interacted" && activity.id === followup.callId
      )
    : null;
  const completions = activities
    .filter((activity) => activity.kind === "completed")
    .sort((left, right) => left.order - right.order);
  const firstCompletion = completions[0] ?? null;
  const secondCompletion = completions[1] ?? null;
  const parentText = root.parentAgentMessages.join("\n");
  const childText = child.assistantMessages.join("\n");
  const childHistoryText = childHistory.allMessageTexts.join("\n");
  const expectedMarkers = expectedHistoryMarkers(historyMode, sentinels);
  const excludedMarkers = sentinels
    .slice(0, 2)
    .filter((marker) => !expectedMarkers.includes(marker));
  const actionCalls = root.toolCalls.filter((call) =>
    LIFECYCLE_ACTIONS.includes(call.name as LifecycleAction)
  );

  return {
    rootThreadId: rootThread.id,
    childThreadId: childThread.id,
    childAgentPath,
    observedActions: actionCalls.map((call) => call.name),
    stateEdgeVerified: true,
    actionSequenceComplete: Boolean(
      spawn &&
        send &&
        followup &&
        started &&
        sendInteraction &&
        followupInteraction &&
        spawn.order < send.order &&
        send.order < followup.order
    ),
    toolOutputsComplete: Boolean(
      spawn &&
        send &&
        followup &&
        [spawn, send, followup].every((call) => root.toolOutputs.has(call.callId))
    ),
    sendWhileRunning: Boolean(
      send &&
        sendInteraction &&
        firstCompletion &&
        stringArgument(send, "target") === childAgentPath &&
        send.order < firstCompletion.order
    ),
    followupAfterCompletion: Boolean(
      followup &&
        followupInteraction &&
        firstCompletion &&
        secondCompletion &&
        stringArgument(followup, "target") === childAgentPath &&
        firstCompletion.order < followup.order &&
        followup.order < secondCompletion.order
    ),
    parentReceivedResults: parentText.includes(sentinels[2]!) && parentText.includes(sentinels[3]!),
    childReturnedLiveNonce: childText.includes(sentinels[2]!),
    childReturnedFollowupNonce: childText.includes(sentinels[3]!),
    historyBoundaryMatches:
      expectedMarkers.every((marker) => childHistoryText.includes(marker)) &&
      excludedMarkers.every((marker) => !childHistoryText.includes(marker)),
    historyOldMarkerObserved: childHistoryText.includes(sentinels[0]!),
    historyRecentMarkerObserved: childHistoryText.includes(sentinels[1]!),
    toolArgumentsExcludeHistoryMarkers: actionCalls.every((call) =>
      sentinels.slice(0, 2).every((marker) => !call.argumentsText.includes(marker))
    ),
  };
}

function stateDatabasePath(home: string): string {
  return join(home, "state_5.sqlite");
}

function readStoredThreads(
  home: string,
  rootThreadId: string
): { root: StoredThread; children: StoredThread[] } {
  const databasePath = stateDatabasePath(home);
  if (!existsSync(databasePath)) throw new Error("Isolated Codex state database is missing.");
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const root = database
      .prepare(
        "select id, rollout_path as rolloutPath, agent_path as agentPath from threads where id = ?"
      )
      .get(rootThreadId) as StoredThread | undefined;
    if (!root || typeof root.rolloutPath !== "string") {
      throw new Error("Root Codex rollout is missing from isolated state.");
    }
    const children = database
      .prepare(
        `select t.id, t.rollout_path as rolloutPath, t.agent_path as agentPath
         from thread_spawn_edges e
         join threads t on t.id = e.child_thread_id
         where e.parent_thread_id = ?`
      )
      .all(rootThreadId) as StoredThread[];
    return { root, children };
  } finally {
    database.close();
  }
}

async function confinedRolloutPath(home: string, storedPath: string): Promise<string> {
  const resolvedHome = await realpath(home);
  const candidate = isAbsolute(storedPath) ? resolve(storedPath) : resolve(home, storedPath);
  const resolvedCandidate = await realpath(candidate);
  const pathFromHome = relative(resolvedHome, resolvedCandidate);
  if (pathFromHome.startsWith("..") || isAbsolute(pathFromHome)) {
    throw new Error("Codex rollout path escaped the isolated qualification home.");
  }
  return resolvedCandidate;
}

export function discoverIsolatedChildThreadIds(home: string, rootThreadId: string): string[] {
  return readStoredThreads(home, rootThreadId).children.map((thread) => thread.id);
}

export async function inspectIsolatedCodexLifecycle(options: {
  home: string;
  rootThreadId: string;
  startedAt: number;
  sentinels: string[];
  historyMode: QualificationHistoryMode;
}): Promise<CodexLifecycleTrace> {
  const state = readStoredThreads(options.home, options.rootThreadId);
  if (state.children.length !== 1) {
    throw new Error("Qualification lifecycle must create exactly one isolated child thread.");
  }
  const child = state.children[0]!;
  if (!child.agentPath) throw new Error("Qualification child agent path is missing.");
  const [rootPath, childPath] = await Promise.all([
    confinedRolloutPath(options.home, state.root.rolloutPath),
    confinedRolloutPath(options.home, child.rolloutPath),
  ]);
  const [rootJsonl, childJsonl] = await Promise.all([
    readFile(rootPath, "utf8"),
    readFile(childPath, "utf8"),
  ]);
  return analyzeLifecycleRollouts({
    rootThread: state.root,
    childThread: child,
    rootJsonl,
    childJsonl,
    startedAt: options.startedAt,
    sentinels: options.sentinels,
    historyMode: options.historyMode,
  });
}
