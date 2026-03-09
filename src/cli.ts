#!/usr/bin/env node

import { Command } from "commander";
import { resolveCwd, runConfigSet, runDoctor, runStatus } from "./commands/bootstrap.js";
import { HookActionResult, runHooksInstall, runHooksStatus, runHooksUninstall } from "./commands/hooks.js";
import { formatInitSummaryTable, resolveInitRoot, runInit } from "./commands/init.js";
import { runMemoryPromoteCommand, runMemoryRecallCommand, runMemoryWrapCommand } from "./commands/memory.js";
import { buildCliEnvelope, CliFormat, CliView, emitCliOutput, normalizeCliFormat, normalizeCliView } from "./core/cliContract.js";
import { assertSafeGlobText, readJsonInput } from "./core/cliInput.js";
import { normalizeContextPackCommandInput, normalizeIngestCommandInput, normalizeQueryCommandInput } from "./core/commandInputs.js";
import { describeCommandPath, listDescribableCommands } from "./core/commandRegistry.js";
import { formatContextPackText, packContext, projectContextPack } from "./core/context.js";
import { runIngest } from "./core/ingest.js";
import { formatQueryResultText, projectRetrievalHits } from "./core/output.js";
import { searchKnowledge } from "./core/retrieval.js";
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
    `- branch: ${status.branch}`,
    `- head: ${status.head}`,
    `- backend: ${status.backend}`,
    `- manifests: ${status.manifests}`,
    `- zvec: ${status.zvec.status}`,
    `- search_ready: ${status.zvec.searchReady}`,
    `- migration_required: ${status.zvec.migrationRequired}`,
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
    `- planned_files: ${summary.plannedFiles.length}`,
    `- deleted_document_ids: ${summary.deletedDocumentIds.length}`,
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
  .option("--output <format>", "text|json|both", "text")
  .option("--git-init", "비대화형 모드에서 git 저장소 자동 초기화")
  .action(async (options) => {
    const cwd = await resolveInitRoot(resolveCwd(options.cwd));
    const format = normalizeCliFormat(options.output, "text");
    const summary = await runInit(cwd, {
      nonInteractive: Boolean(options.yes || options.nonInteractive),
      gitInit: Boolean(options.gitInit),
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

program
  .command("config")
  .description("설정 관리")
  .command("set")
  .description("설정 키 업데이트")
  .argument("<key>")
  .argument("<value>")
  .option("--cwd <path>", "대상 저장소 경로")
  .action(async (key, value, options) => {
    await runConfigSet(resolveCwd(options.cwd), key, value);
  });

const hooks = program.command("hooks").description("git hook 관리");
hooks
  .command("install")
  .description("hook 설치")
  .option("--cwd <path>", "대상 저장소 경로")
  .option("--dry-run", "미리보기 모드")
  .option("--format <format>", "text|json|both", "text")
  .action(async (options) => {
    const cwd = resolveCwd(options.cwd);
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
    const cwd = resolveCwd(options.cwd);
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
    const cwd = resolveCwd(options.cwd);
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
  .option("--input <path|->", "JSON 입력 파일 경로 또는 -")
  .option("--dry-run", "미리보기 모드")
  .option("--format <format>", "text|json|both", "json")
  .option("--cwd <path>", "대상 저장소 경로")
  .action(async (options) => {
    const cwd = resolveCwd(options.cwd);
    ensureNoMixedInput(options.input, [options.all, options.since, options.files], "ingest");
    const input = options.input
      ? normalizeIngestCommandInput(await readJsonInput(cwd, options.input, "ingest"))
      : {
          all: Boolean(options.all),
          since: options.since as string | undefined,
          files: options.files ? assertSafeGlobText(String(options.files), "ingest.files") : undefined,
        };
    const summary = await runIngest(cwd, {
      all: input.all,
      since: input.since,
      files: input.files,
      dryRun: Boolean(options.dryRun),
    });
    const envelope = buildCliEnvelope("ingest", cwd, summary);
    emitCliOutput({
      envelope,
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
  .option("--format <format>", "text|json|both", "both")
  .option("--view <view>", "minimal|default|full", "default")
  .option("--at <sha>", "특정 커밋 시점 조회")
  .option("--cwd <path>", "대상 저장소 경로")
  .action(async (question, options) => {
    const cwd = resolveCwd(options.cwd);
    ensureNoMixedInput(options.input, [question, options.topK, options.at], "query");
    const input = options.input
      ? normalizeQueryCommandInput(await readJsonInput(cwd, options.input, "query"))
      : {
          question: String(question ?? "").trim(),
          topK: parseOptionalPositiveNumber(options.topK as string | undefined, "query.topK"),
          at: options.at as string | undefined,
        };
    if (!input.question) {
      throw new Error("query 질문이 필요합니다.");
    }
    const view = normalizeCliView(options.view, "default");
    const result = await searchKnowledge(cwd, input.question, {
      topK: input.topK,
      at: input.at,
    });
    const envelope = buildCliEnvelope("query", cwd, {
      query: input.question,
      snapshotSha: result.snapshotSha,
      hits: projectRetrievalHits(result.hits, view),
    });
    emitCliOutput({
      envelope,
      format: normalizeCliFormat(options.format, "both"),
      text: formatQueryResultText(input.question, result, view),
    });
  });

program
  .command("context")
  .description("컨텍스트 패킹")
  .command("pack")
  .description("목표 기준 컨텍스트 생성")
  .argument("[goal]")
  .option("--input <path|->", "JSON 입력 파일 경로 또는 -")
  .option("--budget <tokens>", "토큰 예산")
  .option("--format <format>", "text|json|both", "both")
  .option("--view <view>", "minimal|default|full", "default")
  .option("--at <sha>", "특정 커밋 시점 조회")
  .option("--cwd <path>", "대상 저장소 경로")
  .action(async (goal, options) => {
    const cwd = resolveCwd(options.cwd);
    ensureNoMixedInput(options.input, [goal, options.budget, options.at], "context pack");
    const input = options.input
      ? normalizeContextPackCommandInput(await readJsonInput(cwd, options.input, "context pack"))
      : {
          goal: String(goal ?? "").trim(),
          budget: parseOptionalPositiveNumber(options.budget as string | undefined, "context.budget"),
          at: options.at as string | undefined,
        };
    if (!input.goal) {
      throw new Error("context pack goal이 필요합니다.");
    }
    const view = normalizeCliView(options.view, "default");
    const packed = await packContext(cwd, input.goal, {
      budget: input.budget,
      at: input.at,
    });
    const envelope = buildCliEnvelope("context pack", cwd, projectContextPack(packed, view));
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
      resolveCwd(options.cwd),
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
      resolveCwd(options.cwd),
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
      resolveCwd(options.cwd),
      options.input,
      normalizeCliFormat(options.format, "json"),
      Boolean(options.dryRun),
    );
  });

const migrate = program.command("migrate").description("레거시 마이그레이션");

migrate
  .command("from-json-store")
  .description("legacy json store 데이터를 zvec 저장소로 변환")
  .option("--dry-run", "미리보기 모드")
  .option("--cwd <path>", "대상 저장소 경로")
  .action(async (options) => {
    const { migrateFromJsonStore } = await import("./core/migrate.js");
    const result = await migrateFromJsonStore(resolveCwd(options.cwd), Boolean(options.dryRun));
    console.log(JSON.stringify(result, null, 2));
  });

migrate
  .command("from-sqlitevss")
  .description("sqlite-vss 데이터를 zvec 저장소로 변환")
  .option("--dry-run", "미리보기 모드")
  .option("--cwd <path>", "대상 저장소 경로")
  .action(async (options) => {
    const { migrateFromSqliteVss } = await import("./core/migrate.js");
    const result = await migrateFromSqliteVss(resolveCwd(options.cwd), Boolean(options.dryRun));
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("status")
  .description("현재 상태")
  .option("--format <format>", "text|json|both", "json")
  .option("--cwd <path>", "대상 저장소 경로")
  .action(async (options) => {
    const cwd = resolveCwd(options.cwd);
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
    const cwd = resolveCwd(options.cwd);
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

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[ragit] 오류: ${message}`);
  process.exit(1);
});
