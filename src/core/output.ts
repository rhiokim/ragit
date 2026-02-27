import { QueryResult } from "./retrieval.js";
import { RetrievalHit } from "./types.js";

export type OutputFormat = "markdown" | "json" | "both";

const compactText = (text: string, max = 200): string => {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max)}...`;
};

const toMarkdownRows = (hits: RetrievalHit[]): string =>
  hits
    .map(
      (hit, index) =>
        `${index + 1}. \`${hit.path}\` · ${hit.sectionTitle} · score=${hit.scoreFinal.toFixed(4)}\n   - ${compactText(hit.text)}`,
    )
    .join("\n");

export const formatQueryResult = (
  query: string,
  result: QueryResult,
  format: OutputFormat,
): { markdown?: string; json?: string } => {
  const payload = {
    query,
    snapshotSha: result.snapshotSha,
    hits: result.hits.map((hit) => ({
      ...hit,
      scoreVector: Number(hit.scoreVector.toFixed(6)),
      scoreKeyword: Number(hit.scoreKeyword.toFixed(6)),
      scoreFinal: Number(hit.scoreFinal.toFixed(6)),
    })),
  };
  const markdown = [
    `# ragit query`,
    `- question: ${query}`,
    `- snapshot: ${result.snapshotSha}`,
    `- hits: ${result.hits.length}`,
    "",
    toMarkdownRows(result.hits),
  ].join("\n");
  const json = JSON.stringify(payload, null, 2);

  if (format === "markdown") return { markdown };
  if (format === "json") return { json };
  return { markdown, json };
};
