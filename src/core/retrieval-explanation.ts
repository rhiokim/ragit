import { createHash } from "node:crypto";
import type {
  RetrievalCitation,
  RetrievalHit,
  RetrievalScoreBreakdown,
  RetrievalScoreInput,
  RetrievalScoreStage,
} from "./types.js";

const RETRIEVAL_WEIGHT = 0.8;
const AUTHORITY_WEIGHT = 0.15;
const RECENCY_WEIGHT = 0.05;

export interface BuildRetrievalScoreBreakdownInput {
  mode: RetrievalScoreBreakdown["mode"];
  scoreVector: number;
  scoreKeyword: number;
  alpha: number;
  authority: number;
  recency: number;
}

const buildInput = (score: number, weight: number): RetrievalScoreInput => ({
  score,
  weight,
  contribution: score * weight,
});

const buildStage = (score: number, weight: number): RetrievalScoreStage => ({
  score,
  weight,
  contribution: score * weight,
});

export const calculateHybridScore = (scoreVector: number, scoreKeyword: number, alpha: number): number =>
  alpha * scoreVector + (1 - alpha) * scoreKeyword;

export const buildRetrievalScoreBreakdown = (
  input: BuildRetrievalScoreBreakdownInput,
): RetrievalScoreBreakdown => {
  const vectorWeight = input.mode === "hybrid" ? input.alpha : 0;
  const keywordWeight = input.mode === "hybrid" ? 1 - input.alpha : 1;
  const vector = buildInput(input.scoreVector, vectorWeight);
  const keyword = buildInput(input.scoreKeyword, keywordWeight);
  const retrieval = buildStage(vector.contribution + keyword.contribution, RETRIEVAL_WEIGHT);
  const authority = buildStage(input.authority, AUTHORITY_WEIGHT);
  const recency = buildStage(input.recency, RECENCY_WEIGHT);
  return {
    mode: input.mode,
    retrieval: { ...retrieval, inputs: { vector, keyword } },
    authority,
    recency,
    final: retrieval.contribution + authority.contribution + recency.contribution,
  };
};

export const buildRetrievalCitation = (
  input: Omit<RetrievalCitation, "id">,
): RetrievalCitation => {
  const digest = createHash("sha256")
    .update(`${input.sourceType}\0${input.sourceId}\0${input.sourceVersion}`)
    .digest("hex")
    .slice(0, 24);
  return { id: `cite-${digest}`, ...input };
};

const compareCodePoints = (left: string, right: string): number =>
  left === right ? 0 : left < right ? -1 : 1;

export const compareRetrievalHits = (left: RetrievalHit, right: RetrievalHit): number => {
  const byScore = right.scoreFinal - left.scoreFinal;
  if (byScore !== 0) return byScore;
  const byPath = compareCodePoints(left.path, right.path);
  if (byPath !== 0) return byPath;
  const bySection = compareCodePoints(left.sectionTitle, right.sectionTitle);
  if (bySection !== 0) return bySection;
  const byCitation = compareCodePoints(left.citation.id, right.citation.id);
  if (byCitation !== 0) return byCitation;
  return compareCodePoints(left.chunkId, right.chunkId);
};
