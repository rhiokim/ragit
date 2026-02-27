#!/usr/bin/env node

import { Command } from "commander";

const program = new Command();

const notImplemented = (name: string) => {
  console.log(`'${name}' 명령은 곧 구현됩니다.`);
};

program
  .name("ragit")
  .description("zvec + git 기반 로컬 RAG CLI")
  .version("0.1.0");

program.command("init").description("프로젝트 초기화").action(() => notImplemented("init"));

program
  .command("config")
  .description("설정 관리")
  .command("set")
  .description("설정 키 업데이트")
  .argument("<key>")
  .argument("<value>")
  .action(() => notImplemented("config set"));

const hooks = program.command("hooks").description("git hook 관리");
hooks.command("install").description("hook 설치").action(() => notImplemented("hooks install"));
hooks.command("uninstall").description("hook 제거").action(() => notImplemented("hooks uninstall"));
hooks.command("status").description("hook 상태").action(() => notImplemented("hooks status"));

program
  .command("ingest")
  .description("문서 인덱싱")
  .option("--all", "전체 문서 인덱싱")
  .option("--since <sha>", "지정 SHA 이후 변경분 인덱싱")
  .option("--files <glob>", "특정 glob 인덱싱")
  .action(() => notImplemented("ingest"));

program
  .command("query")
  .description("지식 검색")
  .argument("<question>")
  .option("--top-k <n>", "결과 개수", "5")
  .option("--format <format>", "markdown|json|both", "both")
  .option("--at <sha>", "특정 커밋 시점 조회")
  .action(() => notImplemented("query"));

program
  .command("context")
  .description("컨텍스트 패킹")
  .command("pack")
  .description("목표 기준 컨텍스트 생성")
  .argument("<goal>")
  .option("--budget <tokens>", "토큰 예산", "1200")
  .option("--at <sha>", "특정 커밋 시점 조회")
  .action(() => notImplemented("context pack"));

program
  .command("migrate")
  .description("레거시 마이그레이션")
  .command("from-sqlitevss")
  .description("sqlite-vss 데이터를 zvec 저장소로 변환")
  .option("--dry-run", "미리보기 모드")
  .action(() => notImplemented("migrate from-sqlitevss"));

program.command("status").description("현재 상태").action(() => notImplemented("status"));
program.command("doctor").description("환경 진단").action(() => notImplemented("doctor"));

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[ragit] 오류: ${message}`);
  process.exit(1);
});
