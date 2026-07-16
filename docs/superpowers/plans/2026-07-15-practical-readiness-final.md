# RAGit Practical Readiness — Final Implementation Plan

**Status:** Approved
**Design/review owner:** Sol Max
**Bounded implementation worker:** Terra
**Baseline:** `origin/main` at `89e25dd`, package `ragit@1.1.2`
**Date:** 2026-07-15

## Outcome

Move RAGit from a locally useful retrieval CLI to a release candidate whose retrieval quality, context packing, provider integrations, native-package distribution, read-only MCP projection, and npm release path are all backed by reproducible evidence.

This plan is sequential. Each workstream gets its own design, implementation plan, branch, pull request, independent verification, and merge. Package version changes and npm publication are reserved for the final release workstream.

## Fixed Operating Model

Sol Max owns:

- architecture and compatibility decisions;
- acceptance criteria and task boundaries;
- review of every Terra commit;
- benchmark and risk interpretation;
- independent verification in the parent worktree;
- push, PR, merge, versioning, and publication decisions.

Terra owns:

- test-first implementation of one approved task at a time;
- focused commits that match the named files and contracts;
- reporting exact commands and results;
- stopping when the plan is ambiguous or a boundary must change.

Terra must not tune retrieval weights, revise thresholds, widen provider or MCP scope, change package version, push, merge, or publish without returning the decision to Sol Max.

## Workstream Sequence

| Gate | Status | Deliverable | Exit condition |
| --- | --- | --- | --- |
| B1 | Complete | Versioned retrieval benchmark | Dataset, thresholds, noise pairs, latency gate, and repeatable local report |
| B2 | Complete | Citations and score explanations | PR #23 merged; citations stable; explanations opt-in; B1 rankings unchanged |
| B3 | Complete | Context Pack v2 | PR #24 merged; strict budget, deterministic citation dedupe, source diversity, additive selection telemetry |
| B4 | Complete | Production embedding evidence | Ollama `nomic-embed-text` passed live gates; OpenAI remains recognized but explicitly outside production support |
| C | Complete | Distribution matrix | Packed CLI installs and completes E2E on every declared Node/OS/architecture target |
| D | Complete | Read-only MCP projection | Query, context pack, and status are reachable over stdio with no write-capable path |
| E | Release ready | Release and registry verification | Release PR, trusted publish, clean registry install, provenance and smoke verification |

## B3 — Context Pack v2

### Scope

- Replace rank-only trimming with a deterministic two-pass selector.
- Deduplicate exact citations before packing.
- Prefer one fitting hit from each source family before adding repeated-source hits.
- Reject fractional or non-positive budgets.
- Never include a complete hit when it would make `usedTokens > budget`.
- Add an additive `selection` summary to JSON and text output.
- Preserve strict snapshot selection, retrieval order, score weights, candidate count, scopes, masking, citations, and default budget.

### Proof

- Focused selector tests cover relevance retention, source diversity, exact citation dedupe, deterministic order, oversized hits, and summary counts.
- CLI contract tests cover positional and raw JSON inputs, integer validation, citations, and selection telemetry.
- The B1 retrieval benchmark remains byte-for-byte identical in quality metrics and ranked path arrays.
- Full test, build, package, and bilingual documentation gates pass.

### Exit

A focused PR is merged with no changes to embedding providers, benchmark thresholds, package version, MCP, or native distribution.

## B4 — Production Embedding Profiles

### Current gap

The provider facade, batching, retry schedule, timeout, cache namespace, and migration contract already existed. B4 added fail-closed provider contracts and reproducible evidence without presenting the deterministic placeholder as production quality.

### Scope

1. Freeze recognized profiles separately from production support:
   - OpenAI `text-embedding-3-small` and `text-embedding-3-large`.
   - Ollama profiles whose model, dimensions, and endpoint behavior are verified against a running server.
2. Add provider contract fixtures for:
   - request batching and response ordering;
   - timeout and retryable/non-retryable failures;
   - dimension mismatch;
   - credential and base URL handling;
   - cache namespace isolation;
   - migration from a different embedding contract.
3. Produce provider-labeled benchmark reports. Reports must include model identity, dimensions, endpoint class, dataset identity, quality metrics, noise behavior, and latency.
4. Keep live-provider runs opt-in. Secrets never enter fixtures, reports, snapshots, caches committed to git, or logs.
5. Update user guidance so `local-placeholder` remains explicitly development-only.

### Exit

- Mocked provider contracts are deterministic in normal CI.
- Loopback Ollama `nomic-embed-text` has reproducible live evidence and passes its approved thresholds.
- OpenAI remains recognized and mock-contract-tested but is not declared production-supported without authorized live evidence.
- No silent fallback changes a requested provider into the placeholder.

## C — Distribution and Native Runtime Matrix

### Current gap

The package pins `@zvec/zvec@0.2.1`, whose optional native packages are published for macOS ARM64 plus Linux ARM64/x64. Published package presence is not sufficient evidence: direct import on the standard Ubuntu 24 x64 runner terminates with `SIGILL`. Node 20 is end-of-life, and the static zvec import can currently fail before RAGit reports its own runtime policy. The supported matrix must be proved from the packed tarball rather than inferred from a dependency README.

### Scope

1. Add a PR CI workflow with:
   - Node `22.14.0` minimum and Node 24 compatibility;
   - Linux ARM64 and macOS ARM64, each on Node 22.14 and Node 24;
   - frozen install, unit/contract tests, build verification, pack verification, and installed-CLI E2E.
2. Run the tarball smoke through `init → commit → ingest → query → context pack → status`.
3. Test upgrade from the currently published package and reopen existing stores.
4. Declare only targets that pass. Linux x64, Windows x64, and every other unsupported target must fail before zvec binding import with an accurate diagnostic.
5. Keep zvec 0.2.1 in C. Evaluate zvec 0.5 and Windows support only in a separate compatibility change with store-schema, query, migration, and benchmark gates.

### Exit

The README, `status`/`doctor`, runtime allow-list, package metadata, and CI matrix agree on exactly the same supported targets, and every declared target has a green packed-install E2E run.

## D — Read-only MCP Projection

**Status:** Complete. Focused, full-suite, retrieval-quality, runtime, installed-tarball, upgrade, documentation, and prohibited-scope gates passed on 2026-07-16. Exact evidence is recorded in the approved design spec.

### Dependency choice

Use the stable v1 `@modelcontextprotocol/sdk` for this release. The split v2 SDK is still pre-release as of this plan and is a later migration, not a release blocker.

### Scope

1. Add a local stdio server only; no HTTP listener or authentication surface.
2. Expose three bounded tools:
   - `ragit_status`
   - `ragit_query`
   - `ragit_context_pack`
3. Reuse the same normalized inputs and result projections as the CLI.
4. Add an explicit read-only execution policy through retrieval:
   - embedding cache mode is `readonly`;
   - no cache directory, manifest, ledger, report, memory, artifact, store, or config write is reachable;
   - missing cached remote embeddings fail closed rather than writing.
5. Limit result sizes with the existing `topK`, budget, view, exact-snapshot, masking, and citation contracts.
6. Capture filesystem state before and after every tool call in tests.

### Exit

- MCP protocol tests can initialize, list tools, and call all three tools over stdio.
- Successful and failing calls preserve stable structured errors.
- A write-path coverage test proves the registered handlers cannot reach mutating commands.
- Repository-owned files are byte-for-byte unchanged after tool calls.

## E — Release, Trusted Publishing, and Registry Verification

### Scope

1. Create a release-only PR:
   - choose the semver from the accumulated public contract changes;
   - update package version, lockfile, release notes, README support table, and docs;
   - make the PR CI matrix required.
2. Run the complete gate:
   - focused tests for B1–D;
   - full suite;
   - B1 and provider-labeled retrieval reports;
   - build and package contracts;
   - every declared distribution target;
   - docs build and all docs checks;
   - MCP read-only E2E.
3. Confirm npm trusted publisher configuration matches `rhiokim/ragit`, `publish.yml`, and the allowed `npm publish` action.
4. Keep GitHub-hosted publishing with `id-token: write`, npm CLI >= 11.5.1, and Node >= 22.14.
5. Merge the release PR, create the matching signed/tagged release, and let the tag workflow publish.
6. Verify from the registry in a clean directory:
   - exact version and integrity;
   - provenance;
   - file list and executable bit;
   - `ragit --version`, `--help`, `init`, `ingest`, `query`, `context pack`, `status`, and MCP startup;
   - no dependency on the source checkout.

### Exit

The registry tarball, GitHub tag, package version, documentation, and provenance identify the same release, and a clean install passes the release smoke on the declared primary platform.

## Cross-Workstream Gates

Every implementation PR must satisfy:

1. Focused red-green tests for the changed contract.
2. `pnpm test`.
3. `pnpm benchmark:retrieval:verify` when retrieval or provider behavior is reachable.
4. `pnpm build` and `pnpm build:verify`.
5. `pnpm pack:verify` and `pnpm pack:smoke`.
6. `pnpm docs:build`, then all command, link, i18n, and search checks for user-facing changes.
7. `git diff --check`, prohibited-scope audit, and clean worktree.
8. Sol Max review of every Terra commit before parent integration.

## Stop Conditions

Stop and return the decision to Sol Max when:

- a task requires changing retrieval weights, thresholds, package version, or a later workstream;
- live provider evidence requires credentials or paid usage not already authorized;
- a native target fails because upstream has no supported binary;
- MCP requires a write path to answer a read-only tool;
- the release workflow and npm trusted-publisher identity do not match;
- a benchmark changes outside an explicitly approved threshold update.

## Research Basis

- OpenAI currently exposes `text-embedding-3-small` through the embeddings endpoint: <https://developers.openai.com/api/docs/models/text-embedding-3-small>
- Ollama's current embed endpoint accepts one string or an array and returns ordered embedding arrays: <https://docs.ollama.com/api/embed>
- Current zvec documentation lists Linux x64/ARM64, macOS ARM64, and Windows x64: <https://github.com/alibaba/zvec>
- GitHub currently offers hosted runners for Linux x64/ARM64, macOS ARM64, and Windows x64: <https://docs.github.com/en/actions/reference/runners/github-hosted-runners>
- MCP's official TypeScript SDK recommends v1 for production until v2 stabilizes: <https://github.com/modelcontextprotocol/typescript-sdk>
- npm trusted publishing requires OIDC, `id-token: write`, npm >= 11.5.1, and Node >= 22.14: <https://docs.npmjs.com/trusted-publishers/>
