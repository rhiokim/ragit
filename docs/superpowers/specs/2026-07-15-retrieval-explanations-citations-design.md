---
status: approved
date: 2026-07-15
scope: retrieval-explanations-citations
---

# Retrieval Explanations and Citations Design

## Summary

RAGit retrieval results currently expose a final score but do not identify a stable source or explain how the score was produced. This design adds a deterministic citation to every retrieval hit and an opt-in `ragit query --explain` score breakdown. It also makes tie ordering deterministic and corrects the existing artifact keyword fallback so its implementation matches its warning.

This is B2 of the approved retrieval-readiness workstream. B1 supplied the versioned regression benchmark. B3 will redesign Context Pack selection, and B4 will add explicit production embedding profiles. Those later changes are outside this design.

## Product Contract

> Every retrieval hit identifies the exact source version it came from. `--explain` reveals the score calculation without changing candidate selection, ranking, or source identity.

## Goals

- Attach a deterministic, version-aware citation to every `RetrievalHit`.
- Preserve citations in minimal, default, and full JSON views and in text output.
- Add `--explain` and JSON input `explain: boolean` to `ragit query`.
- Show vector, keyword, authority, and recency inputs and contributions when explanation is requested.
- Use one score-calculation contract for snapshot and artifact retrieval paths.
- Correct keyword fallback when artifact or evidence embeddings are disallowed.
- Define deterministic ordering for exact score ties and duplicate winners.
- Keep the B1 benchmark as the ranking-regression gate.

## Non-goals

- Tuning `retrieval.alpha` or the final `0.8 / 0.15 / 0.05` weights.
- Optimizing against the synthetic placeholder benchmark.
- Changing snapshot selection, candidate limits, token budgeting, or Context Pack selection.
- Adding a separate `query explain` command or a citation persistence database.
- Adding line ranges that the current chunk model cannot prove.
- Claiming production retrieval quality from the placeholder profile.

## Considered Approaches

### Put explanations in `--view full`

This avoids a new flag, but it conflates content verbosity with ranking rationale. A caller may need a compact excerpt and a score explanation, or full source text without ranking internals. The two concerns should remain independent.

### Add a separate `query explain` command

This creates a clean conceptual endpoint, but duplicates query parsing, snapshot selection, output projection, documentation, and contract tests. It is disproportionate for a read-only projection of the same result.

### Cite every hit and gate only the detailed breakdown behind `--explain`

This is the selected approach. Citation is source identity and therefore part of the base hit contract. Explanation is optional presentation data. The change is additive for existing JSON consumers and does not create a second retrieval path.

## Core Types

`RetrievalHit` gains two required properties:

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

The core keeps full JavaScript number precision. Output projection rounds numeric explanation fields to six decimal places, matching the existing score projection convention.

## Score Calculation

`src/core/retrieval-explanation.ts` owns a pure `buildRetrievalScoreBreakdown` helper. It receives `mode`, `scoreVector`, `scoreKeyword`, `alpha`, `authority`, and `recency`.

For `hybrid` mode:

```text
vector input contribution  = alpha × scoreVector
keyword input contribution = (1 - alpha) × scoreKeyword
retrieval score             = vector input contribution + keyword input contribution
```

For `keyword` mode:

```text
vector input contribution  = 0
keyword input contribution = 1 × scoreKeyword
retrieval score             = scoreKeyword
```

Both modes use the existing final formula:

```text
retrieval contribution = 0.80 × retrieval score
authority contribution = 0.15 × authority score
recency contribution   = 0.05 × recency score
final                  = retrieval contribution + authority contribution + recency contribution
```

`scoreFinal` is assigned from `breakdown.final`; it is not recalculated separately. Snapshot hits always use `hybrid`. Artifact and evidence hits use `hybrid` only when candidate embeddings were actually computed. If no semantic context exists or security policy blocks candidate embeddings, they use `keyword` with weight `1`. The existing warning about keyword fallback therefore becomes true in implementation as well as text.

The current `retrieval.alpha` and final weights do not change. B1 is a non-regression gate, not a tuning target.

## Citation Identity

`src/core/retrieval-explanation.ts` also owns pure `buildRetrievalCitation`. Citation IDs use:

```text
cite- + first 24 hexadecimal characters of
SHA-256(sourceType + NUL + sourceId + NUL + sourceVersion)
```

The query, rank, score, wall-clock time, and output view are never inputs. Source mapping is:

| Hit source | `sourceType` | `sourceId` | `sourceVersion` | `sourceSha` |
| --- | --- | --- | --- | --- |
| Snapshot document chunk | `document` | chunk ID | document version ID | chunk commit SHA |
| Snapshot artifact/evidence chunk | `artifact` or `evidence` from its indexed scope | chunk ID | document version ID | chunk commit SHA |
| Explicit artifact body | `artifact` | artifact ID | provenance content hash | bound, source, or capture SHA |
| Explicit artifact evidence | `evidence` | `<artifactId>:<evidenceId>` | provenance content hash | bound, source, or capture SHA |

`sourceSha` may be `null` for an unbound working-memory artifact; the citation is still stable because artifact identity and provenance version are present. Citation IDs do not hash raw query text, source text, path text, or section titles.

The query result's top-level `snapshotSha` remains the authoritative snapshot selection. A citation identifies the returned source version inside that selection or artifact layer.

## Deterministic Ordering

Final hit ordering uses these comparisons in order:

1. `scoreFinal`, descending;
2. repository-relative `path`, ascending by direct code-point comparison;
3. `sectionTitle`, ascending by direct code-point comparison;
4. `citation.id`, ascending;
5. `chunkId`, ascending.

No epsilon is used: only exactly equal numeric scores enter the tie breaker. The same comparator selects a winner when two hits share a retrieval identity, so deduplication does not depend on insertion order. `localeCompare` is not used because its result can vary by runtime locale.

## CLI and Output Contract

`ragit query` gains:

```text
--explain   include score contribution details
```

Raw JSON input accepts only a boolean:

```json
{
  "question": "restore auth context",
  "topK": 5,
  "scope": "durable",
  "explain": true
}
```

As with other domain options, `--explain` cannot be combined with `--input`; the JSON document must carry `explain` in that form. Output-only flags such as `--format` and `--view` remain legal with `--input`.

Every projected hit includes `citation` in minimal, default, and full views. Existing fields keep their current view behavior. `scoreBreakdown` appears only when `explain` is true. The result envelope and text header include `explain: true|false` so callers can distinguish an omitted breakdown from unavailable data.

Text hits begin with their citation:

```text
1. [cite-0123456789abcdef01234567] `docs/auth.md` · Refresh Flow · score=0.8123
```

When explanation is requested, a second indented line shows the mode, retrieval subtotal, vector and keyword weights/contributions, authority contribution, recency contribution, and final score. It does not dump the internal object as unformatted JSON.

`projectRetrievalHit`, `projectRetrievalHits`, `renderRetrievalHitLines`, and `formatQueryResultText` receive an optional `explain = false` argument. Context Pack and memory callers keep the default; they gain citations but do not gain score breakdowns. This keeps explanation opt-in while allowing every downstream retrieval surface to preserve source identity.

## Data Flow

1. Snapshot or artifact candidate data is loaded and sanitized as it is today.
2. The retrieval path determines whether candidate embeddings actually exist.
3. `buildRetrievalScoreBreakdown` returns the only final-score calculation.
4. `buildRetrievalCitation` returns stable source identity and version metadata.
5. The hit is deduplicated and sorted with the deterministic comparator.
6. Structured sanitization runs over the completed hit.
7. Output projection always keeps citation and conditionally keeps score breakdown.

`--explain` is intentionally absent from steps 1 through 6. It cannot affect retrieval behavior.

## Error Handling and Security

- JSON `explain` values other than boolean fail input normalization.
- `--input` plus `--explain` fails the existing mixed-input guard.
- Citation construction does not fail when `sourceSha` is null.
- Citations do not contain source text, query text, absolute paths, or secrets.
- Existing structured sanitization still covers every returned hit.
- Remote-embedding policy remains authoritative. Explanation reports the fallback mode; it never bypasses policy.
- A warning is emitted when a semantic query context exists but artifact/evidence candidate embeddings are blocked and keyword fallback is used.

## Components and Files

- Create `src/core/retrieval-explanation.ts` for pure score and citation builders.
- Modify `src/core/types.ts` for required citation and breakdown contracts.
- Modify `src/core/retrieval.ts` to use the builders, correct fallback, and stabilize ordering.
- Modify `src/core/artifacts.ts` so its public artifact search returns the same required hit contract.
- Modify `src/core/output.ts` for additive citation and opt-in explanation projection.
- Modify `src/core/commandInputs.ts`, `src/cli.ts`, and `src/core/commandRegistry.ts` for the CLI contract.
- Add focused unit tests and extend retrieval, memory, artifact, and CLI contract tests.
- Update `README.md` and both `apps/docs/content/docs/en/commands/query.mdx` and `apps/docs/content/docs/ko/commands/query.mdx`.

## Verification

- Pure tests hand-calculate hybrid and keyword-only contributions and prove that `final` is the sum of top-level contributions.
- Citation tests prove identical source identity yields the same ID and that source-version or evidence-ID changes yield a different ID.
- Sorting tests prove exact ties have the same order regardless of input order.
- Artifact integration proves a policy-blocked candidate uses keyword weight `1`, reports `mode: "keyword"`, and performs no prohibited remote embedding call.
- CLI contract tests prove citation exists in all views, breakdown is absent by default, and `--explain` or JSON `explain: true` includes it.
- Text tests prove citation and the compact contribution line are rendered.
- Exact snapshot, redaction, and security-policy tests remain green.
- `pnpm benchmark:retrieval:verify` passes without changing thresholds. Ranking differences are allowed only for exact-score ties and must remain above all committed quality floors.
- Focused tests, the full suite, build, build contract, documentation checks, and `git diff --check` pass.

## Execution Ownership

Sol Max owns this approved design, implementation-plan fidelity, code review, benchmark interpretation, and merge decision. Terra is the implementation worker. Terra may implement only the files and contracts named by the plan, must use test-first task boundaries, and must not tune weights, expand B3/B4 scope, push, merge, publish, or revise the design without returning the decision to Sol Max.

This division uses Terra for bounded code production while preserving the stronger planning and verification context in Sol Max.

## Follow-up Boundary

B3 may consume citations and score explanations when selecting a more diverse Context Pack, but B2 does not alter context budgeting. B4 supplies Ollama/OpenAI quality evidence; B2 does not add or tune providers. Packaging and MCP changes remain later roadmap items.
