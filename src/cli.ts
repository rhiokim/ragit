#!/usr/bin/env node

import { Command } from "commander";
import { resolveCwd, runConfigSet, runDoctor, runStatus } from "./commands/bootstrap.js";
import { runHooksInstall, runHooksStatus, runHooksUninstall } from "./commands/hooks.js";
import { formatInitSummaryTable, runInit } from "./commands/init.js";
import { runMemoryPromoteCommand, runMemoryRecallCommand, runMemoryWrapCommand } from "./commands/memory.js";
import { packContext } from "./core/context.js";
import { runIngest } from "./core/ingest.js";
import { migrateFromJsonStore, migrateFromSqliteVss } from "./core/migrate.js";
import { formatQueryResult, OutputFormat } from "./core/output.js";
import { searchKnowledge } from "./core/retrieval.js";

const program = new Command();

program
  .name("ragit")
  .description("zvec + git 기반 로컬 RAG CLI")
  .version("0.1.0");

program
  .command("init")
  .description("프로젝트 초기화")
  .option("--cwd <path>", "대상 저장소 경로")
  .option("--yes", "질문 없이 기본값으로 초기화")
  .option("--non-interactive", "질문 없이 기본값으로 초기화")
  .option("--output <format>", "table|json", "table")
  .option("--git-init", "비대화형 모드에서 git 저장소 자동 초기화")
  .action(async (options) => {
    const outputFormat = options.output === "json" ? "json" : "table";
    const summary = await runInit(resolveCwd(options.cwd), {
      nonInteractive: Boolean(options.yes || options.nonInteractive),
      gitInit: Boolean(options.gitInit),
      quiet: outputFormat === "json",
    });
    if (outputFormat === "json") {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }
    console.log(formatInitSummaryTable(summary));
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
  .action(async (options) => {
    await runHooksInstall(resolveCwd(options.cwd));
  });
hooks
  .command("uninstall")
  .description("hook 제거")
  .option("--cwd <path>", "대상 저장소 경로")
  .action(async (options) => {
    await runHooksUninstall(resolveCwd(options.cwd));
  });
hooks
  .command("status")
  .description("hook 상태")
  .option("--cwd <path>", "대상 저장소 경로")
  .action(async (options) => {
    await runHooksStatus(resolveCwd(options.cwd));
  });

program
  .command("ingest")
  .description("문서 인덱싱")
  .option("--all", "전체 문서 인덱싱")
  .option("--since <sha>", "지정 SHA 이후 변경분 인덱싱")
  .option("--files <glob>", "특정 glob 인덱싱")
  .option("--cwd <path>", "대상 저장소 경로")
  .action(async (options) => {
    const summary = await runIngest(resolveCwd(options.cwd), {
      all: options.all,
      since: options.since,
      files: options.files,
    });
    console.log(JSON.stringify(summary, null, 2));
  });

program
  .command("query")
  .description("지식 검색")
  .argument("<question>")
  .option("--top-k <n>", "결과 개수", "5")
  .option("--format <format>", "markdown|json|both", "both")
  .option("--at <sha>", "특정 커밋 시점 조회")
  .option("--cwd <path>", "대상 저장소 경로")
  .action(async (question, options) => {
    const format = (options.format as OutputFormat) ?? "both";
    const result = await searchKnowledge(resolveCwd(options.cwd), question, {
      topK: Number(options.topK),
      at: options.at,
    });
    const output = formatQueryResult(question, result, format);
    if (output.markdown) console.log(output.markdown);
    if (output.json) console.log(output.json);
  });

program
  .command("context")
  .description("컨텍스트 패킹")
  .command("pack")
  .description("목표 기준 컨텍스트 생성")
  .argument("<goal>")
  .option("--budget <tokens>", "토큰 예산", "1200")
  .option("--at <sha>", "특정 커밋 시점 조회")
  .option("--cwd <path>", "대상 저장소 경로")
  .action(async (goal, options) => {
    const packed = await packContext(resolveCwd(options.cwd), goal, {
      budget: Number(options.budget),
      at: options.at,
    });
    console.log(packed.markdown);
    console.log(packed.json);
  });

const memory = program.command("memory").description("메모리 운영");

memory
  .command("wrap")
  .description("세션 요약을 working memory에 기록")
  .requiredOption("--input <path|->", "JSON 입력 파일 경로 또는 - (stdin)")
  .option("--cwd <path>", "대상 저장소 경로")
  .action(async (options) => {
    await runMemoryWrapCommand(resolveCwd(options.cwd), options.input);
  });

memory
  .command("recall")
  .description("목표 기준 복원 패킷 생성")
  .argument("<goal>")
  .option("--format <format>", "markdown|json|both", "both")
  .option("--cwd <path>", "대상 저장소 경로")
  .action(async (goal, options) => {
    const format = (options.format as OutputFormat) ?? "both";
    await runMemoryRecallCommand(resolveCwd(options.cwd), goal, format);
  });

memory
  .command("promote")
  .description("promotion candidate를 검색 가능한 장기기억 문서로 승격")
  .requiredOption("--input <path|->", "JSON 입력 파일 경로 또는 - (stdin)")
  .option("--cwd <path>", "대상 저장소 경로")
  .action(async (options) => {
    await runMemoryPromoteCommand(resolveCwd(options.cwd), options.input);
  });

const migrate = program.command("migrate").description("레거시 마이그레이션");

migrate
  .command("from-json-store")
  .description("legacy json store 데이터를 zvec 저장소로 변환")
  .option("--dry-run", "미리보기 모드")
  .option("--cwd <path>", "대상 저장소 경로")
  .action(async (options) => {
    const result = await migrateFromJsonStore(resolveCwd(options.cwd), Boolean(options.dryRun));
    console.log(JSON.stringify(result, null, 2));
  });

migrate
  .command("from-sqlitevss")
  .description("sqlite-vss 데이터를 zvec 저장소로 변환")
  .option("--dry-run", "미리보기 모드")
  .option("--cwd <path>", "대상 저장소 경로")
  .action(async (options) => {
    const result = await migrateFromSqliteVss(resolveCwd(options.cwd), Boolean(options.dryRun));
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("status")
  .description("현재 상태")
  .option("--cwd <path>", "대상 저장소 경로")
  .action(async (options) => {
    await runStatus(resolveCwd(options.cwd));
  });

program
  .command("doctor")
  .description("환경 진단")
  .option("--cwd <path>", "대상 저장소 경로")
  .action(async (options) => {
    await runDoctor(resolveCwd(options.cwd));
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[ragit] 오류: ${message}`);
  process.exit(1);
});
