# Retrieval Explanations and Citations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every retrieval hit a stable, version-aware citation and add opt-in score-contribution explanations without changing configured ranking weights or snapshot-selection behavior.

**Architecture:** A new pure module owns score composition, citation identity, and deterministic hit comparison. Snapshot retrieval, explicit artifact retrieval, and the public artifact search API construct the same required `RetrievalHit` contract. Output projection always preserves citations and exposes the already-computed breakdown only when `ragit query --explain` or JSON `explain: true` is requested.

**Tech Stack:** TypeScript 5.9, Node.js 20.19+ `node:crypto`, Commander 14, Vitest 4, existing RAGit retrieval/artifact/security APIs, zvec, MDX documentation.

## Global Constraints

- The approved design is `docs/superpowers/specs/2026-07-15-retrieval-explanations-citations-design.md`.
- Keep `retrieval.alpha` configurable and unchanged; do not tune its default `0.7`.
- Keep final weights exactly retrieval `0.80`, authority `0.15`, and recency `0.05`.
- `--explain` is presentation-only and must not enter candidate selection, scoring, deduplication, or sorting.
- Every `RetrievalHit` must contain required `citation` and `scoreBreakdown` values before sanitization.
- Every projected hit must contain `citation`; `scoreBreakdown` appears only when explanation is requested.
- Use keyword weight `1` whenever artifact/evidence candidate embeddings were not actually computed.
- Citation IDs use source identity and version only; never use query, rank, score, time, source text, or absolute path.
- Exact ties use deterministic code-point comparisons; do not use `localeCompare` or an epsilon.
- Do not change snapshot selection, candidate limits, Context Pack token selection, embedding profiles, benchmark thresholds, MCP behavior, or package version.
- Placeholder benchmark results remain development-only and cannot justify production-quality claims.
- Terra implements the plan. Sol Max reviews every commit, reruns gates independently, and alone decides whether to push or merge.

---

## File Map

- Create `src/core/retrieval-explanation.ts`: pure score builder, citation builder, and deterministic hit comparator.
- Create `test/retrieval-explanation.test.ts`: hand-calculated score, citation identity, and tie-order unit tests.
- Modify `src/core/types.ts`: required retrieval citation and score-breakdown types.
- Modify `src/core/retrieval.ts`: construct the required contract, correct artifact fallback, and use deterministic deduplication/sorting.
- Modify `src/core/artifacts.ts`: return the same required contract from `searchArtifacts`.
- Modify `test/retrieval.test.ts`: retain the public hybrid-score compatibility assertion.
- Modify `test/embedding-execution.integration.test.ts`: prove remote artifact candidate fallback is keyword-only and does not add a remote candidate call.
- Modify `test/memory.test.ts`: prove degraded recall hits carry a keyword breakdown and citation.
- Create `test/output.test.ts`: output view, rounding, text rendering, and query-input normalization tests.
- Modify `src/core/output.ts`: always project citations and conditionally project rounded explanations.
- Modify `src/core/commandInputs.ts`: accept strict JSON `explain?: boolean`.
- Modify `src/cli.ts`: add `--explain`, mixed-input enforcement, and output propagation.
- Modify `src/core/commandRegistry.ts`: describe the new option and additive output fields.
- Modify `src/core/memory.ts`: include citations in memory-recall text hits.
- Modify `test/cli.contract.test.ts`: exercise CLI and raw-JSON explanation contracts.
- Modify `README.md`: explain citation, score formula, keyword fallback, and development-only benchmark interpretation.
- Modify `apps/docs/content/docs/en/commands/query.mdx`: document the English query contract.
- Modify `apps/docs/content/docs/ko/commands/query.mdx`: keep the Korean query contract in parity.

### Task 1: Pure score and citation contracts

**Files:**
- Create: `src/core/retrieval-explanation.ts`
- Create: `test/retrieval-explanation.test.ts`
- Modify: `src/core/types.ts` immediately before `RetrievalHit`
- Modify: `src/core/retrieval.ts` only to re-export `calculateHybridScore`

**Interfaces:**
- Produces: `calculateHybridScore(scoreVector: number, scoreKeyword: number, alpha: number): number`
- Produces: `buildRetrievalScoreBreakdown(input: BuildRetrievalScoreBreakdownInput): RetrievalScoreBreakdown`
- Produces: `buildRetrievalCitation(input: Omit<RetrievalCitation, "id">): RetrievalCitation`
- Preserves: the existing import path `../src/core/retrieval.js` for `calculateHybridScore`.

- [ ] **Step 1: Write failing pure-contract tests**

Create `test/retrieval-explanation.test.ts` with the exact behavioral cases below:

```ts
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
```

- [ ] **Step 2: Run the tests and confirm the missing-module failure**

Run:

```bash
pnpm exec vitest run test/retrieval-explanation.test.ts test/retrieval.test.ts
```

Expected: FAIL because `src/core/retrieval-explanation.ts` and the new types do not exist.

- [ ] **Step 3: Add the score and citation value types**

Insert before `RetrievalHit` in `src/core/types.ts`:

```ts
export type RetrievalCitationSourceType = "document" | "artifact" | "evidence";

export interface RetrievalCitation {
  id: string;
  sourceType: RetrievalCitationSourceType;
  sourceId: string;
  sourceVersion: string;
  sourceSha: string | null;
}

export interface RetrievalScoreInput {
  score: number;
  weight: number;
  contribution: number;
}

export interface RetrievalScoreStage {
  score: number;
  weight: number;
  contribution: number;
}

export interface RetrievalScoreBreakdown {
  mode: "hybrid" | "keyword";
  retrieval: RetrievalScoreStage & {
    inputs: {
      vector: RetrievalScoreInput;
      keyword: RetrievalScoreInput;
    };
  };
  authority: RetrievalScoreStage;
  recency: RetrievalScoreStage;
  final: number;
}
```

- [ ] **Step 4: Implement the pure module**

Create `src/core/retrieval-explanation.ts`:

```ts
import { createHash } from "node:crypto";
import type {
  RetrievalCitation,
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
```

Remove the local `calculateHybridScore` definition from `src/core/retrieval.ts`, import the helper for its existing local callers, and preserve its public location with:

```ts
import { calculateHybridScore } from "./retrieval-explanation.js";
export { calculateHybridScore };
```

- [ ] **Step 5: Run the pure tests and type-check through the build**

Run:

```bash
pnpm exec vitest run test/retrieval-explanation.test.ts test/retrieval.test.ts
pnpm build
```

Expected: pure tests and build PASS. `RetrievalHit` itself remains unchanged until Task 2 can update every constructor atomically.

- [ ] **Step 6: Commit Task 1**

```bash
git add src/core/types.ts src/core/retrieval-explanation.ts src/core/retrieval.ts test/retrieval-explanation.test.ts
git commit -m "feat(retrieval): define explanations and citations"
```

### Task 2: Retrieval integration, correct fallback, and stable ranking

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/core/retrieval-explanation.ts`
- Modify: `src/core/retrieval.ts`
- Modify: `src/core/artifacts.ts`
- Modify: `test/retrieval-explanation.test.ts`
- Modify: `test/embedding-execution.integration.test.ts`
- Modify: `test/memory.test.ts`
- Modify if the existing assertion needs its import adjusted: `test/retrieval.test.ts`

**Interfaces:**
- Consumes: Task 1 score/citation value types and builders.
- Produces: `compareRetrievalHits(left: RetrievalHit, right: RetrievalHit): number`.
- Produces: required `RetrievalHit.scoreBreakdown` and `RetrievalHit.citation` fields.
- Produces: snapshot, artifact, evidence, degraded-recall, and `searchArtifacts` hits with complete explanations and citations.
- Preserves: existing `QueryResult`, `UnifiedRetrievalResult`, and `ArtifactSearchResult` outer shapes.

- [ ] **Step 1: Add failing fallback and integration assertions**

In `test/embedding-execution.integration.test.ts`, extend the existing OpenAI artifact-search test immediately after `artifactSearch` is returned:

```ts
const artifactHit = artifactSearch.hits[0];
expect(artifactHit?.citation.sourceType).toBe("artifact");
expect(artifactHit?.scoreBreakdown.mode).toBe("keyword");
expect(artifactHit?.scoreBreakdown.retrieval.inputs.vector.weight).toBe(0);
expect(artifactHit?.scoreBreakdown.retrieval.inputs.keyword.weight).toBe(1);
expect(artifactHit?.scoreBreakdown.retrieval.score).toBe(artifactHit?.scoreKeyword);
```

Keep the existing call-count assertion. It proves remote query embedding occurs once while prohibited artifact candidate embedding does not add a call.

In `test/memory.test.ts`, extend the degraded artifact hit assertion:

```ts
expect(artifactHit?.citation.id).toMatch(/^cite-[a-f0-9]{24}$/);
expect(artifactHit?.citation.sourceType).toBe("artifact");
expect(artifactHit?.scoreBreakdown.mode).toBe("keyword");
expect(artifactHit?.scoreBreakdown.retrieval.inputs.keyword.weight).toBe(1);
expect(artifactHit?.scoreFinal).toBeCloseTo(artifactHit!.scoreBreakdown.final, 12);
```

In `test/retrieval-explanation.test.ts`, import `compareRetrievalHits` and `RetrievalHit`. Add this fixture and exact-tie test:

```ts
const makeHit = (path: string, sectionTitle: string, scoreFinal = 0.5): RetrievalHit => {
  const scoreBreakdown = buildRetrievalScoreBreakdown({
    mode: "keyword",
    scoreVector: 0,
    scoreKeyword: 0.5,
    alpha: 0.7,
    authority: 0.5,
    recency: 0.5,
  });
  return {
    chunkId: `chunk:${path}:${sectionTitle}`,
    path,
    sectionTitle,
    scoreVector: 0,
    scoreKeyword: 0.5,
    scoreFinal,
    scoreBreakdown: { ...scoreBreakdown, final: scoreFinal },
    citation: buildRetrievalCitation({
      sourceType: "document",
      sourceId: `chunk:${path}:${sectionTitle}`,
      sourceVersion: "version-1",
      sourceSha: "a".repeat(40),
    }),
    text: "source text",
    scope: "durable",
    originType: "document",
  };
};

it("orders exact ties independently of insertion order", () => {
  const hits = [makeHit("b.md", "A"), makeHit("a.md", "B"), makeHit("a.md", "A")];
  const forward = [...hits].sort(compareRetrievalHits).map((hit) => `${hit.path}#${hit.sectionTitle}`);
  const reverse = [...hits].reverse().sort(compareRetrievalHits).map((hit) => `${hit.path}#${hit.sectionTitle}`);
  expect(forward).toEqual(["a.md#A", "a.md#B", "b.md#A"]);
  expect(reverse).toEqual(forward);
});
```

- [ ] **Step 2: Run focused tests and confirm missing required fields or wrong keyword weight**

Run:

```bash
pnpm exec vitest run test/retrieval-explanation.test.ts test/retrieval.test.ts test/embedding-execution.integration.test.ts test/memory.test.ts
```

Expected: FAIL until every retrieval constructor supplies the new fields and keyword fallback uses weight `1`.

- [ ] **Step 3: Require the new hit contract and build complete snapshot hits**

Add these required fields to `RetrievalHit` in `src/core/types.ts` immediately after `scoreFinal`:

```ts
  scoreBreakdown: RetrievalScoreBreakdown;
  citation: RetrievalCitation;
```

Add `RetrievalHit` to the type imports in `src/core/retrieval-explanation.ts`, then add:

```ts
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
```

Extend the Task 1 helper import in `src/core/retrieval.ts`:

```ts
import {
  buildRetrievalCitation,
  buildRetrievalScoreBreakdown,
  calculateHybridScore,
  compareRetrievalHits,
} from "./retrieval-explanation.js";
export { calculateHybridScore };
```

In `buildSnapshotHit`, calculate authority and recency once, build the breakdown, and return:

```ts
const authority = authorityWeightForScope(hitScope, artifact?.authority);
const recency = recencyWeight(artifact?.updatedAt);
const scoreBreakdown = buildRetrievalScoreBreakdown({
  mode: "hybrid",
  scoreVector,
  scoreKeyword,
  alpha,
  authority,
  recency,
});
const sourceType = artifactEntry
  ? hitScope === "evidence" ? "evidence" : "artifact"
  : "document";
const citation = buildRetrievalCitation({
  sourceType,
  sourceId: chunk.id,
  sourceVersion: chunk.documentVersionId,
  sourceSha: chunk.commitSha,
});

return {
  chunkId: chunk.id,
  path: chunk.path,
  sectionTitle: chunk.sectionTitle,
  scoreVector,
  scoreKeyword,
  scoreFinal: scoreBreakdown.final,
  scoreBreakdown,
  citation,
  text: chunk.text,
  scope: hitScope,
  originType: artifactEntry ? "artifact" : "document",
  artifactId: artifactEntry?.artifactId ?? null,
  artifactKind: artifactEntry?.kind ?? null,
  authority: artifact?.authority ?? (hitScope === "durable" ? "promoted_durable" : null),
  confidence: artifact?.confidence ?? null,
};
```

Do not use artifact provenance for a snapshot-store chunk. Its indexed chunk ID, document version, and commit SHA are the exact versioned source.

- [ ] **Step 4: Build complete explicit artifact and evidence hits**

Add `evidenceId: string | null` to `ArtifactCandidate`. Populate each constructor with:

```ts
// buildExplicitArtifactCandidates evidence branch
evidenceId: evidence.evidenceId,

// buildExplicitArtifactCandidates artifact body and buildRecallArtifactCandidates
evidenceId: null,
```

Add this local helper in `src/core/retrieval.ts`:

```ts
const sourceShaForArtifact = (artifact: ArtifactRecord): string | null =>
  artifact.boundHeadSha ?? artifact.sourceHeadSha ?? artifact.captureHeadSha;
```

In `buildArtifactHits`, replace the current retrieval/final-score calculation with:

```ts
const scoreBreakdown = buildRetrievalScoreBreakdown({
  mode: canEmbedCandidates ? "hybrid" : "keyword",
  scoreVector: semantic,
  scoreKeyword: keyword,
  alpha,
  authority: authorityWeightForArtifact(candidate.artifact, candidate.scopeValue),
  recency: recencyWeight(candidate.artifact.updatedAt),
});
const citation = buildRetrievalCitation({
  sourceType: candidate.evidenceId ? "evidence" : "artifact",
  sourceId: candidate.evidenceId
    ? `${candidate.artifact.artifactId}:${candidate.evidenceId}`
    : candidate.artifact.artifactId,
  sourceVersion: candidate.artifact.provenance.contentHash,
  sourceSha: sourceShaForArtifact(candidate.artifact),
});
```

Return `scoreFinal: scoreBreakdown.final`, `scoreBreakdown`, and `citation`. The mode condition must use `canEmbedCandidates`, not merely `semanticContext !== null`.

- [ ] **Step 5: Make deduplication and final ordering deterministic**

Replace the winner and sort conditions in `finalizeHits` with the shared comparator:

```ts
const existing = deduped.get(key);
if (!existing || compareRetrievalHits(hit, existing) < 0) {
  deduped.set(key, hit);
}

return Array.from(deduped.values())
  .sort(compareRetrievalHits)
  .slice(0, topK);
```

Keep `retrievalIdentity` unchanged. Do not introduce approximate equality.

- [ ] **Step 6: Align the public artifact search API**

In `src/core/artifacts.ts`, import `buildRetrievalCitation`, `buildRetrievalScoreBreakdown`, and `compareRetrievalHits`. Add `evidenceId: string | null` to the local candidate type and carry these exact values through `baseTexts` and `candidatesToEmbed`:

```ts
// evidenceRefs.map
evidenceId: item.evidenceId,

// artifact body
evidenceId: null,

// candidatesToEmbed.push
evidenceId: candidate.evidenceId,
```

Replace its inline hybrid/final calculation with:

```ts
const scoreBreakdown = buildRetrievalScoreBreakdown({
  mode: canEmbedCandidates ? "hybrid" : "keyword",
  scoreVector: semantic,
  scoreKeyword: keyword,
  alpha: config.retrieval.alpha,
  authority: authorityWeight(candidate.artifact),
  recency: recencyWeight(candidate.artifact.updatedAt),
});
const citation = buildRetrievalCitation({
  sourceType: candidate.evidenceId ? "evidence" : "artifact",
  sourceId: candidate.evidenceId
    ? `${candidate.artifact.artifactId}:${candidate.evidenceId}`
    : candidate.artifact.artifactId,
  sourceVersion: candidate.artifact.provenance.contentHash,
  sourceSha:
    candidate.artifact.boundHeadSha ??
    candidate.artifact.sourceHeadSha ??
    candidate.artifact.captureHeadSha,
});
```

Return the required fields and sort with `compareRetrievalHits`. Preserve the existing keyword matcher in this legacy API; the scope here is score composition, not query-token behavior.

- [ ] **Step 7: Run retrieval and regression gates**

Run:

```bash
pnpm exec vitest run test/retrieval-explanation.test.ts test/retrieval.test.ts test/embedding-execution.integration.test.ts test/memory.test.ts test/artifacts.integration.test.ts test/query.integration.test.ts test/retrieval-selection.integration.test.ts
pnpm build
pnpm benchmark:retrieval:verify
git diff --check
```

Expected: focused tests and build PASS; every hit has required fields; the benchmark passes unchanged thresholds. Inspect benchmark case rankings: any changed order must be confined to exact-score ties.

- [ ] **Step 8: Commit Task 2**

```bash
git add src/core/types.ts src/core/retrieval-explanation.ts src/core/retrieval.ts src/core/artifacts.ts test/retrieval-explanation.test.ts test/embedding-execution.integration.test.ts test/memory.test.ts test/retrieval.test.ts
git commit -m "feat(retrieval): explain deterministic hit ranking"
```

### Task 3: Query CLI and output projection

**Files:**
- Create: `test/output.test.ts`
- Modify: `src/core/output.ts`
- Modify: `src/core/commandInputs.ts`
- Modify: `src/cli.ts`
- Modify: `src/core/commandRegistry.ts`
- Modify: `src/core/memory.ts`
- Modify: `test/cli.contract.test.ts`

**Interfaces:**
- Produces: `QueryCommandInput.explain?: boolean`
- Produces: optional `explain = false` parameters on query output helpers.
- Produces: `RenderedRetrievalHit.citation` and optional `scoreBreakdown`.
- Preserves: current minimal/default/full behavior for text, excerpt, vector score, keyword score, and artifact metadata.

- [ ] **Step 1: Write failing output and input-normalization tests**

Create `test/output.test.ts`. Build one `RetrievalHit` with Task 1 helpers and assert:

```ts
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
```

- [ ] **Step 2: Run output tests and confirm contract failures**

Run:

```bash
pnpm exec vitest run test/output.test.ts
```

Expected: FAIL because the output helpers lack the explanation parameter and command input rejects `explain` as an unknown key.

- [ ] **Step 3: Implement rounded additive output**

In `src/core/output.ts`, add required `citation` and optional `scoreBreakdown` to `RenderedRetrievalHit`. Add a local recursive explicit projector rather than serializing and parsing:

```ts
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
```

Change the helper signatures to:

```ts
projectRetrievalHit(hit, view, explain = false)
projectRetrievalHits(hits, view, explain = false)
renderRetrievalHitLines(hits, view, explain = false)
formatQueryResultText(query, result, view, explain = false)
```

Always put `citation: hit.citation` in the base projection. Put `scoreBreakdown: explain ? projectScoreBreakdown(hit.scoreBreakdown) : undefined` in the base projection. Keep current view branches unchanged otherwise.

Render the first line as:

```ts
`${index + 1}. [${rendered.citation.id}] \`${rendered.path}\` · ${rendered.sectionTitle} · score=${rendered.scoreFinal.toFixed(4)}`
```

When `rendered.scoreBreakdown` exists, append one compact line built from the projected values:

```text
   - explanation: mode=hybrid retrieval=0.6200×0.8000→0.4960 vector=0.8000×0.7000→0.5600 keyword=0.2000×0.3000→0.0600 authority=0.9000×0.1500→0.1350 recency=0.6000×0.0500→0.0300 final=0.6610
```

Add `- explain: ${explain}` to the query text header and pass `explain` to `renderRetrievalHitLines`.

- [ ] **Step 4: Add the CLI and raw-JSON flag**

In `src/core/commandInputs.ts`:

```ts
export interface QueryCommandInput {
  question: string;
  topK?: number;
  at?: string;
  scope?: RetrievalScope;
  explain?: boolean;
}
```

Allow the exact key and normalize it:

```ts
assertAllowedKeys(raw, ["question", "topK", "at", "scope", "explain"], "query");
// returned object
explain: asOptionalBoolean(raw.explain, "query.explain"),
```

In `src/cli.ts`, add:

```ts
.option("--explain", "점수 구성과 기여도를 출력")
```

Include `options.explain` in the query mixed-input guard. Add `explain: Boolean(options.explain)` to positional input. After normalization, use:

```ts
const explain = input.explain ?? false;
```

Add `explain` to the result data object, call `projectRetrievalHits(result.hits, view, explain)`, and call `formatQueryResultText(..., view, explain)`. Do not pass `explain` to `searchKnowledge`.

In `src/core/commandRegistry.ts`, add the boolean option, `explain` and citation/breakdown fields to `outputSchemaSummary`, and an example:

```ts
'ragit query "restore auth context" --explain --format json'
```

- [ ] **Step 5: Preserve citations in memory-recall text**

In `src/core/memory.ts`, change only the retrieved-hit heading line:

```ts
`${index + 1}. [${hit.citation.id}] \`${hit.path}\` · ${hit.sectionTitle} · score=${hit.scoreFinal.toFixed(4)}`,
```

The caller keeps `explain = false`, so memory output gains citation identity without score internals.

- [ ] **Step 6: Extend the CLI contract test**

In `test/cli.contract.test.ts`, write query input with `explain: true`, then assert:

```ts
expect(queryOutput.data.explain).toBe(true);
expect(queryOutput.data.hits[0].citation.id).toMatch(/^cite-[a-f0-9]{24}$/);
expect(queryOutput.data.hits[0].scoreBreakdown.mode).toMatch(/^(hybrid|keyword)$/);
```

Add a positional JSON call with `--explain` and assert its breakdown exists. Add a default call without the flag and assert `data.explain === false` and `scoreBreakdown` is absent. Extend `describe query` assertions so `--explain` and `hits[].citation` are advertised.

- [ ] **Step 7: Run output, CLI, memory, and snapshot contract tests**

Run:

```bash
pnpm exec vitest run test/output.test.ts test/cli.contract.test.ts test/cli-hardening.test.ts test/cli.snapshot-contract.test.ts test/memory.test.ts test/query.integration.test.ts
pnpm build
pnpm build:verify
git diff --check
```

Expected: all pass. Default query output contains citation but no breakdown. Explained output contains both. Snapshot metadata and exit behavior are unchanged.

- [ ] **Step 8: Commit Task 3**

```bash
git add test/output.test.ts src/core/output.ts src/core/commandInputs.ts src/cli.ts src/core/commandRegistry.ts src/core/memory.ts test/cli.contract.test.ts
git commit -m "feat(query): add citation and explain output"
```

### Task 4: Documentation and complete verification

**Files:**
- Modify: `README.md`
- Modify: `apps/docs/content/docs/en/commands/query.mdx`
- Modify: `apps/docs/content/docs/ko/commands/query.mdx`

**Interfaces:**
- Documents: the same option, raw JSON key, base citation contract, opt-in breakdown contract, exact weights, fallback semantics, and snapshot boundary in both languages.
- Preserves: explicit development-only labeling for the placeholder benchmark.

- [ ] **Step 1: Update README retrieval guidance**

Replace the incomplete final-score statement with the exact two-stage formula:

```text
- Retrieval subtotal in hybrid mode: `alpha * vector + (1-alpha) * keyword` (default `alpha=0.7`)
- Artifact/evidence fallback without candidate embeddings: `1.0 * keyword`
- Final score: `0.80 * retrieval + 0.15 * authority + 0.05 * recency`
- Exact score ties: deterministic repository path, section, citation, then chunk ordering
- Every hit includes a version-aware citation; `query --explain` adds the score breakdown without changing ranking
```

Add a short example:

```bash
pnpm ragit query "restore auth context" --explain --view minimal --format json
```

Keep the benchmark paragraph explicit that placeholder evidence is regression-only.

- [ ] **Step 2: Update English query documentation**

In `apps/docs/content/docs/en/commands/query.mdx`:

- add `[--explain]` to syntax;
- describe `--explain` independently of `--view`;
- add `explain` to the raw JSON example;
- state every hit has `citation: { id, sourceType, sourceId, sourceVersion, sourceSha }`;
- state `scoreBreakdown` is present only when requested;
- document hybrid, keyword fallback, and final weights exactly;
- state `--input` cannot be mixed with `--explain`; use JSON `explain` instead;
- include one explained command example.

- [ ] **Step 3: Update Korean documentation in parity**

Make the same factual edits in `apps/docs/content/docs/ko/commands/query.mdx`, retaining natural Korean prose and identical commands, field names, formulas, and cautions.

- [ ] **Step 4: Run documentation checks**

Run:

```bash
pnpm docs:check:commands
pnpm docs:check:internal-links
pnpm docs:check:i18n
pnpm docs:check:search-index
pnpm docs:build
```

Expected: all command metadata, links, language parity, search index, and static build checks pass.

- [ ] **Step 5: Commit Task 4**

```bash
git add README.md apps/docs/content/docs/en/commands/query.mdx apps/docs/content/docs/ko/commands/query.mdx
git commit -m "docs(query): document citations and explanations"
```

- [ ] **Step 6: Run the independent B2 release gate**

Run on an otherwise idle host so the opt-in latency gate is meaningful:

```bash
pnpm benchmark:retrieval:verify
pnpm test
pnpm build
pnpm build:verify
pnpm pack:verify
pnpm pack:smoke
git diff --check origin/main...HEAD
git status --short
```

Expected:

- benchmark quality, noise, and p95 thresholds pass;
- all tests and build/package contracts pass;
- no threshold, package version, provider profile, Context Pack selector, or MCP file changed;
- only the plan's declared source, test, and documentation files differ from `origin/main`;
- the worktree is clean after the documentation commit.

If a benchmark run fails only p95 while all quality values pass, rerun once on an idle host, record both p95 values in the PR, and do not raise the committed threshold in B2.

## Sol Max Review and Integration Gate

- [ ] Review each Terra commit against its corresponding task before cherry-picking.
- [ ] Reject changes to weights, benchmark thresholds, Context Pack selection, providers, MCP, package version, or unrelated formatting.
- [ ] Confirm required fields were not weakened to optional to avoid constructor updates.
- [ ] Confirm no ranking code reads the CLI `explain` value.
- [ ] Confirm blocked artifact candidate embeddings use keyword weight `1` and no remote call.
- [ ] Confirm citation IDs contain no query, rank, source text, absolute path, or time input.
- [ ] Confirm same-source citations are stable and version/evidence changes change the ID.
- [ ] Confirm tie sorting and dedupe winner selection share the same comparator.
- [ ] Independently run Task 4 Step 6 in the parent worktree.
- [ ] Create a focused PR whose body reports benchmark metrics, any exact-tie order changes, test/build/docs gates, and the Sol/Terra responsibility split.
- [ ] Merge only after CI and required review are green; delete the remote feature branch after merge.

## Remaining Practical-Readiness Sequence

This plan intentionally ends at a working, independently releasable B2 increment. The remaining subsystems require their own approved designs and executable plans:

1. **B3 — Context Pack v2:** diversity-aware, budget-aware selection that consumes B2 citation identity; verify relevance, source diversity, deterministic packing, and token-budget invariants.
2. **B4 — Production embedding profiles:** explicit Ollama and OpenAI profiles, provider-labeled benchmark evidence, cache/contract migration checks, timeout/retry behavior, and no placeholder production claim.
3. **C — Distribution matrix:** supported Node/OS/architecture and zvec native-package install, pack, upgrade, and installed-CLI E2E gates.
4. **D — Read-only MCP projection:** expose query/context/status through bounded read-only tools after the CLI contracts are stable; prove no write path or cache mutation is reachable.
5. **Final release gate:** run the full practical-readiness matrix, update the version and release notes in a separate release PR, exercise npm trusted-publishing rehearsal, publish only after all workstreams pass, and verify the registry tarball from a clean install.

Do not combine these into the B2 PR. Sol Max opens each design gate in order; Terra implements only the approved plan for that gate.
