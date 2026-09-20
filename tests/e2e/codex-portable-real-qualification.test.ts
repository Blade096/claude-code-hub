import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import process from "node:process";
import { afterAll, beforeAll, describe, test } from "vitest";
import {
  appendSafeEvidence,
  buildEvidence,
  buildQualificationCases,
  findPortableAudits,
  parseCodexJsonl,
  readPortableQualificationConfig,
  type PortableQualificationConfig,
} from "./_helpers/portable-qualification";
import {
  assertNativeRootUsage,
  assertNoProtectedText,
  assertOperationalLogsClean,
  auditSessionIds,
  fetchUsageLogs,
  lifecycleCaseForRecovery,
  requireQualification,
  terminalAudit,
  usageItems,
  validateHttpNonStream,
  validateSuccessfulLifecycle,
} from "./_helpers/portable-qualification-assertions";
import {
  executeHttpNonStreamQualification,
  executeLifecycle,
  randomMarker,
} from "./_helpers/portable-qualification-lifecycle";
import {
  baseExecArgs,
  cleanupQualificationHomes,
  resolveCodexInvocation,
  runCodexProcess,
  writeCodexHome,
} from "./_helpers/portable-qualification-invocation";

/**
 * Opt-in real-provider qualification. Invocation, lifecycle execution and
 * assertions intentionally live in focused helpers so this file remains the
 * readable matrix/orchestration layer.
 */

const repositoryRoot = resolve(__dirname, "../..");
const config = readPortableQualificationConfig(process.env, repositoryRoot);
const runReal = config ? describe : describe.skip;

runReal("real Codex MultiAgentV2 portable qualification", () => {
  if (!config) {
    test.skip("requires CCH_PORTABLE_QUALIFICATION=1 and explicit real-provider config", () => {});
    return;
  }
  const qualification: PortableQualificationConfig = config;
  const invocation = resolveCodexInvocation(qualification.codexBin);
  const cases = buildQualificationCases();
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

  afterAll(cleanupQualificationHomes);

  for (const caseInfo of cases.filter((item) => item.operation === "http_non_stream")) {
    test(
      caseInfo.caseId,
      async () => {
        const target = qualification[caseInfo.providerKind as "deepseek" | "glm"];
        const result = await executeHttpNonStreamQualification(qualification, caseInfo);
        const audit = validateHttpNonStream(caseInfo, target, result);
        await assertOperationalLogsClean(qualification.logPaths, [...secrets, ...result.sentinels]);
        await appendSafeEvidence(
          qualification.evidencePath,
          buildEvidence({
            caseInfo,
            config: qualification,
            audit,
            run: result.run,
            result: "passed",
          }),
          secrets,
          result.sentinels
        );
      },
      qualification.caseTimeoutMs * 2
    );
  }

  for (const caseInfo of cases.filter((item) => item.operation === "lifecycle")) {
    test(
      caseInfo.caseId,
      async () => {
        const target = qualification[caseInfo.providerKind as "deepseek" | "glm"];
        const result = await executeLifecycle(qualification, invocation, caseInfo);
        await assertNativeRootUsage(qualification, result.run, caseInfo.caseId, result.sentinels);
        const audit = validateSuccessfulLifecycle(caseInfo, target, result);
        await assertOperationalLogsClean(qualification.logPaths, [...secrets, ...result.sentinels]);
        await appendSafeEvidence(
          qualification.evidencePath,
          buildEvidence({
            caseInfo,
            config: qualification,
            audit,
            run: result.run,
            result: "passed",
          }),
          secrets,
          result.sentinels
        );
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
      const { home, workdir } = await writeCodexHome(qualification, qualification.deepseek);
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
      const nativePreparationAudit = findPortableAudits(logs).find(
        (item) =>
          item.actualProviderId === qualification.native.id &&
          item.actualProviderName === qualification.native.name &&
          item.actualModel === qualification.native.model
      );
      requireQualification(
        nativePreparationAudit,
        nativeCase.caseId,
        "native root tool preparation audit is missing"
      );
      requireQualification(
        nativePreparationAudit.state === "response_restored" &&
          nativePreparationAudit.responseRestore === "not_needed" &&
          nativePreparationAudit.errorCategory === null,
        nativeCase.caseId,
        "native root tool preparation did not finish cleanly"
      );
      requireQualification(
        [
          "spawn_agent_message_schema",
          "send_message_message_schema",
          "followup_task_message_schema",
          "collaboration_namespace",
        ].every((transformation) =>
          nativePreparationAudit.transformations.includes(transformation)
        ) && !nativePreparationAudit.transformations.includes("agent_message_input"),
        nativeCase.caseId,
        "native root audit does not match tool-only preparation"
      );
      requireQualification(
        nativePreparationAudit.requestId !== null &&
          nativePreparationAudit.sessionId !== null &&
          nativePreparationAudit.responseId !== null,
        nativeCase.caseId,
        "native root audit correlation identifiers are incomplete"
      );
      await assertOperationalLogsClean(qualification.logPaths, [...secrets, sentinel]);
      await appendSafeEvidence(
        qualification.evidencePath,
        buildEvidence({
          caseInfo: nativeCase,
          config: qualification,
          audit: nativePreparationAudit,
          run,
          result: "passed",
        }),
        secrets,
        [sentinel]
      );
    },
    qualification.caseTimeoutMs * 2
  );
});
