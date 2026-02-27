#!/usr/bin/env node

import { Command } from "commander";
import { resolveCwd, runConfigSet, runDoctor, runInit, runStatus } from "./commands/bootstrap.js";
import { runHooksInstall, runHooksStatus, runHooksUninstall } from "./commands/hooks.js";
import { packContext } from "./core/context.js";
import { runIngest } from "./core/ingest.js";
import { migrateFromSqliteVss } from "./core/migrate.js";
import { formatQueryResult, OutputFormat } from "./core/output.js";
import { searchKnowledge } from "./core/retrieval.js";

const program = new Command();

const notImplemented = (name: string) => {
  console.log(`'${name}' 명령은 곧 구현됩니다.`);
};

program
  .name("ragit")
  .description("zvec + git 기반 로컬 RAG CLI")
  .version("0.1.0");

program
  .command("init")
  .description("프로젝트 초기화")
  .option("--cwd <path>", "대상 저장소 경로")
  .action(async (options) => {
    await runInit(resolveCwd(options.cwd));
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

program
  .command("migrate")
  .description("레거시 마이그레이션")
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
