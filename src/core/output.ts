import { CliView } from "./cliContract.js";
import { QueryResult } from "./retrieval.js";
import { RetrievalHit } from "./types.js";

export type OutputFormat = "text" | "json" | "both";

export interface RenderedRetrievalHit {
  path: string;
  sectionTitle: string;
  scoreFinal: number;
  citation: RetrievalHit["citation"];
  scoreBreakdown?: RetrievalHit["scoreBreakdown"];
  scope?: RetrievalHit["scope"];
  originType?: RetrievalHit["originType"];
  artifactId?: RetrievalHit["artifactId"];
  artifactKind?: RetrievalHit["artifactKind"];
  authority?: RetrievalHit["authority"];
  confidence?: RetrievalHit["confidence"];
  scoreVector?: number;
  scoreKeyword?: number;
  excerpt?: string;
  text?: string;
}

const compactText = (text: string, max = 200): string => {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max)}...`;
};

const excerptLengthForView = (view: CliView): number => {
  if (view === "minimal") return 120;
  if (view === "default") return 200;
  return 2000;
};

const roundScore = (value: number): number => Number(value.toFixed(6));

const projectScoreBreakdown = (value: RetrievalHit["scoreBreakdown"]): RetrievalHit["scoreBreakdown"] => ({
  mode: value.mode,
  retrieval: {
    score: roundScore(value.retrieval.score),
    weight: roundScore(value.retrieval.weight),
    contribution: roundScore(value.retrieval.contribution),
    inputs: {
      vector: {
        score: roundScore(value.retrieval.inputs.vector.score),
        weight: roundScore(value.retrieval.inputs.vector.weight),
        contribution: roundScore(value.retrieval.inputs.vector.contribution),
      },
      keyword: {
        score: roundScore(value.retrieval.inputs.keyword.score),
        weight: roundScore(value.retrieval.inputs.keyword.weight),
        contribution: roundScore(value.retrieval.inputs.keyword.contribution),
      },
    },
  },
  authority: {
    score: roundScore(value.authority.score),
    weight: roundScore(value.authority.weight),
    contribution: roundScore(value.authority.contribution),
  },
  recency: {
    score: roundScore(value.recency.score),
    weight: roundScore(value.recency.weight),
    contribution: roundScore(value.recency.contribution),
  },
  final: roundScore(value.final),
});

export const projectRetrievalHit = (hit: RetrievalHit, view: CliView, explain = false): RenderedRetrievalHit => {
  const base = {
    path: hit.path,
    sectionTitle: hit.sectionTitle,
    scoreFinal: Number(hit.scoreFinal.toFixed(6)),
    citation: hit.citation,
    scoreBreakdown: explain ? projectScoreBreakdown(hit.scoreBreakdown) : undefined,
    scope: hit.scope,
    originType: hit.originType,
    artifactId: hit.artifactId,
    artifactKind: hit.artifactKind,
    authority: hit.authority,
    confidence: hit.confidence === undefined || hit.confidence === null ? hit.confidence : Number(hit.confidence.toFixed(6)),
  };
  if (view === "minimal") {
    return {
      ...base,
      excerpt: compactText(hit.text, excerptLengthForView(view)),
    };
  }
  if (view === "default") {
    return {
      ...base,
      scoreVector: Number(hit.scoreVector.toFixed(6)),
      scoreKeyword: Number(hit.scoreKeyword.toFixed(6)),
      excerpt: compactText(hit.text, excerptLengthForView(view)),
    };
  }
  return {
    ...base,
    scoreVector: Number(hit.scoreVector.toFixed(6)),
    scoreKeyword: Number(hit.scoreKeyword.toFixed(6)),
    text: hit.text,
  };
};

export const projectRetrievalHits = (hits: RetrievalHit[], view: CliView, explain = false): RenderedRetrievalHit[] =>
  hits.map((hit) => projectRetrievalHit(hit, view, explain));

export const renderRetrievalHitLines = (hits: RetrievalHit[], view: CliView, explain = false): string[] => {
  if (hits.length === 0) return ["- 없음"];
  return hits.flatMap((hit, index) => {
    const rendered = projectRetrievalHit(hit, view, explain);
    const lines = [`${index + 1}. [${rendered.citation.id}] \`${rendered.path}\` · ${rendered.sectionTitle} · score=${rendered.scoreFinal.toFixed(4)}`];
    if (rendered.scoreBreakdown) {
      const breakdown = rendered.scoreBreakdown;
      lines.push(
        `   - explanation: mode=${breakdown.mode} retrieval=${breakdown.retrieval.score.toFixed(4)}×${breakdown.retrieval.weight.toFixed(4)}→${breakdown.retrieval.contribution.toFixed(4)} vector=${breakdown.retrieval.inputs.vector.score.toFixed(4)}×${breakdown.retrieval.inputs.vector.weight.toFixed(4)}→${breakdown.retrieval.inputs.vector.contribution.toFixed(4)} keyword=${breakdown.retrieval.inputs.keyword.score.toFixed(4)}×${breakdown.retrieval.inputs.keyword.weight.toFixed(4)}→${breakdown.retrieval.inputs.keyword.contribution.toFixed(4)} authority=${breakdown.authority.score.toFixed(4)}×${breakdown.authority.weight.toFixed(4)}→${breakdown.authority.contribution.toFixed(4)} recency=${breakdown.recency.score.toFixed(4)}×${breakdown.recency.weight.toFixed(4)}→${breakdown.recency.contribution.toFixed(4)} final=${breakdown.final.toFixed(4)}`,
      );
    }
    if (rendered.text) {
      lines.push(`   - ${rendered.text}`);
    } else if (rendered.excerpt) {
      lines.push(`   - ${rendered.excerpt}`);
    }
    return lines;
  });
};

export const formatQueryResultText = (query: string, result: QueryResult, view: CliView, explain = false): string => {
  const warningLines = result.warnings.map((warning) => `- warning: ${warning}`);
  return [
    "# ragit query",
    `- question: ${query}`,
    `- snapshot: ${result.snapshotSha}`,
    `- requested_ref: ${result.snapshot.requestedRef}`,
    `- resolved_sha: ${result.snapshot.resolvedSha ?? "null"}`,
    `- selection: ${result.snapshot.selection}`,
    `- status: ${result.snapshot.status}`,
    `- branch: ${result.snapshot.branch ?? "null"}`,
    `- detached: ${result.snapshot.detached}`,
    `- worktree_dirty: ${result.snapshot.worktreeDirty}`,
    `- hits: ${result.hits.length}`,
    `- warnings: ${result.warnings.length}`,
    `- view: ${view}`,
    `- explain: ${explain}`,
    `- redaction_applied: ${result.redactionSummary.applied}`,
    `- masked_count: ${result.redactionSummary.maskedCount}`,
    ...warningLines,
    "",
    ...renderRetrievalHitLines(result.hits, view, explain),
  ].join("\n");
};
