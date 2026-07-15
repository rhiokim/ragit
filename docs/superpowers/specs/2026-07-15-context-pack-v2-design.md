# Context Pack v2 Design

**Status:** Approved
**Workstream:** B3
**Owner:** Sol Max
**Implementation worker:** Terra
**Date:** 2026-07-15

## Purpose

The current Context Pack selector walks retrieval hits in score order and keeps fitting entries, except that it always includes the first hit even when that hit exceeds the requested budget. It can also spend most of the packet on repeated chunks from one source.

B3 makes packing strict, deterministic, citation-aware, and source-diverse without changing retrieval itself.

## Goals

- Preserve the highest-ranked useful evidence while increasing source coverage.
- Remove exact duplicate citations before budgeting.
- Keep `usedTokens <= budget` for every successful result.
- Make the same input produce the same hit order and telemetry.
- Expose enough additive metadata to audit the selector.
- Preserve all B1/B2 snapshot, ranking, citation, masking, scope, and output-view contracts.

## Non-goals

- No MMR, learned reranker, dynamic weights, or query-dependent tuning.
- No changes to retrieval weights, candidate count, score breakdowns, or benchmark thresholds.
- No partial-hit truncation or excerpt rewriting.
- No model-specific tokenizer dependency.
- No new CLI flag.
- No Context Pack degradation when the exact snapshot/store is unavailable.
- No memory recall, embedding provider, distribution, MCP, package-version, or release changes.

## Public Contract

The existing top-level fields remain:

- `goal`
- `snapshotSha`
- `snapshot`
- `budget`
- `usedTokens`
- `selectedHits`
- `hits`
- `warnings`
- `redactionSummary`

B3 adds:

```ts
interface ContextPackSelectionSummary {
  strategy: "citation-diverse-v2";
  candidateHits: number;
  uniqueCitations: number;
  selectedSources: number;
  duplicateCitationsSkipped: number;
  budgetRejectedHits: number;
}
```

The summary is present in JSON and projected as stable text header lines. It is additive.

## Budget Semantics

`budget` remains the maximum number of deterministic whitespace-delimited content units across selected full hit texts. It does not claim to count serialized metadata or a provider-specific LLM tokenizer.

Rules:

- The default remains `1200`.
- CLI and raw JSON budgets must be positive safe integers.
- A hit is indivisible.
- A hit whose content cost exceeds the remaining budget is skipped.
- The old first-hit overflow exception is removed.
- If retrieval produced candidates but no complete hit fits, the packet contains zero hits and adds a warning that the budget admitted no complete hit.
- `usedTokens` is the exact sum of the selected hit costs and is always at most `budget`.

## Citation Deduplication

Candidates retain the incoming deterministic retrieval order.

For each `citation.id`, only the first candidate is eligible. Later candidates with the same citation ID are counted in `duplicateCitationsSkipped` and never consume budget.

No query, score, rank, time, or source text is used to construct a dedupe identity.

## Source Families

The selector derives a stable source-family key:

- document: `document:<repo-relative path>`
- artifact: `artifact:<artifactId>`, falling back to `citation.sourceId`
- evidence: `evidence:<artifactId>`, falling back to `citation.sourceId`

`citation.sourceType` is authoritative. Repository-relative document path is required because B2 document citations identify exact chunks, while B3 diversity must group sections from the same document. Artifact identity is preferred for both artifact bodies and evidence so multiple indexed chunks or evidence excerpts from one artifact cannot masquerade as independent sources.

## Selection Algorithm

Input is the already-ranked retrieval list. B3 does not sort or rescore it.

1. Deduplicate exact citation IDs, preserving first occurrence.
2. Diversity pass:
   - scan unique candidates in rank order;
   - if the source family is not yet selected and the complete hit fits, select it;
   - mark the source family only after a hit is selected.
3. Fill pass:
   - scan unique candidates again in rank order;
   - skip already selected citations;
   - select every complete hit that fits, even if its source family is already represented.
4. Return hits in selection order: diverse representatives first, then repeated-source fill.

This is intentionally greedy. It is explainable, deterministic, and small. It does not claim global knapsack optimality.

## Telemetry Semantics

- `candidateHits`: incoming retrieval hit count.
- `uniqueCitations`: candidates remaining after citation dedupe.
- `selectedSources`: distinct source families among selected hits.
- `duplicateCitationsSkipped`: incoming candidates removed by citation dedupe.
- `budgetRejectedHits`: unique citations not selected after both passes.

The invariant is:

```text
uniqueCitations = selectedHits + budgetRejectedHits
candidateHits = uniqueCitations + duplicateCitationsSkipped
```

## Compatibility

- Strict exact-snapshot selection is unchanged.
- `topK: 30` for Context Pack retrieval is unchanged.
- Retrieval scores and B1 benchmark rankings are unchanged.
- Citations remain present for every hit.
- Score breakdowns remain absent from Context Pack output.
- `--scope` behavior and artifact overlays are unchanged.
- Masking occurs before selection and again during projection as today.
- Minimal/default/full view behavior is unchanged.

## Verification

Unit tests must prove:

- same input returns deep-equal output;
- exact citation duplicates keep the first candidate;
- one candidate per source is preferred before repeated-source fill;
- a smaller lower-ranked candidate may be selected when a higher-ranked candidate does not fit;
- no first-hit overflow remains;
- document, artifact, and evidence source-family rules are stable;
- summary equations and `usedTokens <= budget` hold;
- no candidate mutation occurs.

CLI/integration tests must prove:

- positional and raw JSON budgets accept positive integers;
- fractional, zero, negative, NaN-like, and infinite inputs are rejected before retrieval;
- Context Pack JSON/text exposes selection telemetry and citations;
- score breakdowns are not exposed;
- strict snapshot and dirty-worktree behavior is unchanged.

Release gates must prove:

- focused tests pass;
- full suite passes;
- the B1 benchmark has identical aggregate quality, noise metrics, and all 108 ranked path arrays;
- build, package, installed CLI, and bilingual docs gates pass;
- package version, thresholds, providers, distribution, and MCP are untouched.

## Sol/Terra Boundary

Sol Max owns this design, reviews each commit, independently runs all gates, and decides merge. Terra implements only the approved selector, Context Pack integration, tests, and documentation. Any need to change ranking, tokenizer dependencies, truncation, providers, package version, or later workstreams returns to Sol Max.
