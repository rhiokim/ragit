import { describe, expect, it } from "vitest";
import {
  contextSourceFamily,
  countContextTokens,
  selectContextHits,
} from "../src/core/context-selection.js";
import { buildRetrievalScoreBreakdown } from "../src/core/retrieval-explanation.js";
import type { RetrievalCitationSourceType, RetrievalHit } from "../src/core/types.js";

interface HitOptions {
  citationId?: string;
  sourceType?: RetrievalCitationSourceType;
  sourceId?: string;
  path?: string;
  artifactId?: string | null;
}

const hit = (name: string, text: string, options: HitOptions = {}): RetrievalHit => {
  const scoreBreakdown = buildRetrievalScoreBreakdown({
    mode: "hybrid",
    scoreVector: 0.8,
    scoreKeyword: 0.2,
    alpha: 0.7,
    authority: 1,
    recency: 1,
  });
  return {
    chunkId: `chunk-${name}`,
    path: options.path ?? `docs/${name}.md`,
    sectionTitle: name,
    scoreVector: 0.8,
    scoreKeyword: 0.2,
    scoreFinal: scoreBreakdown.final,
    scoreBreakdown,
    citation: {
      id: options.citationId ?? `cite-${name}`,
      sourceType: options.sourceType ?? "document",
      sourceId: options.sourceId ?? `source-${name}`,
      sourceVersion: "version-1",
      sourceSha: "a".repeat(40),
    },
    text,
    scope: "durable",
    originType: options.sourceType === "document" || options.sourceType === undefined ? "document" : "artifact",
    artifactId: options.artifactId,
  };
};

describe("context citation-diverse selection", () => {
  it("keeps the first occurrence of an exact citation duplicate", () => {
    const first = hit("first", "one two", { citationId: "cite-duplicate", path: "docs/first.md" });
    const duplicate = hit("duplicate", "one", { citationId: "cite-duplicate", path: "docs/duplicate.md" });
    const result = selectContextHits([first, duplicate], 10);

    expect(result.hits).toEqual([first]);
    expect(result.hits[0]).toBe(first);
    expect(result.summary).toMatchObject({
      candidateHits: 2,
      uniqueCitations: 1,
      duplicateCitationsSkipped: 1,
      budgetRejectedHits: 0,
      selectedSources: 1,
    });
  });

  it("derives stable document, artifact, and evidence source families", () => {
    expect(contextSourceFamily(hit("doc-a", "one", { path: "docs/a.md" }))).toBe("document:docs/a.md");
    expect(contextSourceFamily(hit("doc-b", "one", { path: "docs/b.md" }))).toBe("document:docs/b.md");
    expect(contextSourceFamily(hit("artifact", "one", {
      sourceType: "artifact",
      sourceId: "citation-artifact",
      artifactId: "artifact-record",
    }))).toBe("artifact:artifact-record");
    expect(contextSourceFamily(hit("artifact-fallback", "one", {
      sourceType: "artifact",
      sourceId: "citation-artifact",
      artifactId: null,
    }))).toBe("artifact:citation-artifact");
    expect(contextSourceFamily(hit("evidence", "one", {
      sourceType: "evidence",
      sourceId: "artifact-record:evidence-1",
      artifactId: "artifact-record",
    }))).toBe("evidence:artifact-record");
    expect(contextSourceFamily(hit("evidence-fallback", "one", {
      sourceType: "evidence",
      sourceId: "artifact-record:evidence-1",
      artifactId: null,
    }))).toBe("evidence:artifact-record:evidence-1");
  });

  it("selects one fitting source representative before ranked fill", () => {
    const a1 = hit("a1", "one two", { path: "docs/a.md" });
    const a2 = hit("a2", "one", { path: "docs/a.md" });
    const b1 = hit("b1", "one two", { path: "docs/b.md" });
    const c1 = hit("c1", "one two", { path: "docs/c.md" });
    const result = selectContextHits([a1, a2, b1, c1], 7);

    expect(result.hits).toEqual([a1, b1, c1, a2]);
    expect(result.usedTokens).toBe(7);
    expect(result.summary.selectedSources).toBe(3);
  });

  it("skips an oversized first hit and admits a smaller later hit", () => {
    const oversized = hit("oversized", "one two three four");
    const smaller = hit("smaller", "one two");
    const result = selectContextHits([oversized, smaller], 2);

    expect(countContextTokens(oversized.text)).toBe(4);
    expect(result.hits).toEqual([smaller]);
    expect(result.usedTokens).toBe(2);
    expect(result.usedTokens).toBeLessThanOrEqual(2);
    expect(result.summary.budgetRejectedHits).toBe(1);
  });

  it("is deterministic, non-mutating, and keeps summary equations exact", () => {
    const a1 = hit("a1", "one two", { citationId: "cite-a1", path: "docs/a.md" });
    const duplicate = hit("duplicate", "one", { citationId: "cite-a1", path: "docs/duplicate.md" });
    const b1 = hit("b1", "one two", { path: "docs/b.md" });
    const tooLarge = hit("too-large", "one two three four");
    const input = [a1, duplicate, b1, tooLarge];
    const before = structuredClone(input);

    const first = selectContextHits(input, 4);
    const second = selectContextHits(input, 4);

    expect(second).toEqual(first);
    expect(input).toEqual(before);
    expect(first.hits).toEqual([a1, b1]);
    expect(first.usedTokens).toBe(4);
    expect(first.usedTokens).toBeLessThanOrEqual(4);
    expect(first.summary.uniqueCitations).toBe(first.hits.length + first.summary.budgetRejectedHits);
    expect(first.summary.candidateHits).toBe(first.summary.uniqueCitations + first.summary.duplicateCitationsSkipped);
  });

  it("requires a positive safe-integer budget", () => {
    const candidate = hit("candidate", "one");
    for (const budget of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(() => selectContextHits([candidate], budget)).toThrow(/positive safe integer/);
    }
  });
});
