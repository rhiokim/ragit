import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { ConfidenceLevel, CoverageSummary, GapFillAction, InitActionSummary, InitMode, InitStrategy, KnowledgeMapEntry } from "./types.js";

const fileExists = async (target: string): Promise<boolean> => {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

interface GapFillPriority {
  path: string;
  wanted: boolean;
  reason: string;
  confidence: ConfidenceLevel;
  sourcePaths: string[];
}

export const planGapFill = async (params: {
  cwd: string;
  repositoryMode: InitMode;
  strategy: InitStrategy;
  mergeExisting: boolean;
  coverage: CoverageSummary;
  knowledgeMap: KnowledgeMapEntry[];
}): Promise<InitActionSummary> => {
  const { cwd, repositoryMode, strategy, mergeExisting, coverage, knowledgeMap } = params;
  const slotSources = new Map(knowledgeMap.map((entry) => [entry.slot, entry.sources]));
  const actions: GapFillAction[] = [];

  const priorities: GapFillPriority[] = [
    {
      path: "RAGIT.md",
      wanted:
        strategy === "full" ||
        strategy === "balanced" ||
        strategy === "minimal",
      reason: "agent/RAG 관점 진입점이 필요합니다.",
      confidence: "medium" as const,
      sourcePaths: [...(slotSources.get("project") ?? []), ...(slotSources.get("product") ?? [])],
    },
    {
      path: "docs/workspace-map.md",
      wanted:
        strategy === "full" ||
        repositoryMode === "empty" ||
        repositoryMode === "monorepo" ||
        coverage.packageOwnershipMap.status !== "sufficient",
      reason:
        coverage.packageOwnershipMap.status === "sufficient"
          ? "workspace 구조가 이미 충분합니다."
          : "디렉토리/패키지 구조를 agent 친화적으로 명시해야 합니다.",
      confidence: repositoryMode === "monorepo" ? "high" : "medium",
      sourcePaths: slotSources.get("workspace") ?? [],
    },
    {
      path: "docs/ragit/ingestion-policy.md",
      wanted: strategy !== "minimal" ? coverage.ingestionPolicy.status !== "sufficient" || repositoryMode === "empty" : true,
      reason:
        coverage.ingestionPolicy.status === "sufficient"
          ? "ingestion 정책이 이미 문서화되어 있습니다."
          : "인덱싱 포함/제외 기준이 필요합니다.",
      confidence: "medium" as const,
      sourcePaths: slotSources.get("ingestion-policy") ?? [],
    },
    {
      path: "docs/known-gaps.md",
      wanted:
        strategy === "full" ||
        coverage.projectOverview.status !== "sufficient" ||
        coverage.localDevelopmentGuide.status !== "sufficient" ||
        coverage.architectureRationale.status !== "sufficient" ||
        coverage.decisionRecords.status !== "sufficient" ||
        coverage.packageOwnershipMap.status !== "sufficient" ||
        coverage.ingestionPolicy.status !== "sufficient",
      reason: "현재 문서 결손을 초안으로 기록해야 합니다.",
      confidence: "high" as const,
      sourcePaths: [],
    },
    {
      path: "docs/adr/README.md",
      wanted:
        strategy === "full" ||
        repositoryMode === "empty" ||
        coverage.decisionRecords.status !== "sufficient",
      reason:
        coverage.decisionRecords.status === "sufficient"
          ? "의사결정 문서가 이미 존재합니다."
          : "ADR 운영 규칙이 필요합니다.",
      confidence: coverage.decisionRecords.status === "missing" ? "high" : "medium",
      sourcePaths: slotSources.get("decisions") ?? [],
    },
  ];

  for (const item of priorities) {
    const absolutePath = `${cwd}/${item.path}`;
    const exists = await fileExists(absolutePath);
    if (exists) {
      actions.push({
        type: "reuse",
        path: item.path,
        reason: mergeExisting ? "기존 문서를 우선 재사용합니다." : "1단계 init은 기존 핵심 문서를 덮어쓰지 않습니다.",
        confidence: item.confidence,
        sourcePaths: item.sourcePaths,
      });
      continue;
    }
    if (!item.wanted) {
      actions.push({
        type: "skip",
        path: item.path,
        reason: item.reason,
        confidence: item.confidence,
        sourcePaths: item.sourcePaths,
      });
      continue;
    }
    actions.push({
      type: "create",
      path: item.path,
      reason: item.reason,
      confidence: item.confidence,
      sourcePaths: item.sourcePaths,
    });
  }

  const reusedFromKnowledge = knowledgeMap
    .flatMap((entry) => entry.sources)
    .filter((source) => !actions.some((action) => action.path === source))
    .sort((left, right) => {
      const leftWeight = left === "README.md" || left === "CONTRIBUTING.md" ? -1 : 0;
      const rightWeight = right === "README.md" || right === "CONTRIBUTING.md" ? -1 : 0;
      if (leftWeight !== rightWeight) return leftWeight - rightWeight;
      return left.localeCompare(right);
    });

  return {
    mergeExisting,
    planned: actions,
    created: actions.filter((action) => action.type === "create").map((action) => action.path),
    reused: [
      ...new Set([
        ...actions.filter((action) => action.type === "reuse").map((action) => action.path),
        ...reusedFromKnowledge,
      ]),
    ],
    skipped: actions.filter((action) => action.type === "skip").map((action) => action.path),
  };
};
