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

export async function inspectPortableAudits(
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

function expectedHistoryMarkers(mode: QualificationCase["historyMode"], sentinels: string[]) {
  if (mode === "none") return [];
  if (mode === "recent") return [sentinels[1]!];
  return [sentinels[0]!, sentinels[1]!];
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

export function validateUnsupportedWebsocket(
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
        item.providerId === qualification.native.id &&
        item.providerName === qualification.native.name &&
        (item.model === qualification.native.model ||
          item.originalModel === qualification.native.model)
    );
    if (nativeLog) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
  throw new Error(`Qualification ${caseId} failed: native root usage log is missing.`);
}
