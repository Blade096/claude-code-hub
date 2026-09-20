import { createReadStream } from "node:fs";
import {
  findPortableAudits,
  type ParsedCodexRun,
  type PortableAudit,
  type PortableQualificationConfig,
  type QualificationCase,
  type QualificationProvider,
} from "./portable-qualification";
import type { HttpNonStreamResult, LifecycleResult } from "./portable-qualification-lifecycle";

function usageLogUrl(
  qualification: PortableQualificationConfig,
  filters: Record<string, string | number>
): string {
  const url = new URL(`${qualification.baseUrl}/api/v1/usage-logs`);
  url.searchParams.set("limit", "100");
  for (const [key, value] of Object.entries(filters)) url.searchParams.set(key, String(value));
  return url.toString();
}

export async function fetchUsageLogs(
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

export function assertNoProtectedText(value: unknown, protectedValues: string[]): void {
  const serialized = JSON.stringify(value);
  for (const protectedValue of protectedValues) {
    if (protectedValue && serialized.includes(protectedValue)) {
      throw new Error("A qualification sentinel appeared in the usage-log API response.");
    }
  }
}

export async function assertOperationalLogsClean(
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

export function isTargetChildAudit(
  audit: PortableAudit,
  target: QualificationProvider,
  targetModel: string
): boolean {
  return (
    audit.requestedProviderId === target.id &&
    audit.requestedProviderName === target.name &&
    audit.actualProviderId === target.id &&
    audit.actualProviderName === target.name &&
    audit.requestedModel === targetModel &&
    audit.actualModel === targetModel &&
    audit.transformations.includes("agent_message_input") &&
    !audit.transformations.includes("collaboration_namespace")
  );
}

export async function inspectPortableAudits(
  qualification: PortableQualificationConfig,
  run: ParsedCodexRun,
  target: QualificationProvider,
  targetModel: string,
  startedAt: number,
  protectedValues: string[],
  minimumRelatedTerminalAudits = 1
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
    const terminal = audits.filter(
      (item) => item.state === "response_restored" || item.state === "failed"
    );
    const relatedTerminal = terminal.filter((item) =>
      isTargetChildAudit(item, target, targetModel)
    );
    if (
      run.relatedThreadIds.length > 0
        ? relatedTerminal.length >= minimumRelatedTerminalAudits
        : terminal.length > 0
    ) {
      return audits;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
  return findPortableAudits(inspected);
}

export function terminalAudit(audits: PortableAudit[]): PortableAudit | null {
  return (
    audits.find((item) => item.state === "failed") ??
    audits.find((item) => item.state === "response_restored") ??
    null
  );
}

export function requireQualification(
  condition: unknown,
  caseId: string,
  reason: string
): asserts condition {
  if (!condition) throw new Error(`Qualification ${caseId} failed: ${reason}.`);
}

export function validateSuccessfulLifecycle(
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
  requireQualification(result.trace, caseInfo.caseId, "isolated rollout trace is missing");
  const trace = result.trace;
  requireQualification(
    trace.stateEdgeVerified && trace.actionSequenceComplete && trace.toolOutputsComplete,
    caseInfo.caseId,
    `isolated rollout did not prove the complete collaboration action sequence (observed: ${JSON.stringify(trace.observedActions)})`
  );
  requireQualification(
    trace.sendWhileRunning && trace.followupAfterCompletion,
    caseInfo.caseId,
    `isolated rollout did not prove the required running/completed action order (sendWhileRunning=${trace.sendWhileRunning}, followupAfterCompletion=${trace.followupAfterCompletion})`
  );
  requireQualification(
    trace.childReturnedLiveNonce && trace.childReturnedFollowupNonce && trace.parentReceivedResults,
    caseInfo.caseId,
    "isolated child/parent rollouts did not contain both lifecycle results"
  );
  requireQualification(
    trace.historyBoundaryMatches && trace.toolArgumentsExcludeHistoryMarkers,
    caseInfo.caseId,
    `isolated rollout did not prove the requested history boundary (old=${trace.historyOldMarkerObserved}, recent=${trace.historyRecentMarkerObserved}, argumentsClean=${trace.toolArgumentsExcludeHistoryMarkers})`
  );

  const restored = result.audits.filter(
    (item) => item.state === "response_restored" && isTargetChildAudit(item, target, target.model)
  );
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
    const inputOnly =
      item.transformations.includes("agent_message_input") &&
      !item.transformations.includes("collaboration_namespace");
    requireQualification(
      (item.responseRestore === "restored" ||
        (inputOnly && item.responseRestore === "not_needed")) &&
        item.errorCategory === null,
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

export function validateHttpNonStream(
  caseInfo: QualificationCase,
  target: QualificationProvider,
  result: HttpNonStreamResult
): PortableAudit {
  requireQualification(
    result.status >= 200 && result.status < 300 && !result.run.failed,
    caseInfo.caseId,
    "HTTP non-stream request did not complete"
  );
  requireQualification(result.run.usage, caseInfo.caseId, "HTTP non-stream usage is missing");
  const audit = terminalAudit(result.audits);
  requireQualification(audit, caseInfo.caseId, "HTTP non-stream terminal audit is missing");
  requireQualification(
    audit.requestedTransport === "http" && audit.actualTransport === "http",
    caseInfo.caseId,
    "HTTP non-stream request used a different transport"
  );
  requireQualification(
    audit.requestedProviderId === target.id &&
      audit.actualProviderId === target.id &&
      audit.requestedProviderName === target.name &&
      audit.actualProviderName === target.name,
    caseInfo.caseId,
    "HTTP non-stream request used a different provider"
  );
  requireQualification(
    audit.requestedModel === target.model && audit.actualModel === target.model,
    caseInfo.caseId,
    "HTTP non-stream request used a different model"
  );
  requireQualification(
    audit.state === "response_restored" &&
      audit.errorCategory === null &&
      audit.transformations.includes("agent_message_input"),
    caseInfo.caseId,
    "HTTP non-stream compatibility transform did not finish cleanly"
  );
  return audit;
}

export function lifecycleCaseForRecovery(source: QualificationCase): QualificationCase {
  return {
    caseId: `${source.caseId}_recovery`,
    providerKind: source.providerKind,
    operation: "recovery",
    historyMode: "none",
    transport: "sse",
    expected: "success",
  };
}

export function auditSessionIds(audits: PortableAudit[]): Set<string> {
  return new Set(
    audits
      .map((item) => item.sessionId)
      .filter((value): value is string => typeof value === "string")
  );
}

export function usageItems(value: unknown): Array<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const items = (value as Record<string, unknown>).items;
  return Array.isArray(items)
    ? items.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item)
      )
    : [];
}

export function usageItemMatchesProvider(
  item: Record<string, unknown>,
  providerId: number,
  providerName: string
): boolean {
  if (item.providerName !== providerName) return false;
  if (item.providerId === providerId || item.finalProviderId === providerId) return true;
  if (!Array.isArray(item.providerChain)) return false;
  return item.providerChain.some(
    (entry) =>
      Boolean(entry) &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      (entry as Record<string, unknown>).id === providerId &&
      (entry as Record<string, unknown>).name === providerName
  );
}

export async function assertNativeRootUsage(
  qualification: PortableQualificationConfig,
  run: ParsedCodexRun,
  caseId: string,
  protectedValues: string[]
): Promise<void> {
  requireQualification(run.threadId, caseId, "native root thread id is missing");
  for (let attempt = 0; attempt < 15; attempt++) {
    const inspected = await fetchUsageLogs(qualification, { sessionId: run.threadId });
    assertNoProtectedText(inspected, protectedValues);
    const nativeLog = usageItems(inspected).find(
      (item) =>
        usageItemMatchesProvider(item, qualification.native.id, qualification.native.name) &&
        (item.model === qualification.native.model ||
          item.originalModel === qualification.native.model)
    );
    if (nativeLog) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
  throw new Error(`Qualification ${caseId} failed: native root usage log is missing.`);
}
