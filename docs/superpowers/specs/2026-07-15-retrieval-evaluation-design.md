---
status: approved
date: 2026-07-15
scope: retrieval-quality-evaluation
---

# Retrieval Quality Evaluation Design

## Summary

RAGit needs a reproducible way to measure whether retrieval changes improve or regress useful results. This design adds a versioned benchmark corpus, pure ranking metrics, a provider-labeled end-to-end runner, and machine-readable regression thresholds. It does not change production ranking behavior.

This is the first subproject in the approved Retrieval Quality and Evaluation workstream. Later subprojects add score explanations and citations, Context Pack v2 selection, and explicit production embedding profiles.

## Product Contract

> A retrieval-quality claim must identify the corpus, provider profile, metric definition, and measured result. Development-only placeholder embeddings can detect regressions, but cannot support a production-readiness claim.

## Goals

- Commit a versioned benchmark with at least 3 independent fixture repositories and 100 queries.
- Include English, Korean, and mixed noisy queries for every repository.
- Compute Recall@K, MRR@K, nDCG@K, paired noise sensitivity, and latency p50/p95.
- Report aggregate, repository, and language slices in stable JSON.
- Validate that every relevance judgment points to an existing benchmark document.
- Label the active embedding provider and mark placeholder results as development-only.
- Support a deterministic local regression gate without network access.

## Non-goals

- Changing keyword, vector, hybrid, authority, or recency ranking behavior.
- Claiming that a synthetic fixture benchmark predicts every real repository.
- Calling OpenAI or requiring Ollama in the default test suite.
- Adding a user-facing `ragit benchmark` command.
- Adding Context Pack diversity, query explanations, or MCP support.

## Considered Approaches

### External repositories only

This gives realistic documents but is not a stable release gate. Upstream changes, network availability, licenses, and query-label drift make identical reruns difficult.

### Fully expanded static cases

This makes every query explicit but repeats repository and relevance data across more than 100 records. The duplication makes review and maintenance error-prone.

### Versioned topic catalog materialized into fixture repositories

This is the selected approach. Three repository definitions contain documents and 36 total topics. Every topic declares an English query, a Korean query, and a mixed noisy query, yielding 108 explicit evaluation cases without repeating relevance judgments. The runner materializes each repository in a temporary directory, initializes and ingests it through production APIs, then queries the exact snapshot.

## Dataset Contract

The dataset lives at `benchmarks/retrieval/v1/dataset.json` and has `schemaVersion: 1` plus a stable dataset ID. It contains exactly three repository records. Each repository contains:

- a stable repository ID and description;
- at least twelve Markdown documents with unique repository-relative paths;
- at least twelve topics;
- for each topic, `en`, `ko`, and `mixed-noisy` query strings;
- one or more graded relevance judgments keyed by document path, with integer gain from 1 through 3.

The loader rejects duplicate IDs or paths, missing query variants, empty documents, invalid gains, fewer than three repositories, fewer than 100 expanded cases, and relevance paths that do not exist in the same repository.

The corpus is intentionally synthetic and reviewable. Documents use paraphrases and overlapping vocabulary rather than embedding the exact query string verbatim in every relevant document. Some topics include a secondary relevant document at lower gain so nDCG measures ordering, not only hit presence.

## Evaluation Flow

For each repository, the runner:

1. creates a temporary Git repository;
2. writes and commits the fixture documents;
3. runs quiet non-interactive RAGit initialization;
4. commits the generated control-plane files;
5. runs full durable ingest at the resulting HEAD;
6. executes all expanded queries with `topK = 10` against that exact snapshot;
7. maps returned hits to relevance judgments by repository-relative path;
8. records query-only latency, rankings, and per-case metrics;
9. removes the temporary repository even when evaluation fails.

The default runner uses the existing local placeholder profile so it remains offline and deterministic. The report records provider, model, dimensions, and embedding contract. If the provider is `local-placeholder`, `developmentOnly` is `true` and the report must state that the numbers are regression evidence only.

The runner writes one JSON object to stdout. An optional output path may persist the same bytes, but no report file is created by default.

## Metric Definitions

- **Recall@K:** relevant documents retrieved in the first K unique paths divided by all judged relevant documents.
- **MRR@K:** reciprocal rank of the first relevant path within K, or zero when no relevant path appears.
- **nDCG@K:** DCG with gain `2^relevance - 1`, divided by the ideal ordering at K.
- **Noise sensitivity:** aggregate nDCG@10 for the mixed-noisy variant compared with the mean of its paired English and Korean clean variants. The report includes clean mean, noisy mean, absolute drop, and relative drop.
- **Latency:** wall-clock time around `searchKnowledge` only. The report includes p50, p95, and maximum using nearest-rank percentiles.

Aggregate metrics are macro averages across cases. The same definitions are reported for each repository and language variant. Stable case ordering is repository ID, topic ID, then `en`, `ko`, `mixed-noisy`.

These definitions follow standard information-retrieval practice represented by [BEIR](https://arxiv.org/abs/2104.08663) and [NIST trec_eval](https://trec.nist.gov/trec_eval/). The explicit noisy-query slice follows the robustness concern evaluated by the [RGB benchmark](https://doi.org/10.1609/AAAI.V38I16.29728).

## Regression Thresholds

`benchmarks/retrieval/v1/thresholds.json` contains explicit minimum Recall@5, MRR@10, and nDCG@10 values, a maximum relative noise drop, and a maximum p95 latency.

The first committed values are derived from the independently rerun placeholder baseline:

- quality floors use no more than a 10% relative margin below the lower successful baseline run;
- the noise ceiling uses no more than 0.05 absolute margin above the higher successful baseline run;
- the latency ceiling is the greater of 250 ms or 1.5 times the higher successful p95.

Threshold values must be finite and bounded to valid metric ranges. `--verify` exits nonzero and reports every violated threshold. Because the profile is development-only, these floors prevent deterministic regressions but do not constitute a release claim for Ollama or OpenAI.

## Components

### Dataset loader

A small module validates the JSON and expands each topic into three typed cases. It has no Git, zvec, or provider dependency.

### Pure metric module

Pure functions compute per-case metrics, percentiles, slices, noise pairs, and threshold violations. Unit tests use hand-calculated rankings, including zero-hit, duplicate-path, graded-relevance, and empty-latency edge cases.

### End-to-end runner

`scripts/benchmark-retrieval.ts` owns argument parsing, temporary repository lifecycle, production API calls, and stable JSON output. It does not duplicate retrieval logic.

### Package scripts

- `pnpm benchmark:retrieval` runs the benchmark and prints the report.
- `pnpm benchmark:retrieval:verify` runs the same benchmark and enforces the committed thresholds.

The benchmark is not added to `pnpm test` or `release:check` in this subproject. Final release-gate work decides where provider-specific evidence runs in CI.

## Error Handling

- Dataset and threshold validation failures stop before materializing repositories.
- Repository setup, ingest, or query failures identify the repository and case ID and exit nonzero.
- Temporary repositories are always removed.
- A missing relevance path is a dataset error, never a zero metric.
- Non-finite metrics, latency, or threshold values are rejected.
- stdout remains a single JSON report on success; progress and failure diagnostics use stderr.

## Verification

- Unit tests prove metric formulas, duplicate-path handling, nearest-rank percentiles, slices, noise pairing, validation, and threshold decisions.
- The complete dataset expands to exactly 108 cases across three repositories, with 36 cases in each language variant.
- Two complete benchmark runs produce identical rankings and quality metrics under the placeholder profile. Latency may differ but both runs must satisfy its ceiling.
- `pnpm benchmark:retrieval:verify`, focused tests, `pnpm test`, `pnpm build`, `pnpm build:verify`, and `git diff --check` pass.
- Production retrieval source files remain unchanged in B1.

## Follow-up Boundary

B2 may use this benchmark to justify ranking changes and adds score contributions plus citations. B3 adds Context Pack v2 selection. B4 adds explicit Ollama/OpenAI profiles and provider-specific evidence. None of those changes are part of this design.
