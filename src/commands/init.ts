import path from "node:path";
import { defaultConfig } from "../core/config.js";
import {
  buildGuideIndex,
  createTopologicalAgentsSeed,
  ensureAgentsInstruction,
  ensureGuideStructure,
  inspectAgentsInstruction,
  inspectGuideStructure,
  parseGuideBoundaries,
  templatePathsForSummary,
  writeGuideIndex,
} from "../core/guide.js";
import { initGitRepository, isGitRepository, tryGetGitRoot } from "../core/git.js";
import { ensureGitIgnoreEntries, ensureRagitDirectories, writeRagitConfig } from "../core/project.js";
import { bootstrapCanonicalStore, canonicalStoreSummary, closeCanonicalStore, ensureZvecRuntime, hasLegacyJsonStore } from "../core/store.js";
import { confirmStep, printStep } from "../core/wizard.js";
import { censusDocumentation } from "../core/init/doc-census.js";
import { planGapFill } from "../core/init/gap-fill.js";
import { buildKnowledgeMap } from "../core/init/knowledge-map.js";
import { detectRepositoryMode, normalizeInitMode } from "../core/init/mode.js";
import { assessMaturity } from "../core/init/maturity.js";
import { formatInitSummaryTable as formatDiscoverInitSummaryTable } from "../core/init/report.js";
import { scanRepository } from "../core/init/repo-scan.js";
import { applyGapFillActions } from "../core/init/templates.js";
import { InitBootstrapSummary, InitModeOption, InitReport, InitStrategy } from "../core/init/types.js";
import { RagitConfig } from "../core/types.js";

export interface InitOptions {
  nonInteractive?: boolean;
  gitInit?: boolean;
  quiet?: boolean;
  mode?: InitModeOption | string;
  strategy?: InitStrategy | string;
  dryRun?: boolean;
  mergeExisting?: boolean;
}

export type InitSummary = InitReport;

const totalSteps = 8;

export const resolveInitRoot = async (cwd: string): Promise<string> => (await tryGetGitRoot(cwd)) ?? cwd;

const ensureInteractiveAvailable = (interactive: boolean): void => {
  if (interactive && !process.stdin.isTTY) {
    throw new Error("TTY 환경이 아니므로 대화형 초기화를 실행할 수 없습니다. --yes 또는 --non-interactive를 사용해 주세요.");
  }
};

const normalizeStrategy = (value: string | undefined): InitStrategy => {
  if (!value) return "balanced";
  const normalized = value.trim().toLowerCase();
  if (normalized === "minimal" || normalized === "balanced" || normalized === "full") {
    return normalized;
  }
  throw new Error(`지원하지 않는 init strategy입니다: ${value}`);
};

const ensureGitContext = async (
  cwd: string,
  interactive: boolean,
  gitInitOption: boolean,
  dryRun: boolean,
): Promise<{ wasRepository: boolean; initialized: boolean }> => {
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
    if (!dryRun) {
      await initGitRepository(cwd);
    }
    return {
      wasRepository: false,
      initialized: !dryRun,
    };
  }

  const approved = await confirmStep("Git 저장소가 아닙니다. 현재 경로에서 git init을 실행하시겠습니까?", true);
  if (!approved) {
    throw new Error("초기화를 중단했습니다. Git 저장소에서 다시 실행해 주세요.");
  }
  if (!dryRun) {
    await initGitRepository(cwd);
  }
  return {
    wasRepository: false,
    initialized: !dryRun,
  };
};

const buildInitConfig = (root: string, summary: Pick<InitReport, "repositoryMode" | "strategy" | "scan">, mergeExisting: boolean): RagitConfig => {
  const config = defaultConfig();
  config.project.name = path.basename(root);
  config.project.mode = summary.repositoryMode;
  config.init.strategy = summary.strategy;
  config.init.merge_existing = mergeExisting;
  config.docs.entrypoint = "RAGIT.md";
  config.docs.workspace_map = "docs/workspace-map.md";
  config.docs.ingestion_policy = "docs/ragit/ingestion-policy.md";
  config.docs.known_gaps = "docs/known-gaps.md";
  config.docs.adr_dir = "docs/adr";
  config.ingest.include = summary.scan.monorepo
    ? ["README.md", "docs/**", "apps/**/README.md", "packages/**/README.md"]
    : ["README.md", "docs/**", "**/*.md", "**/*.mdx"];
  config.ingest.exclude = ["**/.git/**", "**/.ragit/**", "**/node_modules/**", "**/dist/**", "**/coverage/**", "**/.next/**"];
  return config;
};

const inspectBootstrapSummary = async (
  root: string,
  git: InitBootstrapSummary["git"],
  config: RagitConfig,
): Promise<InitBootstrapSummary> => {
  const [agents, guide, migrationRequired] = await Promise.all([
    inspectAgentsInstruction(root),
    inspectGuideStructure(root),
    hasLegacyJsonStore(root),
  ]);

  const storage = await (async () => {
    try {
      const summary = await canonicalStoreSummary(root, config.embedding, true);
      return {
        backend: "zvec" as const,
        status: (summary.status === "created" ? "planned" : "loaded") as "planned" | "loaded",
        collections: summary.collections,
        searchReady: false as const,
        migrationRequired: summary.migrationRequired,
      };
    } catch {
      return {
        backend: "zvec" as const,
        status: "planned" as const,
        collections: ["documents", "chunks"],
        searchReady: false as const,
        migrationRequired,
      };
    }
  })();

  return {
    git,
    agents: {
      path: path.relative(root, agents.path) || "AGENTS.md",
      mode: agents.mode,
      sha256: agents.sha256,
    },
    guide: {
      indexPath: path.relative(root, guide.indexPath).replaceAll(path.sep, "/"),
      createdFiles: guide.createdFiles,
      skippedFiles: guide.skippedFiles,
      templates: templatePathsForSummary(),
    },
    storage,
  };
};

const applyBootstrap = async (
  root: string,
  git: InitBootstrapSummary["git"],
  config: RagitConfig,
): Promise<InitBootstrapSummary> => {
  await ensureRagitDirectories(root);
  await ensureGitIgnoreEntries(root);
  await writeRagitConfig(root, config);

  const agents = await ensureAgentsInstruction(root);
  const guide = await ensureGuideStructure(root);
  const parsed = parseGuideBoundaries(agents.content ?? createTopologicalAgentsSeed());
  const index = buildGuideIndex(agents, parsed);
  const indexPath = await writeGuideIndex(root, index);
  ensureZvecRuntime();
  const store = await bootstrapCanonicalStore(root, config.embedding, false);
  try {
    return {
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
        templates: templatePathsForSummary(),
      },
      storage: {
        backend: "zvec",
        status: store.status,
        collections: [store.meta.collections.documents, store.meta.collections.chunks],
        searchReady: false,
        migrationRequired: await hasLegacyJsonStore(root),
      },
    };
  } finally {
    closeCanonicalStore(store);
  }
};

export const runInit = async (cwd: string, options: InitOptions = {}): Promise<InitSummary> => {
  const root = await resolveInitRoot(cwd);
  const interactive = !options.nonInteractive;
  const quiet = Boolean(options.quiet);
  const dryRun = Boolean(options.dryRun);
  const mergeExisting = options.mergeExisting ?? true;
  ensureInteractiveAvailable(interactive);

  const logStep = (index: number, message: string): void => {
    if (!quiet) {
      printStep(index, totalSteps, message);
    }
  };

  logStep(1, "Git 및 저장소 문맥 확인");
  const git = await ensureGitContext(root, interactive, Boolean(options.gitInit), dryRun);

  logStep(2, "저장소 스캔");
  const scan = await scanRepository(root);
  scan.gitDetected = git.wasRepository || git.initialized || scan.gitDetected;

  logStep(3, "초기화 모드 판정");
  const requestedMode = normalizeInitMode(typeof options.mode === "string" ? options.mode : options.mode);
  const repositoryMode = requestedMode === "auto" ? detectRepositoryMode(scan) : requestedMode;
  const strategy = normalizeStrategy(typeof options.strategy === "string" ? options.strategy : options.strategy);

  logStep(4, "문서 census 및 커버리지 평가");
  const documentation = await censusDocumentation(root, scan);

  logStep(5, "지식 맵 및 성숙도 평가");
  const knowledgeMap = buildKnowledgeMap(scan, documentation.coverage, documentation.documents);
  const maturity = assessMaturity(scan, documentation.coverage);

  logStep(6, "결손 문서 계획 수립");
  const actions = await planGapFill({
    cwd: root,
    repositoryMode,
    strategy,
    mergeExisting,
    coverage: documentation.coverage,
    knowledgeMap,
  });

  const config = buildInitConfig(root, { repositoryMode, strategy, scan }, mergeExisting);

  logStep(7, dryRun ? "bootstrap 계획 계산" : "control-plane 및 저장소 bootstrap");
  if (!dryRun) {
    await applyGapFillActions({
      cwd: root,
      repositoryMode,
      strategy,
      scan,
      knowledgeMap,
      coverage: documentation.coverage,
      actions,
    });
  }
  const bootstrap = dryRun
    ? await inspectBootstrapSummary(root, git, config)
    : await applyBootstrap(root, git, config);

  logStep(8, "결과 요약");
  const nextActions = dryRun
    ? ["rerun ragit init without --dry-run to apply changes"]
    : bootstrap.storage.migrationRequired
      ? ["ragit migrate from-json-store", "ragit hooks install", "ragit ingest --all"]
      : ["ragit hooks install", "ragit ingest --all"];

  return {
    executionMode: interactive ? "interactive" : "non-interactive",
    repositoryMode,
    strategy,
    scan,
    coverage: documentation.coverage,
    maturity,
    knowledgeMap,
    actions,
    bootstrap,
    nextActions,
  };
};

export const formatInitSummaryTable = (summary: InitSummary): string => formatDiscoverInitSummaryTable(summary);
