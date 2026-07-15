# Production Embedding Profiles — Implementation Plan

> Execute one task at a time. Terra writes focused red-green commits; Sol Max reviews each commit, runs independent checks, and owns evidence and integration.

**Goal:** Make existing OpenAI and Ollama profiles fail closed and produce reproducible provider-labeled retrieval evidence without changing B1 behavior.

**Design:** `docs/superpowers/specs/2026-07-15-production-embedding-profiles-design.md`

**Baseline:** `origin/main` at `89e25dd`

## Task 1 — Fail-closed response mapping

**Files**

- Modify: `src/core/embedding.ts`
- Modify: `test/embedding-batch.test.ts`
- Modify: `test/embedding-cache.test.ts`
- Modify: `test/embedding-execution.integration.test.ts` (add official response indexes to the existing success fixture only)
- Modify: `test/status-snapshot.integration.test.ts` (add official response indexes to the existing success fixture only)
- Modify: `test/memory.test.ts` (add official response indexes to the existing success fixture only)
- Modify: `test/ingest.integration.test.ts` (add official response indexes to the existing success fixture only)

**Red tests**

- OpenAI returns reversed `data` order with correct indexes and RAGit restores input order.
- OpenAI rejects missing, duplicate, fractional, negative, and out-of-range indexes.
- OpenAI and Ollama reject fewer or more vectors than inputs.
- Both providers reject non-number and non-finite vector entries.
- Wrong dimensions keep `DIMENSION_MISMATCH`.
- Missing result slots never become zero vectors.
- Invalid cached vectors are cache misses.

**Implementation boundary**

- Add only `RESPONSE_INVALID` to the normalized error-code union.
- Validate exact count before resolving deferred requests.
- Do not change batching limits, profile dimensions, retry counts, cache namespace identity, or placeholder math.

**Verify**

```bash
pnpm vitest run test/embedding-batch.test.ts test/embedding-cache.test.ts
pnpm vitest run test/embedding-execution.integration.test.ts test/status-snapshot.integration.test.ts test/memory.test.ts test/ingest.integration.test.ts
```

## Task 2 — Endpoint, timeout, and retry safety

**Files**

- Modify: `src/core/embedding.ts`
- Modify: `test/embedding.test.ts`
- Modify: `test/embedding-batch.test.ts`

**Red tests**

- Provider roots accept absolute HTTP(S) URLs and strip trailing slashes.
- Roots reject credentials, query, fragment, relative values, and non-HTTP(S) schemes without echoing the raw value.
- OpenAI credentials are read from the environment and never appear in an error.
- Timeout aborts the active request and yields retryable `TIMEOUT`.
- 429/5xx retry; other 4xx do not.
- A valid `Retry-After` is never shortened by jitter.
- `RESPONSE_INVALID` and `DIMENSION_MISMATCH` do not retry.

**Implementation boundary**

- Preserve the existing schedules and attempt counts.
- Do not add a provider SDK dependency.
- Do not accept credentials in config or CLI.

**Verify**

```bash
pnpm vitest run test/embedding.test.ts test/embedding-batch.test.ts
```

## Task 3 — Opt-in provider benchmark profiles

**Files**

- Modify: `scripts/benchmark-retrieval.ts`
- Modify: `src/core/retrieval-evaluation.ts`
- Modify: `test/retrieval-evaluation.test.ts`
- Modify: `package.json`
- Add: `benchmarks/retrieval/v1/thresholds-openai-text-embedding-3-small.json`
- Add: `benchmarks/retrieval/v1/thresholds-ollama-nomic-embed-text.json`

**Red tests**

- Parser accepts only the four explicit provider/model IDs.
- Base URL and timeout overrides require an explicit profile.
- Timeout is a positive safe integer.
- The selected config is written before the fixture initialization commit.
- Explicit reports include a valid endpoint class but no base URL or credential field.
- Default arguments and report shape remain unchanged.
- Provider threshold files parse and identify the exact provider/model/version.

**Implementation boundary**

- Reuse the existing dataset, evaluator, and report builder.
- Add optional `profile.endpointClass` only for explicit live-profile runs.
- Add opt-in package scripts for the two initial evidence targets.
- Do not edit `benchmarks/retrieval/v1/dataset.json` or `benchmarks/retrieval/v1/thresholds.json`.

**Verify**

```bash
pnpm vitest run test/retrieval-evaluation.test.ts
pnpm benchmark:retrieval:verify -- --output /tmp/ragit-retrieval-b4-local.json
```

Compare the B4 local report with the B3 reference for identical aggregate quality, slices, noise values, per-case metrics, and all 108 ranked-path arrays.

## Task 4 — User guidance and evidence record

**Files**

- Modify: `README.md`
- Modify: `apps/docs/content/docs/en/commands/config/set.mdx`
- Modify: `apps/docs/content/docs/ko/commands/config/set.mdx`
- Modify: `apps/docs/content/docs/en/commands/migrate/embeddings.mdx`
- Modify: `apps/docs/content/docs/ko/commands/migrate/embeddings.mdx`
- Add: `benchmarks/retrieval/v1/README.md`

**Content contract**

- Separate recognized profiles, evidence-backed profiles, and development-only placeholder.
- Show environment-only OpenAI setup and loopback Ollama setup.
- Define base URL as a credential-free provider root.
- Explain migration after profile changes.
- Document the exact benchmark commands, thresholds, report handling, and unsupported-on-failure rule.
- Keep English and Korean command documentation structurally paired.

**Verify**

```bash
pnpm docs:check:commands
pnpm docs:check:internal-links
pnpm docs:check:i18n
pnpm docs:check:search-index
pnpm docs:build
```

## Task 5 — Sol Max live evidence

**Ollama**

```bash
ollama pull nomic-embed-text
pnpm benchmark:retrieval:ollama:verify -- --output /tmp/ragit-retrieval-b4-ollama.json
```

Record Ollama version, model digest, OS/architecture class, report SHA-256, aggregate metrics, noise drop, p95 latency, and gate result. Do not record local usernames or absolute paths.

**OpenAI**

```bash
test -n "$OPENAI_API_KEY"
pnpm benchmark:retrieval:openai:verify -- --output /tmp/ragit-retrieval-b4-openai.json
```

Stop if the credential is unavailable or paid use has not been authorized. Record report SHA-256, aggregate metrics, noise drop, p95 latency, and gate result; never print or persist the key.

## Task 6 — Independent regression and integration

Sol Max runs:

```bash
pnpm vitest run test/embedding.test.ts test/embedding-batch.test.ts test/embedding-cache.test.ts test/embedding-execution.integration.test.ts test/embedding-migrate.integration.test.ts test/retrieval-evaluation.test.ts
pnpm test
pnpm benchmark:retrieval:verify -- --output /tmp/ragit-retrieval-b4-parent.json
pnpm build
pnpm build:verify
pnpm pack:verify
pnpm pack:smoke
pnpm docs:check:commands
pnpm docs:check:internal-links
pnpm docs:check:i18n
pnpm docs:check:search-index
pnpm docs:build
git diff --check
git status --short
```

Audit that retrieval weights, B1 dataset/default thresholds, Context Pack, zvec, package version/lockfile, MCP, distribution workflows, and publish workflows are unchanged.

## Task 7 — PR and merge gate

- Push `feat/production-embedding-profiles`.
- Create a focused ready PR with mocked-contract results, B1 equivalence, live report digests, and provider gate outcomes.
- Merge only after both initial live targets pass. If OpenAI evidence remains unavailable, leave the PR unmerged or narrow the support claim through an explicit Sol Max decision; do not imply live OpenAI validation.
- Rebase-merge, verify the merged tree matches the reviewed tree, and delete the feature branch.
