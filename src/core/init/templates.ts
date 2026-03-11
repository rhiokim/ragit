import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CoverageSummary,
  GapFillAction,
  InitActionSummary,
  InitMode,
  InitStrategy,
  KnowledgeMapEntry,
  ScanSummary,
} from "./types.js";

const frontmatter = (confidence: "high" | "medium" | "low"): string => `---
status: draft
source: inferred-from-repository
confidence: ${confidence}
last_generated_by: ragit init
---
`;

const renderKnowledgeMap = (knowledgeMap: KnowledgeMapEntry[]): string =>
  knowledgeMap
    .filter((entry) => entry.sources.length > 0)
    .map((entry) => `- \`${entry.slot}\`: ${entry.sources.map((source) => `\`${source}\``).join(", ")}`)
    .join("\n");

const coverageLines = (coverage: CoverageSummary): string[] => [
  `- Project overview: ${coverage.projectOverview.status}`,
  `- Local development guide: ${coverage.localDevelopmentGuide.status}`,
  `- Architecture rationale: ${coverage.architectureRationale.status}`,
  `- Decision records: ${coverage.decisionRecords.status}`,
  `- Package ownership map: ${coverage.packageOwnershipMap.status}`,
  `- Ingestion policy: ${coverage.ingestionPolicy.status}`,
];

const renderRagitMd = (params: {
  repositoryMode: InitMode;
  strategy: InitStrategy;
  scan: ScanSummary;
  knowledgeMap: KnowledgeMapEntry[];
  coverage: CoverageSummary;
}): string => {
  const { repositoryMode, strategy, scan, knowledgeMap, coverage } = params;
  return `${frontmatter(repositoryMode === "empty" ? "low" : "medium")}
# RAGIT

## Repository Snapshot

- Repository mode: \`${repositoryMode}\`
- Strategy: \`${strategy}\`
- Package manager: \`${scan.packageManager ?? "unknown"}\`
- Languages: ${scan.languages.length > 0 ? scan.languages.join(", ") : "none detected"}
- Frameworks: ${scan.frameworks.length > 0 ? scan.frameworks.join(", ") : "none detected"}
- Monorepo: ${scan.monorepo ? "yes" : "no"}
- Code files: ${scan.codeFileCount}
- Docs: ${scan.docFileCount}

## Knowledge Source Priority

${renderKnowledgeMap(knowledgeMap) || "- No primary knowledge sources detected yet."}

## Coverage Snapshot

${coverageLines(coverage).join("\n")}

## Operating Notes

- Prefer existing repository documents over generated drafts.
- Treat generated documents as inferred notes until humans validate them.
- Re-run \`ragit init --merge-existing\` when foundational docs drift.
`;
};

const renderWorkspaceMap = (params: { repositoryMode: InitMode; scan: ScanSummary }): string => {
  const { repositoryMode, scan } = params;
  return `${frontmatter(repositoryMode === "empty" ? "low" : "medium")}
# Workspace Map

## Topology

- Repository mode: \`${repositoryMode}\`
- Package manager: \`${scan.packageManager ?? "unknown"}\`
- Workspace files: ${scan.workspaceFiles.length > 0 ? scan.workspaceFiles.map((entry) => `\`${entry}\``).join(", ") : "none"}

## Applications

${scan.apps.length > 0 ? scan.apps.map((entry) => `- \`${entry}\``).join("\n") : "- No app directories detected."}

## Packages

${scan.packages.length > 0 ? scan.packages.map((entry) => `- \`${entry}\``).join("\n") : "- No package directories detected."}

## Notes

- This map is generated from the current repository layout.
- Validate ownership and package responsibilities before relying on it as source of truth.
`;
};

const renderIngestionPolicy = (params: { repositoryMode: InitMode; scan: ScanSummary }): string => {
  const includeLines = params.scan.monorepo
    ? ["README.md", "docs/**", "apps/**/README.md", "packages/**/README.md"]
    : ["README.md", "docs/**", "**/*.md", "**/*.mdx"];

  return `${frontmatter(params.repositoryMode === "empty" ? "low" : "medium")}
# Ingestion Policy

## Include

${includeLines.map((entry) => `- \`${entry}\``).join("\n")}

## Exclude

- \`.git/**\`
- \`.ragit/**\`
- \`node_modules/**\`
- \`dist/**\`
- \`coverage/**\`
- \`.next/**\`

## Notes

- Prefer stable human-authored docs as primary knowledge sources.
- Generated drafts remain indexable, but should not outrank validated repository docs.
`;
};

const renderKnownGaps = (coverage: CoverageSummary): string => {
  const gaps = coverageLines(coverage).filter((line) => !line.endsWith("sufficient"));
  return `${frontmatter(gaps.length === 0 ? "low" : "high")}
# Known Gaps

${gaps.length > 0 ? gaps.join("\n") : "- No major coverage gaps detected during init."}

## Follow-up Notes

- Missing or partial areas should be replaced with validated human-authored docs over time.
- Generated notes are a starting point for repository adoption, not final truth.
`;
};

const renderAdrReadme = (): string => `${frontmatter("medium")}
# ADR Guide

## Purpose

- Record durable architectural decisions with context, decision, and consequences.

## Naming

- Use short, stable titles that make the decision easy to reference later.
- Keep one decision per document.

## Minimum Structure

- Context
- Decision
- Consequences

## Operating Rule

- Prefer adding a new ADR over rewriting historical intent.
`;

export const renderGapFillDocument = (params: {
  targetPath: string;
  repositoryMode: InitMode;
  strategy: InitStrategy;
  scan: ScanSummary;
  knowledgeMap: KnowledgeMapEntry[];
  coverage: CoverageSummary;
  actions: InitActionSummary;
}): string => {
  const { targetPath, repositoryMode, strategy, scan, knowledgeMap, coverage } = params;
  if (targetPath === "RAGIT.md") {
    return renderRagitMd({ repositoryMode, strategy, scan, knowledgeMap, coverage });
  }
  if (targetPath === "docs/workspace-map.md") {
    return renderWorkspaceMap({ repositoryMode, scan });
  }
  if (targetPath === "docs/ragit/ingestion-policy.md") {
    return renderIngestionPolicy({ repositoryMode, scan });
  }
  if (targetPath === "docs/known-gaps.md") {
    return renderKnownGaps(coverage);
  }
  if (targetPath === "docs/adr/README.md") {
    return renderAdrReadme();
  }
  throw new Error(`지원하지 않는 init 생성 문서입니다: ${targetPath}`);
};

export const applyGapFillActions = async (params: {
  cwd: string;
  repositoryMode: InitMode;
  strategy: InitStrategy;
  scan: ScanSummary;
  knowledgeMap: KnowledgeMapEntry[];
  coverage: CoverageSummary;
  actions: InitActionSummary;
}): Promise<GapFillAction[]> => {
  const { cwd, actions } = params;
  const applied: GapFillAction[] = [];
  for (const action of actions.planned) {
    if (action.type !== "create") continue;
    const target = path.join(cwd, action.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(
      target,
      renderGapFillDocument({
        targetPath: action.path,
        repositoryMode: params.repositoryMode,
        strategy: params.strategy,
        scan: params.scan,
        knowledgeMap: params.knowledgeMap,
        coverage: params.coverage,
        actions,
      }),
      "utf8",
    );
    applied.push(action);
  }
  return applied;
};
