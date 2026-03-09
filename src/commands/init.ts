import { loadConfig } from "../core/config.js";
import path from "node:path";
import { buildGuideIndex, ensureAgentsInstruction, ensureGuideStructure, parseGuideBoundaries, templatePathsForSummary, writeGuideIndex } from "../core/guide.js";
import { initGitRepository, isGitRepository, tryGetGitRoot } from "../core/git.js";
import { ensureGitIgnoreEntries, ensureRagitStructure } from "../core/project.js";
import { bootstrapCanonicalStore, closeCanonicalStore, ensureZvecRuntime, hasLegacyJsonStore } from "../core/store.js";
import { KNOWN_DOC_TYPES } from "../core/types.js";
import { confirmStep, printStep } from "../core/wizard.js";

export interface InitOptions {
  nonInteractive?: boolean;
  gitInit?: boolean;
  quiet?: boolean;
}

export interface InitSummary {
  mode: "interactive" | "non-interactive";
  steps: string[];
  git: {
    wasRepository: boolean;
    initialized: boolean;
  };
  agents: {
    path: string;
    mode: "created" | "loaded";
    sha256: string;
  };
  guide: {
    indexPath: string;
    createdFiles: string[];
    skippedFiles: string[];
    templates: string[];
  };
  storage: {
    backend: "zvec";
    status: "created" | "loaded";
    collections: string[];
    searchReady: false;
    migrationRequired: boolean;
  };
  nextActions: string[];
}

const totalSteps = 7;

export const resolveInitRoot = async (cwd: string): Promise<string> => (await tryGetGitRoot(cwd)) ?? cwd;

const ensureInteractiveAvailable = (interactive: boolean): void => {
  if (interactive && !process.stdin.isTTY) {
    throw new Error("TTY 환경이 아니므로 대화형 초기화를 실행할 수 없습니다. --yes 또는 --non-interactive를 사용해 주세요.");
  }
};

const ensureGitContext = async (cwd: string, interactive: boolean, gitInitOption: boolean): Promise<{ wasRepository: boolean; initialized: boolean }> => {
  const wasRepository = await isGitRepository(cwd);
  if (wasRepository) {
    return {
      wasRepository: true,
      initialized: false,
    };
  }

  if (!interactive) {
    if (!gitInitOption) {
      throw new Error("Git 저장소가 아닙니다. --git-init 옵션을 사용하거나 대화형 모드에서 진행해 주세요.");
    }
    await initGitRepository(cwd);
    return {
      wasRepository: false,
      initialized: true,
    };
  }

  const approved = await confirmStep("Git 저장소가 아닙니다. 현재 경로에서 git init을 실행하시겠습니까?", true);
  if (!approved) {
    throw new Error("초기화를 중단했습니다. Git 저장소에서 다시 실행해 주세요.");
  }
  await initGitRepository(cwd);
  return {
    wasRepository: false,
    initialized: true,
  };
};

export const runInit = async (cwd: string, options: InitOptions = {}): Promise<InitSummary> => {
  const root = await resolveInitRoot(cwd);
  const interactive = !options.nonInteractive;
  const quiet = Boolean(options.quiet);
  ensureInteractiveAvailable(interactive);
  const mode = interactive ? "interactive" : "non-interactive";
  const stepLogs: string[] = [];

  const logStep = (index: number, message: string): void => {
    if (!quiet) {
      printStep(index, totalSteps, message);
    }
  };

  logStep(1, "환경 검사");
  ensureZvecRuntime();
  const git = await ensureGitContext(root, interactive, Boolean(options.gitInit));
  stepLogs.push(git.wasRepository ? "git repository detected" : "git repository initialized");

  logStep(2, "초기화 모드 확인");
  if (interactive) {
    const proceed = await confirmStep("대화형 7단계 초기화를 기본값으로 진행하시겠습니까?", true);
    if (!proceed) {
      throw new Error("사용자 요청으로 초기화를 중단했습니다.");
    }
  }
  stepLogs.push(`mode=${mode}`);

  logStep(3, "루트 AGENTS.md 로드/생성");
  await ensureRagitStructure(root);
  await ensureGitIgnoreEntries(root);
  const agents = await ensureAgentsInstruction(root);
  stepLogs.push(`agents=${agents.mode}`);

  logStep(4, "지원 문서 템플릿 안내");
  const templates = templatePathsForSummary();
  stepLogs.push(`doc-types=${KNOWN_DOC_TYPES.join(",")}`);

  logStep(5, "가이드 구조 생성 및 인덱스 갱신");
  const guide = await ensureGuideStructure(root);
  const parsed = parseGuideBoundaries(agents.content);
  const index = buildGuideIndex(agents, parsed);
  const indexPath = await writeGuideIndex(root, index);
  stepLogs.push(`boundaries=${parsed.boundaries.length}`);

  logStep(6, "zvec 저장소 bootstrap");
  const config = await loadConfig(root);
  const storage = await (async () => {
    const store = await bootstrapCanonicalStore(root, config.embedding, false);
    try {
      return {
        backend: "zvec" as const,
        status: store.status,
        collections: [store.meta.collections.documents, store.meta.collections.chunks],
        searchReady: false as const,
        migrationRequired: await hasLegacyJsonStore(root),
      };
    } finally {
      closeCanonicalStore(store);
    }
  })();
  stepLogs.push(`storage=${storage.status}`);

  logStep(7, "결과 요약");
  const nextActions = storage.migrationRequired
    ? ["ragit migrate from-json-store", "ragit hooks install", "ragit ingest --all"]
    : ["ragit hooks install", "ragit ingest --all"];
  stepLogs.push("summary=ready");

  return {
    mode,
    steps: stepLogs,
    git,
    agents: {
      path: path.relative(root, agents.path) || "AGENTS.md",
      mode: agents.mode,
      sha256: agents.sha256,
    },
    guide: {
      indexPath: path.relative(root, indexPath).replaceAll(path.sep, "/"),
      createdFiles: guide.createdFiles,
      skippedFiles: guide.skippedFiles,
      templates,
    },
    storage,
    nextActions,
  };
};

const pad = (text: string, size: number): string => `${text}${" ".repeat(Math.max(0, size - text.length))}`;

export const formatInitSummaryTable = (summary: InitSummary): string => {
  const created = summary.guide.createdFiles.length;
  const skipped = summary.guide.skippedFiles.length;
  const lines = [
    "ragit init summary",
    "------------------",
    `${pad("mode", 18)}: ${summary.mode}`,
    `${pad("git", 18)}: ${summary.git.wasRepository ? "existing" : summary.git.initialized ? "initialized" : "unknown"}`,
    `${pad("agents", 18)}: ${summary.agents.mode} (${summary.agents.path})`,
    `${pad("guide-index", 18)}: ${summary.guide.indexPath}`,
    `${pad("templates", 18)}: created=${created}, skipped=${skipped}`,
    `${pad("boundaries step", 18)}: ${summary.steps.find((entry) => entry.startsWith("boundaries="))?.replace("boundaries=", "") ?? "0"}`,
    `${pad("zvec", 18)}: ${summary.storage.status} (${summary.storage.collections.join(",")})`,
    `${pad("search-ready", 18)}: ${summary.storage.searchReady ? "true" : "false"}`,
    `${pad("migration", 18)}: ${summary.storage.migrationRequired ? "required" : "none"}`,
    "",
    "next actions:",
    ...summary.nextActions.map((action) => `- ${action}`),
  ];
  return lines.join("\n");
};
