import { CliView } from "./cliContract.js";
import { QueryResult } from "./retrieval.js";
import { RetrievalHit } from "./types.js";

export type OutputFormat = "text" | "json" | "both";

export interface RenderedRetrievalHit {
  path: string;
  sectionTitle: string;
  scoreFinal: number;
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

export const projectRetrievalHit = (hit: RetrievalHit, view: CliView): RenderedRetrievalHit => {
  const base = {
    path: hit.path,
    sectionTitle: hit.sectionTitle,
    scoreFinal: Number(hit.scoreFinal.toFixed(6)),
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

export const projectRetrievalHits = (hits: RetrievalHit[], view: CliView): RenderedRetrievalHit[] =>
  hits.map((hit) => projectRetrievalHit(hit, view));

export const renderRetrievalHitLines = (hits: RetrievalHit[], view: CliView): string[] => {
  if (hits.length === 0) return ["- 없음"];
  return hits.flatMap((hit, index) => {
    const rendered = projectRetrievalHit(hit, view);
    const lines = [`${index + 1}. \`${rendered.path}\` · ${rendered.sectionTitle} · score=${rendered.scoreFinal.toFixed(4)}`];
    if (rendered.text) {
      lines.push(`   - ${rendered.text}`);
    } else if (rendered.excerpt) {
      lines.push(`   - ${rendered.excerpt}`);
    }
    return lines;
  });
};

export const formatQueryResultText = (query: string, result: QueryResult, view: CliView): string =>
  [
    "# ragit query",
    `- question: ${query}`,
    `- snapshot: ${result.snapshotSha}`,
    `- hits: ${result.hits.length}`,
    `- view: ${view}`,
    "",
    ...renderRetrievalHitLines(result.hits, view),
  ].join("\n");

