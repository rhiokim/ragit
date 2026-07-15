import type { RetrievalHit } from "./types.js";

export interface ContextPackSelectionSummary {
  strategy: "citation-diverse-v2";
  candidateHits: number;
  uniqueCitations: number;
  selectedSources: number;
  duplicateCitationsSkipped: number;
  budgetRejectedHits: number;
}

export interface ContextHitSelection {
  hits: RetrievalHit[];
  usedTokens: number;
  summary: ContextPackSelectionSummary;
}

export const countContextTokens = (text: string): number => text.split(/\s+/).filter(Boolean).length;

export const contextSourceFamily = (hit: RetrievalHit): string => {
  if (hit.citation.sourceType === "document") return `document:${hit.path}`;
  const sourceId = hit.artifactId ?? hit.citation.sourceId;
  return `${hit.citation.sourceType}:${sourceId}`;
};

export const selectContextHits = (hits: RetrievalHit[], budget: number): ContextHitSelection => {
  if (!Number.isSafeInteger(budget) || budget <= 0) {
    throw new Error("context budget must be a positive safe integer");
  }

  const seenCitations = new Set<string>();
  const uniqueCandidates: Array<{ hit: RetrievalHit; tokens: number; sourceFamily: string }> = [];
  let duplicateCitationsSkipped = 0;
  for (const hit of hits) {
    if (seenCitations.has(hit.citation.id)) {
      duplicateCitationsSkipped += 1;
      continue;
    }
    seenCitations.add(hit.citation.id);
    uniqueCandidates.push({
      hit,
      tokens: countContextTokens(hit.text),
      sourceFamily: contextSourceFamily(hit),
    });
  }

  const selected: RetrievalHit[] = [];
  const selectedCitationIds = new Set<string>();
  const diversitySources = new Set<string>();
  let usedTokens = 0;
  const canFit = (tokens: number): boolean => usedTokens + tokens <= budget;
  const select = (candidate: { hit: RetrievalHit; tokens: number; sourceFamily: string }): void => {
    selected.push(candidate.hit);
    selectedCitationIds.add(candidate.hit.citation.id);
    usedTokens += candidate.tokens;
  };

  for (const candidate of uniqueCandidates) {
    if (diversitySources.has(candidate.sourceFamily) || !canFit(candidate.tokens)) continue;
    select(candidate);
    diversitySources.add(candidate.sourceFamily);
  }

  for (const candidate of uniqueCandidates) {
    if (selectedCitationIds.has(candidate.hit.citation.id) || !canFit(candidate.tokens)) continue;
    select(candidate);
  }

  const selectedSources = new Set(selected.map(contextSourceFamily)).size;
  const budgetRejectedHits = uniqueCandidates.length - selected.length;
  return {
    hits: selected,
    usedTokens,
    summary: {
      strategy: "citation-diverse-v2",
      candidateHits: hits.length,
      uniqueCitations: uniqueCandidates.length,
      selectedSources,
      duplicateCitationsSkipped,
      budgetRejectedHits,
    },
  };
};
