import { describe, expect, it } from "vitest";
import {
  buildRetrievalCitation,
  buildRetrievalScoreBreakdown,
} from "../src/core/retrieval-explanation.js";

describe("retrieval explanations", () => {
  it("calculates hybrid contributions with the existing final weights", () => {
    const result = buildRetrievalScoreBreakdown({
      mode: "hybrid",
      scoreVector: 0.8,
      scoreKeyword: 0.2,
      alpha: 0.7,
      authority: 0.9,
      recency: 0.6,
    });
    expect(result.retrieval.inputs.vector.score).toBe(0.8);
    expect(result.retrieval.inputs.vector.weight).toBe(0.7);
    expect(result.retrieval.inputs.vector.contribution).toBeCloseTo(0.56, 12);
    expect(result.retrieval.inputs.keyword.contribution).toBeCloseTo(0.06, 12);
    expect(result.retrieval.score).toBeCloseTo(0.62, 12);
    expect(result.retrieval.contribution).toBeCloseTo(0.496, 12);
    expect(result.authority.contribution).toBeCloseTo(0.135, 12);
    expect(result.recency.contribution).toBeCloseTo(0.03, 12);
    expect(result.final).toBeCloseTo(0.661, 12);
  });

  it("uses the full keyword score in keyword mode", () => {
    const result = buildRetrievalScoreBreakdown({
      mode: "keyword",
      scoreVector: 0.9,
      scoreKeyword: 0.5,
      alpha: 0.7,
      authority: 0.8,
      recency: 1,
    });
    expect(result.retrieval.inputs.vector).toEqual({ score: 0.9, weight: 0, contribution: 0 });
    expect(result.retrieval.inputs.keyword).toEqual({ score: 0.5, weight: 1, contribution: 0.5 });
    expect(result.retrieval.score).toBe(0.5);
    expect(result.final).toBeCloseTo(0.57, 12);
  });

  it("creates stable version-aware citations", () => {
    const source = {
      sourceType: "artifact" as const,
      sourceId: "artifact-1",
      sourceVersion: "content-v1",
      sourceSha: null,
    };
    const first = buildRetrievalCitation(source);
    const second = buildRetrievalCitation(source);
    expect(first).toEqual(second);
    expect(first.id).toMatch(/^cite-[a-f0-9]{24}$/);
    expect(buildRetrievalCitation({ ...source, sourceVersion: "content-v2" }).id).not.toBe(first.id);
    expect(buildRetrievalCitation({ ...source, sourceId: "artifact-1:evidence-2", sourceType: "evidence" }).id).not.toBe(first.id);
  });
});
