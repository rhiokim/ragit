#!/usr/bin/env node

import { Command } from "commander";
import { runArtifactReviewCommand } from "./commands/artifact.js";
import { resolveCwd, runConfigSet, runDoctor, runStatus } from "./commands/bootstrap.js";
import { runDriftCommand } from "./commands/drift.js";
import { runRepairCommand } from "./commands/repair.js";
import { runDocCreateCommand, runDocReconcileCommand, runDocRefreshCommand, runDocValidateCommand } from "./commands/doc.js";
import { runHarnessCaptureCommand, runHarnessPackCommand, runHarnessPromoteCommand, runHarnessRunCommand, runHarnessVerifyCommand } from "./commands/harness.js";
import { HookActionResult, runHooksInstall, runHooksStatus, runHooksUninstall } from "./commands/hooks.js";
import { formatInitSummaryTable, resolveInitRoot, runInit } from "./commands/init.js";
import { runMemoryPromoteCommand, runMemoryRecallCommand, runMemoryWrapCommand } from "./commands/memory.js";
import { runNarrativeCommand } from "./commands/narrative.js";
import { runSessionMaterializeCommand } from "./commands/session.js";
import { runSecurityAuditCommand, runSecurityPurgeCommand } from "./commands/security.js";
import { runTimelineCommand } from "./commands/timeline.js";
import {
  buildCliEnvelope,
  buildCliFailureEnvelope,
  CliFormat,
  CliView,
  emitCliFailure,
  emitCliOutput,
  normalizeCliFormat,
  normalizeCliView,
  resolveCliFailureContext,
} from "./core/cliContract.js";
import { assertSafeGlobText, readJsonInput } from "./core/cliInput.js";
import { normalizeContextPackCommandInput, normalizeIngestCommandInput, normalizeQueryCommandInput } from "./core/commandInputs.js";
import { describeCommandPath, listDescribableCommands } from "./core/commandRegistry.js";
import { formatContextPackText, packContext, projectContextPack } from "./core/context.js";
import { isRagitOperationalError } from "./core/errors.js";
import { runIngest } from "./core/ingest.js";
import { formatRagitLogText, projectRagitLogResult, runRagitLog } from "./core/log.js";
import { formatQueryResultText, projectRetrievalHits } from "./core/output.js";
import { normalizeRepairActionKind } from "./core/repair.js";
import { searchKnowledge } from "./core/retrieval.js";
import { mergeRedactionSummaries, sanitizeKnowledgeText } from "./core/security.js";
import { normalizeKnownDocType } from "./core/types.js";
import { RAGIT_VERSION } from "./core/version.js";

const program = new Command();

const formatHooksText = (title: string, hooks: HookActionResult[], dryRun: boolean): string =>
  [
    `# ${title}`,
    `- dry_run: ${dryRun}`,
    "",
    ...hooks.map((hook) => `- ${hook.name}: ${hook.state} (${hook.target})`),
  ].join("\n");

const formatStatusText = (status: Awaited<ReturnType<typeof runStatus>>): string =>
  [
    "# ragit status",
    `- branch: ${status.branch ?? "none"}`,
    `- head: ${status.head ?? "none"}`,
    `- snapshot_requested_ref: ${status.snapshot.requestedRef}`,
    `- snapshot_resolved_sha: ${status.snapshot.resolvedSha ?? "none"}`,
    `- snapshot_selection: ${status.snapshot.selection}`,
    `- snapshot_status: ${status.snapshot.status}`,
    `- snapshot_detached: ${status.snapshot.detached}`,
    `- snapshot_worktree_dirty: ${status.snapshot.worktreeDirty}`,
    `- backend: ${status.backend}`,
    `- manifests: ${status.manifests}`,
    `- zvec: ${status.zvec.status}`,
    `- search_ready: ${status.zvec.searchReady}`,
    `- migration_required: ${status.zvec.migrationRequired}`,
    `- docs_tracked: ${status.docsAuthority.tracked}`,
    `- docs_violations: ${status.docsAuthority.violations}`,
    `- docs_last_reconciled_at: ${status.docsAuthority.lastReconciledAt ?? "none"}`,
    `- durable_ready: ${status.knowledge.durableReady}`,
    `- session_artifacts: ${status.knowledge.sessionArtifactCount}`,
    `- harness_artifacts: ${status.knowledge.harnessArtifactCount}`,
    `- pending_bindings: ${status.knowledge.pendingBindings}`,
    `- event_count: ${status.events.eventCount}`,
    `- events_last_recorded_at: ${status.events.lastRecordedAt ?? "none"}`,
    `- events_latest_goal: ${status.events.latestGoalId ?? "none"}`,
    `- events_latest_episode: ${status.events.latestEpisodeId ?? "none"}`,
    `- events_latest_session: ${status.events.latestSessionId ?? "none"}`,
    `- embedding_configured: ${status.embedding.configured.provider}/${status.embedding.configured.model}/${status.embedding.configured.version}/${status.embedding.configured.dimensions}`,
    `- embedding_store: ${status.embedding.store ? `${status.embedding.store.provider}/${status.embedding.store.version}/${status.embedding.store.dimensions}` : "none"}`,
    `- embedding_cache_enabled: ${status.embedding.cache.enabled}`,
    `- embedding_cache_dir: ${status.embedding.cache.dir}`,
    `- embedding_cache_namespace: ${status.embedding.cache.namespaceId ?? "none"}`,
    `- embedding_cache_entries: ${status.embedding.cache.entryCount}`,
    `- embedding_ready: ${status.embedding.ready}`,
    `- embedding_needs_migration: ${status.embedding.needsMigration}`,
    `- security_masking_configured: ${status.security.maskingConfigured}`,
    `- security_remote_embedding_policy: ${status.security.remoteEmbeddingPolicy}`,
    `- security_admission_mode: ${status.security.admissionMode}`,
    `- security_provider_egress_class: ${status.security.providerEgressClass}`,
    `- security_output_remasking: ${status.security.outputRemasking}`,
    `- security_quarantine_entries: ${status.security.quarantineEntries}`,
    `- security_last_admission_at: ${status.security.lastAdmissionAt ?? "none"}`,
    `- security_admission_blocked_entries: ${status.security.admissionBlockedEntries}`,
    `- security_admission_quarantined_entries: ${status.security.admissionQuarantinedEntries}`,
    `- security_last_audit_at: ${status.security.lastAuditAt ?? "none"}`,
    `- security_legacy_unsafe_state: ${status.security.legacyUnsafeState}`,
    `- store_writer_lock: ${status.storeWriter.state}`,
    `- store_writer_owner: ${status.storeWriter.owner ? `pid=${status.storeWriter.owner.pid}, hostname=${status.storeWriter.owner.hostname}, started_at=${status.storeWriter.owner.startedAt}, command=${status.storeWriter.owner.command}, head_sha=${status.storeWriter.owner.headSha ?? "none"}` : "none"}`,
    `- ingest_recovery_pending: ${status.ingestRecovery.summary.finalizationPending}`,
    `- ingest_recovery_last_completed: ${status.ingestRecovery.lastCompleted?.transactionId ?? "none"}`,
    `- format: ${status.format}`,
  ].join("\n");

const formatDoctorText = (result: Awaited<ReturnType<typeof runDoctor>>): string =>
  [
    "# ragit doctor",
    `- has_failure: ${result.hasFailure}`,
    "",
    ...result.checks.map((check) => `${check.ok ? "OK" : "FAIL"} ${check.name}: ${check.detail}`),
  ].join("\n");

const formatIngestText = (summary: Awaited<ReturnType<typeof runIngest>>): string =>
  [
    "# ragit ingest",
    `- mode: ${summary.mode}`,
    `- commit: ${summary.commitSha}`,
    `- manifest: ${summary.manifestPath ?? "none"}`,
    `- processed: ${summary.processed}`,
    `- skipped: ${summary.skipped}`,
    `- masked: ${summary.masked}`,
    `- full_snapshot: ${summary.fullSnapshot}`,
    `- scope: ${summary.scope}`,
    `- bound_artifacts: ${summary.boundArtifactIds.length}`,
    `- planned_files: ${summary.plannedFiles.length}`,
    `- deleted_document_ids: ${summary.deletedDocumentIds.length}`,
    `- dirty_candidates: ${summary.dirtyCandidates.length > 0 ? summary.dirtyCandidates.join(", ") : "none"}`,
    `- would_fail: ${summary.wouldFail}`,
    `- docs_validated: ${summary.docAuthority.validated}`,
    `- doc_contract_violations: ${summary.docAuthority.violations}`,
    `- doc_contract_skipped: ${summary.docAuthority.skipped}`,
    `- admission_mode: ${summary.admission.mode}`,
    `- admission_quarantined: ${summary.admission.quarantined}`,
    `- admission_blocked: ${summary.admission.blocked}`,
  ].join("\n");

const formatDescribeText = (spec: ReturnType<typeof describeCommandPath>): string =>
  [
    "# ragit describe",
    `- command: ${spec.path}`,
    `- group: ${spec.group}`,
    `- docs: ${spec.docSlug}`,
    `- stability: ${spec.stability}`,
    `- mutating: ${spec.mutating}`,
    `- raw_json_input: ${spec.supportsRawJsonInput}`,
    `- dry_run: ${spec.supportsDryRun}`,
    "",
    "## Output",
    ...spec.outputSchemaSummary.map((field) => `- ${field}`),
    "",
    "## Arguments",
    ...(spec.arguments.length === 0 ? ["- 없음"] : spec.arguments.map((arg) => `- ${arg.name} (${arg.type}, required=${arg.required}): ${arg.description}`)),
    "",
    "## Options",
    ...spec.options.map((option) => {
      const suffix = option.enum ? ` [${option.enum.join(", ")}]` : "";
      const defaultText = option.defaultValue === undefined ? "" : ` default=${option.defaultValue}`;
      return `- ${option.name} (${option.type}${suffix}): ${option.description}${defaultText}`;
    }),
    "",
    "## Related Commands",
    ...(spec.relatedCommands.length === 0 ? ["- none"] : spec.relatedCommands.map((command) => `- ${command}`)),
    "",
    "## Examples",
    ...spec.examples.map((example) => `- ${example}`),
  ].join("\n");

const ensureNoMixedInput = (input: string | undefined, values: Array<string | number | boolean | undefined>, label: string): void => {
  if (!input) return;
  if (values.some((value) => value !== undefined && value !== false)) {
    throw new Error(`${label}는 --input과 positional/도메인 옵션을 함께 사용할 수 없습니다.`);
  }
};

const parseOptionalPositiveNumber = (value: string | undefined, label: string): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} 값은 0보다 큰 number여야 합니다.`);
  }
  return parsed;
};

const parseOptionalPositiveSafeInteger = (value: string | undefined, label: string): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} 값은 양의 안전한 정수여야 합니다.`);
  }
  return parsed;
};

const collectRepeatedOption = (value: string, previous: string[] = []): string[] => [...previous, value];

program
  .name("ragit")
  .description("zvec + git 기반 로컬 RAG CLI")
  .version(RAGIT_VERSION);

program
  .command("init")
  .description("프로젝트 초기화")
  .option("--cwd <path>", "대상 저장소 루트 또는 그 하위 경로")
  .option("--yes", "질문 없이 기본값으로 초기화")
  .option("--non-interactive", "질문 없이 기본값으로 초기화")
  .option("--mode <mode>", "auto|empty|existing|monorepo|docs-heavy", "auto")
  .option("--strategy <strategy>", "minimal|balanced|full", "balanced")
  .option("--dry-run", "쓰기 없이 계획만 계산")
  .option("--merge-existing", "기존 문서를 우선 재사용", true)
  .option("--output <format>", "text|json|both", "text")
  .option("--git-init", "비대화형 모드에서 git 저장소 자동 초기화")
  .action(async (options) => {
    const cwd = await resolveInitRoot(await resolveCwd(options.cwd));
    const format = normalizeCliFormat(options.output, "text");
    const summary = await runInit(cwd, {
      nonInteractive: Boolean(options.yes || options.nonInteractive),
      gitInit: Boolean(options.gitInit),
      mode: options.mode as string | undefined,
      strategy: options.strategy as string | undefined,
      dryRun: Boolean(options.dryRun),
      mergeExisting: Boolean(options.mergeExisting),
      quiet: format === "json",
    });
    const envelope = buildCliEnvelope("init", cwd, summary);
    emitCliOutput({
      envelope,
      format,
      text: formatInitSummaryTable(summary),
    });
  });

program
  .command("log")
  .description("snapshot 기반 semantic history와 artifact-backed collaboration state")
  .argument("[revRange]")
  .option("-n, --max-count <n>", "최종 출력 entry 개수")
  .option("--view <view>", "minimal|default|full", "default")
  .option("--type <docType>", "adr|prd|srs|spec|plan|ddd|glossary|pbd")
  .option("--path <glob>", "repo 내부 glob 필터")
  .option("--show-missing", "snapshot 없는 commit도 함께 표시")
  .option("--format <format>", "text|json|both", "text")
  .option("--cwd <path>", "대상 저장소 경로")
  .action(async (revRange, options) => {
    const cwd = await resolveCwd(options.cwd);
    const docType = options.type ? normalizeKnownDocType(String(options.type)) : null;
    if (options.type && !docType) {
      throw new Error(`지원하지 않는 doc type입니다: ${options.type}`);
    }
    const result = await runRagitLog(cwd, {
      revRange: revRange ? String(revRange) : undefined,
      maxCount: parseOptionalPositiveNumber(options.maxCount as string | undefined, "log.maxCount"),
      docType,
      path: options.path ? assertSafeGlobText(String(options.path), "log.path") : undefined,
      showMissing: Boolean(options.showMissing),
    });
    const view = normalizeCliView(options.view, "default");
    emitCliOutput({
      envelope: buildCliEnvelope("log", cwd, projectRagitLogResult(result, view)),
      format: normalizeCliFormat(options.format, "text"),
      text: formatRagitLogText(result, view),
    });
  });

program
  .command("timeline")
  .description("append-only collaboration event timeline (`log`와 달리 semantic snapshot state는 요약하지 않음)")
  .option("--goal <goalId>", "goalId 필터")
  .option("--episode <episodeId>", "episodeId 필터")
  .option("--session <sessionId>", "sessionId 필터")
  .option("--kind <kind>", "session|artifact|memory|harness|ingest|security")
  .option("--since <iso>", "ISO-8601 lower bound")
  .option("--until <iso>", "ISO-8601 upper bound")
  .option("-n, --max-count <n>", "최종 출력 event 개수")
  .option("--view <view>", "minimal|default|full", "default")
  .option("--format <format>", "text|json|both", "text")
  .option("--cwd <path>", "대상 저장소 경로")
  .action(async (options) => {
    const cwd = await resolveCwd(options.cwd);
    const kind = options.kind ? String(options.kind).trim().toLowerCase() : undefined;
    if (kind && !["session", "artifact", "memory", "harness", "ingest", "security"].includes(kind)) {
      throw new Error(`지원하지 않는 timeline kind입니다: ${options.kind}`);
    }
    await runTimelineCommand(
      cwd,
      {
        goalId: options.goal ? String(options.goal) : undefined,
        episodeId: options.episode ? String(options.episode) : undefined,
        sessionId: options.session ? String(options.session) : undefined,
        kind: kind as "session" | "artifact" | "memory" | "harness" | "ingest" | "security" | undefined,
        since: options.since ? String(options.since) : undefined,
        until: options.until ? String(options.until) : undefined,
        maxCount: parseOptionalPositiveNumber(options.maxCount as string | undefined, "timeline.maxCount"),
      },
      normalizeCliFormat(options.format, "text"),
      normalizeCliView(options.view, "default"),
    );
  });

program
  .command("narrative")
  .description("snapshot/artifact/event를 합성해 self-contained HTML narrative report를 생성")
  .argument("[revRange]")
  .option("-n, --max-commits <n>", "선택할 indexed snapshot commit 개수")
  .option("--output <path>", "report 출력 경로")
  .option("--emit-model <path>", "sanitized narrative model JSON 출력 경로")
  .option("--open", "생성 후 기본 브라우저로 열기")
  .option("--dry-run", "파일을 쓰지 않고 계획만 계산")
  .option("--format <format>", "text|json|both", "text")
  .option("--cwd <path>", "대상 저장소 경로")
  .action(async (revRange, options) => {
    await runNarrativeCommand(
      await resolveCwd(options.cwd),
      {
        revRange: revRange ? String(revRange) : undefined,
        maxCommits: parseOptionalPositiveNumber(options.maxCommits as string | undefined, "narrative.maxCommits"),
        output: options.output ? String(options.output) : undefined,
        emitModel: options.emitModel ? String(options.emitModel) : undefined,
        open: Boolean(options.open),
        dryRun: Boolean(options.dryRun),
      },
      normalizeCliFormat(options.format, "text"),
    );
  });

program
  .command("drift")
  .description("현재 HEAD 기준으로 durable/memory/harness 지식 객체의 stale 여부를 판정")
  .option("--scope <scope>", "durable|memory|harness|all", "all")
  .option("--path <glob>", "repo 내부 glob 필터")
  .option("--goal <goalId>", "goalId 필터")
  .option("--session <sessionId>", "sessionId 필터")
  .option("-n, --max-count <n>", "최종 출력 item 개수")
  .option("--view <view>", "minimal|default|full", "default")
  .option("--format <format>", "text|json|both", "text")
  .option("--cwd <path>", "대상 저장소 경로")
  .action(async (options) => {
    const cwd = await resolveCwd(options.cwd);
    const scope = String(options.scope ?? "all").trim().toLowerCase();
    if (!["durable", "memory", "harness", "all"].includes(scope)) {
      throw new Error(`지원하지 않는 drift scope입니다: ${options.scope}`);
    }
    await runDriftCommand(
      cwd,
      {
        scope: scope as "durable" | "memory" | "harness" | "all",
        path: options.path ? assertSafeGlobText(String(options.path), "drift.path") : undefined,
        goalId: options.goal ? String(options.goal) : undefined,
        sessionId: options.session ? String(options.session) : undefined,
        maxCount: parseOptionalPositiveNumber(options.maxCount as string | undefined, "drift.maxCount"),
      },
      normalizeCliFormat(options.format, "text"),
      normalizeCliView(options.view, "default"),
    );
  });

program
  .command("repair")
  .description("drift 결과를 기반으로 기존 복구 명령을 orchestration 합니다")
  .option("--apply", "safe action만 실제 실행")
  .option("--scope <scope>", "durable|memory|harness|all", "all")
  .option("--path <glob>", "repo 내부 glob 필터")
  .option("--goal <goalId>", "goalId 필터")
  .option("--session <sessionId>", "sessionId 필터")
  .option("-n, --max-count <n>", "최종 출력 item 개수")
  .option("--action <kind>", "ingest|ingest-recover|store-rebuild|doc-refresh|artifact-review|harness-verify|harness-run|memory-promote", collectRepeatedOption, [])
  .option("--view <view>", "minimal|default|full", "default")
  .option("--format <format>", "text|json|both", "json")
  .option("--cwd <path>", "대상 저장소 경로")
  .action(async (options) => {
    const cwd = await resolveCwd(options.cwd);
    const scope = String(options.scope ?? "all").trim().toLowerCase();
    if (!["durable", "memory", "harness", "all"].includes(scope)) {
      throw new Error(`지원하지 않는 repair scope입니다: ${options.scope}`);
    }
    const actionValues = Array.isArray(options.action) ? (options.action as string[]) : [];
    const actions = actionValues.map((entry) => {
      const normalized = normalizeRepairActionKind(String(entry));
      if (!normalized) {
        throw new Error(`지원하지 않는 repair action입니다: ${entry}`);
      }
      return normalized;
    });
    await runRepairCommand(
      cwd,
      {
        apply: Boolean(options.apply),
        scope: scope as "durable" | "memory" | "harness" | "all",
        path: options.path ? assertSafeGlobText(String(options.path), "repair.path") : undefined,
        goalId: options.goal ? String(options.goal) : undefined,
        sessionId: options.session ? String(options.session) : undefined,
        maxCount: parseOptionalPositiveNumber(options.maxCount as string | undefined, "repair.maxCount"),
        actions,
      },
      normalizeCliFormat(options.format, "json"),
      normalizeCliView(options.view, "default"),
    );
  });

const security = program.command("security").description("지식 상태 보안 점검/정리");
security
  .command("audit")
  .description("control-plane, store, docs, provider egress 기준 보안 posture 점검")
  .option("--format <format>", "text|json|both", "json")
  .option("--cwd <path>", "대상 저장소 경로")
  .action(async (options) => {
    await runSecurityAuditCommand(
      await resolveCwd(options.cwd),
      normalizeCliFormat(options.format, "json"),
    );
  });

security
  .command("purge")
  .description("control-plane/store/cache/quarantine 정리")
  .option("--target <target>", "control-plane|store|cache|quarantine|all", "all")
  .option("--dry-run", "쓰기 없이 계획만 계산")
  .option("--format <format>", "text|json|both", "json")
  .option("--cwd <path>", "대상 저장소 경로")
  .action(async (options) => {
    const target = String(options.target ?? "all").trim().toLowerCase();
    if (!["control-plane", "store", "cache", "quarantine", "all"].includes(target)) {
      throw new Error(`지원하지 않는 security purge target입니다: ${options.target}`);
    }
    await runSecurityPurgeCommand(
      await resolveCwd(options.cwd),
      target as "control-plane" | "store" | "cache" | "quarantine" | "all",
      normalizeCliFormat(options.format, "json"),
      Boolean(options.dryRun),
    );
  });

program
  .command("describe")
  .description("command contract 설명")
  .argument("<commandPath...>")
  .option("--format <format>", "text|json|both", "json")
  .action(async (commandPath, options) => {
    const joined = Array.isArray(commandPath) ? commandPath.join(" ") : String(commandPath);
    const spec = describeCommandPath(joined);
    const envelope = buildCliEnvelope("describe", process.cwd(), {
      command: spec.path,
      availableCommands: listDescribableCommands(),
      spec,
    });
    emitCliOutput({
      envelope,
      format: normalizeCliFormat(options.format, "json"),
      text: formatDescribeText(spec),
    });
  });

const doc = program.command("doc").description("표준 문서 타입 생성/정합/검증");
doc
  .command("create")
  .description("표준 문서를 생성합니다.")
  .requiredOption("--type <docType>", "adr|prd|srs|spec|plan|ddd|glossary|pbd")
  .requiredOption("--title <title>", "문서 제목")
  .option("--path <path>", "생성할 repo 상대 경로")
  .option("--dry-run", "쓰기 없이 계획만 계산")
  .option("--format <format>", "text|json|both", "json")
  .option("--cwd <path>", "대상 저장소 경로")
  .action(async (options) => {
    const cwd = await resolveCwd(options.cwd);
    await runDocCreateCommand(
      cwd,
      {
        docType: String(options.type),
        title: String(options.title),
        path: options.path ? String(options.path) : undefined,
      },
      normalizeCliFormat(options.format, "json"),
      Boolean(options.dryRun),
    );
  });

doc
  .command("refresh")
  .description("표준 문서 구조를 비파괴 정합화합니다.")
  .option("--type <docType>", "adr|prd|srs|spec|plan|ddd|glossary|pbd")
  .option("--files <glob>", "정합화 대상 glob")
  .option("--dry-run", "쓰기 없이 계획만 계산")
  .option("--format <format>", "text|json|both", "json")
  .option("--cwd <path>", "대상 저장소 경로")
  .action(async (options) => {
    const cwd = await resolveCwd(options.cwd);
    await runDocRefreshCommand(
      cwd,
      {
        docType: options.type ? String(options.type) : undefined,
        files: options.files ? assertSafeGlobText(String(options.files), "doc.refresh.files") : undefined,
      },
      normalizeCliFormat(options.format, "json"),
      Boolean(options.dryRun),
    );
  });

doc
  .command("validate")
  .description("표준 문서 계약 위반 여부를 검사합니다.")
  .option("--type <docType>", "adr|prd|srs|spec|plan|ddd|glossary|pbd")
  .option("--all", "전체 타입 검사")
  .option("--format <format>", "text|json|both", "json")
  .option("--cwd <path>", "대상 저장소 경로")
  .action(async (options) => {
    const cwd = await resolveCwd(options.cwd);
    await runDocValidateCommand(
      cwd,
      {
        docType: options.type ? String(options.type) : undefined,
        all: Boolean(options.all),
      },
      normalizeCliFormat(options.format, "json"),
    );
  });

doc
  .command("reconcile")
  .description("기존 문서를 canonical 경로로 비파괴 매핑하고 인덱스를 갱신합니다.")
  .option("--dry-run", "쓰기 없이 계획만 계산")
  .option("--format <format>", "text|json|both", "json")
  .option("--cwd <path>", "대상 저장소 경로")
  .action(async (options) => {
    const cwd = await resolveCwd(options.cwd);
    await runDocReconcileCommand(cwd, normalizeCliFormat(options.format, "json"), Boolean(options.dryRun));
  });

program
  .command("config")
  .description("설정 관리")
  .command("set")
  .description("설정 키 업데이트")
  .argument("<key>")
  .argument("<value>")
  .option("--cwd <path>", "대상 저장소 경로")
  .action(async (key, value, options) => {
    await runConfigSet(await resolveCwd(options.cwd), key, value);
  });

const hooks = program.command("hooks").description("git hook 관리");
hooks
  .command("install")
  .description("hook 설치")
  .option("--cwd <path>", "대상 저장소 경로")
  .option("--dry-run", "미리보기 모드")
  .option("--format <format>", "text|json|both", "text")
  .action(async (options) => {
    const cwd = await resolveCwd(options.cwd);
    const result = await runHooksInstall(cwd, Boolean(options.dryRun));
    const envelope = buildCliEnvelope("hooks install", cwd, result);
    emitCliOutput({
      envelope,
      format: normalizeCliFormat(options.format, "text"),
      text: formatHooksText("ragit hooks install", result.hooks, result.dryRun),
    });
  });
hooks
  .command("uninstall")
  .description("hook 제거")
  .option("--cwd <path>", "대상 저장소 경로")
  .option("--dry-run", "미리보기 모드")
  .option("--format <format>", "text|json|both", "text")
  .action(async (options) => {
    const cwd = await resolveCwd(options.cwd);
    const result = await runHooksUninstall(cwd, Boolean(options.dryRun));
    const envelope = buildCliEnvelope("hooks uninstall", cwd, result);
    emitCliOutput({
      envelope,
      format: normalizeCliFormat(options.format, "text"),
      text: formatHooksText("ragit hooks uninstall", result.hooks, result.dryRun),
    });
  });
hooks
  .command("status")
  .description("hook 상태")
  .option("--cwd <path>", "대상 저장소 경로")
  .option("--format <format>", "text|json|both", "json")
  .action(async (options) => {
    const cwd = await resolveCwd(options.cwd);
    const result = await runHooksStatus(cwd);
    const envelope = buildCliEnvelope("hooks status", cwd, result);
    emitCliOutput({
      envelope,
      format: normalizeCliFormat(options.format, "json"),
      text: formatHooksText("ragit hooks status", result.hooks, result.dryRun),
    });
  });

program
  .command("ingest")
  .description("문서 인덱싱")
  .option("--all", "전체 문서 인덱싱")
  .option("--since <sha>", "지정 SHA 이후 변경분 인덱싱")
  .option("--files <glob>", "특정 glob 인덱싱")
  .option("--path <repoPath>", "특정 repo 상대 경로 인덱싱", collectRepeatedOption, [])
  .option("--scope <scope>", "durable|all", "durable")
  .option("--input <path|->", "JSON 입력 파일 경로 또는 -")
  .option("--dry-run", "미리보기 모드")
  .option("--format <format>", "text|json|both", "json")
  .option("--cwd <path>", "대상 저장소 경로")
  .action(async (options) => {
    const cwd = await resolveCwd(options.cwd);
    ensureNoMixedInput(
      options.input,
      [options.all, options.since, options.files, ...(options.path as string[]), options.scope === "durable" ? undefined : options.scope],
      "ingest",
    );
    const input = options.input
      ? normalizeIngestCommandInput(await readJsonInput(cwd, options.input, "ingest"))
      : {
          all: Boolean(options.all),
          since: options.since as string | undefined,
          files: options.files ? assertSafeGlobText(String(options.files), "ingest.files") : undefined,
          paths: Array.isArray(options.path) && options.path.length > 0 ? (options.path as string[]) : undefined,
          scope: (options.scope as "durable" | "all" | undefined) ?? "durable",
        };
    const summary = await runIngest(cwd, {
      all: input.all,
      since: input.since,
      files: input.files,
      paths: input.paths,
      scope: input.scope,
      dryRun: Boolean(options.dryRun),
    });
    const warnings = summary.warnings;
    emitCliOutput({
      envelope: buildCliEnvelope("ingest", cwd, summary, warnings),
      format: normalizeCliFormat(options.format, "json"),
      text: formatIngestText(summary),
    });
  });

program
  .command("query")
  .description("지식 검색")
  .argument("[question]")
  .option("--input <path|->", "JSON 입력 파일 경로 또는 -")
  .option("--top-k <n>", "결과 개수")
  .option("--scope <scope>", "durable|session|harness|evidence|all", "durable")
  .option("--format <format>", "text|json|both", "both")
  .option("--view <view>", "minimal|default|full", "default")
  .option("--explain", "점수 구성과 기여도를 출력")
  .option("--at <sha>", "특정 커밋 시점 조회")
  .option("--cwd <path>", "대상 저장소 경로")
  .action(async (question, options) => {
    const cwd = await resolveCwd(options.cwd);
    ensureNoMixedInput(
      options.input,
      [question, options.topK, options.at, options.scope === "durable" ? undefined : options.scope, options.explain],
      "query",
    );
    const input = options.input
      ? normalizeQueryCommandInput(await readJsonInput(cwd, options.input, "query"))
      : {
          question: String(question ?? "").trim(),
          topK: parseOptionalPositiveNumber(options.topK as string | undefined, "query.topK"),
          at: options.at as string | undefined,
          scope: options.scope as "durable" | "session" | "harness" | "evidence" | "all" | undefined,
          explain: Boolean(options.explain),
        };
    if (!input.question) {
      throw new Error("query 질문이 필요합니다.");
    }
    const view = normalizeCliView(options.view, "default");
    const explain = input.explain ?? false;
    const result = await searchKnowledge(cwd, input.question, {
      topK: input.topK,
      at: input.at,
      scope: input.scope,
    });
    const sanitizedQuestion = sanitizeKnowledgeText(input.question, "query.output", "query");
    const redactionSummary = mergeRedactionSummaries(sanitizedQuestion.summary, result.redactionSummary);
    const envelope = buildCliEnvelope(
      "query",
      cwd,
      {
        query: sanitizedQuestion.text,
        snapshotSha: result.snapshotSha,
        snapshot: result.snapshot,
        scope: input.scope ?? "durable",
        explain,
        hits: projectRetrievalHits(result.hits, view, explain),
        warnings: result.warnings,
        redactionSummary,
      },
      result.warnings,
    );
    emitCliOutput({
      envelope,
      format: normalizeCliFormat(options.format, "both"),
      text: formatQueryResultText(sanitizedQuestion.text, { ...result, redactionSummary }, view, explain),
    });
  });

program
  .command("context")
  .description("컨텍스트 패킹")
  .command("pack")
  .description("목표 기준 컨텍스트 생성")
  .argument("[goal]")
  .option("--input <path|->", "JSON 입력 파일 경로 또는 -")
  .option("--budget <tokens>", "공백 구분 콘텐츠 단위 기준의 양의 안전한 정수 예산")
  .option("--scope <scope>", "durable|session|harness|evidence|all", "durable")
  .option("--format <format>", "text|json|both", "both")
  .option("--view <view>", "minimal|default|full", "default")
  .option("--at <sha>", "특정 커밋 시점 조회")
  .option("--cwd <path>", "대상 저장소 경로")
  .action(async (goal, options) => {
    const cwd = await resolveCwd(options.cwd);
    ensureNoMixedInput(
      options.input,
      [goal, options.budget, options.at, options.scope === "durable" ? undefined : options.scope],
      "context pack",
    );
    const input = options.input
      ? normalizeContextPackCommandInput(await readJsonInput(cwd, options.input, "context pack"))
      : {
          goal: String(goal ?? "").trim(),
          budget: parseOptionalPositiveSafeInteger(options.budget as string | undefined, "context.budget"),
          at: options.at as string | undefined,
          scope: options.scope as "durable" | "session" | "harness" | "evidence" | "all" | undefined,
        };
    if (!input.goal) {
      throw new Error("context pack goal이 필요합니다.");
    }
    const view = normalizeCliView(options.view, "default");
    const packed = await packContext(cwd, input.goal, {
      budget: input.budget,
      at: input.at,
      scope: input.scope,
    });
    const envelope = buildCliEnvelope(
      "context pack",
      cwd,
      {
        ...projectContextPack(packed, view),
      },
      packed.warnings,
    );
    emitCliOutput({
      envelope,
      format: normalizeCliFormat(options.format, "both"),
      text: formatContextPackText(packed, view),
    });
  });

const memory = program.command("memory").description("메모리 운영");

memory
  .command("wrap")
  .description("세션 요약을 working memory에 기록")
  .requiredOption("--input <path|->", "JSON 입력 파일 경로 또는 - (stdin)")
  .option("--dry-run", "미리보기 모드")
  .option("--format <format>", "text|json|both", "json")
  .option("--cwd <path>", "대상 저장소 경로")
  .action(async (options) => {
    await runMemoryWrapCommand(
      await resolveCwd(options.cwd),
      options.input,
      normalizeCliFormat(options.format, "json"),
      Boolean(options.dryRun),
    );
  });

memory
  .command("recall")
  .description("목표 기준 복원 패킷 생성")
  .argument("<goal>")
  .option("--format <format>", "text|json|both", "both")
  .option("--view <view>", "minimal|default|full", "default")
  .option("--cwd <path>", "대상 저장소 경로")
  .action(async (goal, options) => {
    await runMemoryRecallCommand(
      await resolveCwd(options.cwd),
      goal,
      normalizeCliFormat(options.format, "both"),
      normalizeCliView(options.view, "default"),
    );
  });

memory
  .command("promote")
  .description("promotion candidate를 검색 가능한 장기기억 문서로 승격")
  .requiredOption("--input <path|->", "JSON 입력 파일 경로 또는 - (stdin)")
  .option("--dry-run", "미리보기 모드")
  .option("--format <format>", "text|json|both", "json")
  .option("--cwd <path>", "대상 저장소 경로")
  .action(async (options) => {
    await runMemoryPromoteCommand(
      await resolveCwd(options.cwd),
      options.input,
      normalizeCliFormat(options.format, "json"),
      Boolean(options.dryRun),
    );
  });

program
  .command("session")
  .description("세션 대화 물질화")
  .command("materialize")
  .requiredOption("--input <path|->", "JSON 입력 파일 경로 또는 -")
  .option("--dry-run", "미리보기 모드")
  .option("--format <format>", "text|json|both", "json")
  .option("--cwd <path>", "대상 저장소 경로")
  .action(async (options) => {
    await runSessionMaterializeCommand(
      await resolveCwd(options.cwd),
      options.input,
      normalizeCliFormat(options.format, "json"),
      Boolean(options.dryRun),
    );
  });

const artifact = program.command("artifact").description("artifact lifecycle 관리");
artifact
  .command("review")
  .requiredOption("--input <path|->", "JSON 입력 파일 경로 또는 -")
  .option("--dry-run", "미리보기 모드")
  .option("--format <format>", "text|json|both", "json")
  .option("--cwd <path>", "대상 저장소 경로")
  .action(async (options) => {
    await runArtifactReviewCommand(
      await resolveCwd(options.cwd),
      options.input,
      normalizeCliFormat(options.format, "json"),
      Boolean(options.dryRun),
    );
  });

const harness = program.command("harness").description("하네스 자원 관리");
harness
  .command("capture")
  .requiredOption("--input <path|->", "JSON 입력 파일 경로 또는 -")
  .option("--dry-run", "미리보기 모드")
  .option("--format <format>", "text|json|both", "json")
  .option("--cwd <path>", "대상 저장소 경로")
  .action(async (options) => {
    await runHarnessCaptureCommand(
      await resolveCwd(options.cwd),
      options.input,
      normalizeCliFormat(options.format, "json"),
      Boolean(options.dryRun),
    );
  });

harness
  .command("promote")
  .requiredOption("--input <path|->", "JSON 입력 파일 경로 또는 -")
  .option("--dry-run", "미리보기 모드")
  .option("--format <format>", "text|json|both", "json")
  .option("--cwd <path>", "대상 저장소 경로")
  .action(async (options) => {
    await runHarnessPromoteCommand(
      await resolveCwd(options.cwd),
      options.input,
      normalizeCliFormat(options.format, "json"),
      Boolean(options.dryRun),
    );
  });

harness
  .command("pack")
  .argument("<suiteRef>")
  .option("--format <format>", "text|json|both", "json")
  .option("--cwd <path>", "대상 저장소 경로")
  .action(async (suiteRef, options) => {
    await runHarnessPackCommand(await resolveCwd(options.cwd), String(suiteRef), normalizeCliFormat(options.format, "json"));
  });

harness
  .command("verify")
  .requiredOption("--suite <idOrPath>", "suite artifact id 또는 JSON 경로")
  .option("--format <format>", "text|json|both", "json")
  .option("--cwd <path>", "대상 저장소 경로")
  .action(async (options) => {
    await runHarnessVerifyCommand(await resolveCwd(options.cwd), String(options.suite), normalizeCliFormat(options.format, "json"));
  });

harness
  .command("run")
  .requiredOption("--input <path|->", "JSON 입력 파일 경로 또는 -")
  .option("--dry-run", "미리보기 모드")
  .option("--format <format>", "text|json|both", "json")
  .option("--cwd <path>", "대상 저장소 경로")
  .action(async (options) => {
    await runHarnessRunCommand(
      await resolveCwd(options.cwd),
      options.input,
      normalizeCliFormat(options.format, "json"),
      Boolean(options.dryRun),
    );
  });

const migrate = program.command("migrate").description("레거시 마이그레이션");

migrate
  .command("embeddings")
  .description("현재 store를 target embedding provider contract로 재구성")
  .option("--dry-run", "미리보기 모드")
  .option("--cwd <path>", "대상 저장소 경로")
  .action(async (options) => {
    const { migrateEmbeddings } = await import("./core/migrate.js");
    const result = await migrateEmbeddings(await resolveCwd(options.cwd), Boolean(options.dryRun));
    console.log(JSON.stringify(result, null, 2));
  });

migrate
  .command("from-json-store")
  .description("legacy json store 데이터를 zvec 저장소로 변환")
  .option("--dry-run", "미리보기 모드")
  .option("--cwd <path>", "대상 저장소 경로")
  .action(async (options) => {
    const { migrateFromJsonStore } = await import("./core/migrate.js");
    const result = await migrateFromJsonStore(await resolveCwd(options.cwd), Boolean(options.dryRun));
    console.log(JSON.stringify(result, null, 2));
  });

migrate
  .command("from-sqlitevss")
  .description("sqlite-vss 데이터를 zvec 저장소로 변환")
  .option("--dry-run", "미리보기 모드")
  .option("--cwd <path>", "대상 저장소 경로")
  .action(async (options) => {
    const { migrateFromSqliteVss } = await import("./core/migrate.js");
    const result = await migrateFromSqliteVss(await resolveCwd(options.cwd), Boolean(options.dryRun));
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("status")
  .description("현재 상태")
  .option("--format <format>", "text|json|both", "json")
  .option("--cwd <path>", "대상 저장소 경로")
  .action(async (options) => {
    const cwd = await resolveCwd(options.cwd);
    const status = await runStatus(cwd);
    const envelope = buildCliEnvelope("status", cwd, status);
    emitCliOutput({
      envelope,
      format: normalizeCliFormat(options.format, "json"),
      text: formatStatusText(status),
    });
  });

program
  .command("doctor")
  .description("환경 진단")
  .option("--format <format>", "text|json|both", "text")
  .option("--cwd <path>", "대상 저장소 경로")
  .action(async (options) => {
    const cwd = await resolveCwd(options.cwd);
    const result = await runDoctor(cwd);
    const envelope = buildCliEnvelope("doctor", cwd, result, [], !result.hasFailure);
    emitCliOutput({
      envelope,
      format: normalizeCliFormat(options.format, "text"),
      text: formatDoctorText(result),
    });
    if (result.hasFailure) {
      process.exitCode = 1;
    }
  });

program.parseAsync(process.argv).catch(async (error: unknown) => {
  if (isRagitOperationalError(error)) {
    const context = await resolveCliFailureContext(process.argv.slice(2));
    emitCliFailure({
      envelope: buildCliFailureEnvelope(context.command, context.cwd, error),
      format: context.format,
    });
    process.exitCode = error.exitCode;
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[ragit] 오류: ${message}`);
  process.exitCode = 1;
});
