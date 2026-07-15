import { describe, expect, it } from "vitest";
import { normalizeQueryCommandInput } from "../src/core/commandInputs.js";
import { formatQueryResultText, projectRetrievalHit } from "../src/core/output.js";
import { buildRetrievalCitation, buildRetrievalScoreBreakdown } from "../src/core/retrieval-explanation.js";
import type { RetrievalHit } from "../src/core/types.js";

const scoreBreakdown = buildRetrievalScoreBreakdown({
  mode: "hybrid",
  scoreVector: 0.8,
  scoreKeyword: 0.2,
  alpha: 0.7,
  authority: 1,
  recency: 1,
});
const hit: RetrievalHit = {
  chunkId: "chunk-1",
  path: "docs/auth.md",
  sectionTitle: "Refresh Flow",
  scoreVector: 0.8,
  scoreKeyword: 0.2,
  scoreFinal: scoreBreakdown.final,
  scoreBreakdown,
  citation: buildRetrievalCitation({
    sourceType: "document",
    sourceId: "chunk-1",
    sourceVersion: "version-1",
    sourceSha: "a".repeat(40),
  }),
  text: "Restore the refresh-token context.",
  scope: "durable",
  originType: "document",
};

describe("retrieval output", () => {
  it("always projects citations and gates score details behind explain", () => {
    for (const view of ["minimal", "default", "full"] as const) {
      const normal = projectRetrievalHit(hit, view);
      expect(normal.citation).toEqual(hit.citation);
      expect(normal.scoreBreakdown).toBeUndefined();
      const explained = projectRetrievalHit(hit, view, true);
      expect(explained.citation).toEqual(hit.citation);
      expect(explained.scoreBreakdown?.mode).toBe("hybrid");
      expect(explained.scoreBreakdown?.final).toBe(Number(hit.scoreFinal.toFixed(6)));
    }
  });

  it("renders a citation and compact explanation line", () => {
    const text = formatQueryResultText(
      "restore auth context",
      {
        snapshotSha: "a".repeat(40),
        snapshot: {
          requestedRef: "HEAD",
          resolvedSha: "a".repeat(40),
          selection: "head-exact",
          status: "indexed",
          branch: "main",
          detached: false,
          worktreeDirty: false,
        },
        hits: [hit],
        warnings: [],
        redactionSummary: { applied: false, maskedCount: 0, sources: [] },
      },
      "minimal",
      true,
    );
    expect(text).toContain(`[${hit.citation.id}]`);
    expect(text).toContain("mode=hybrid");
    expect(text).toContain("vector=");
    expect(text).toContain("keyword=");
    expect(text).toContain("- explain: true");
  });

  it("normalizes only boolean JSON explain input", () => {
    expect(normalizeQueryCommandInput({ question: "restore auth", explain: true }).explain).toBe(true);
    expect(() => normalizeQueryCommandInput({ question: "restore auth", explain: "true" })).toThrow(/boolean/);
  });
});
