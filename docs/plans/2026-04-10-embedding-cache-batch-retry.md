---
type: plan
---
# Provider-Aware Embedding Cache + Batch/Retry Execution Layer Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a disk-backed, provider-aware embedding cache plus a batched and retriable execution layer so `ingest`, `query`, `context pack`, `artifacts`, and `migrate embeddings` stop calling providers one text at a time and reuse already computed vectors safely.

**Architecture:** `src/core/embedding.ts` becomes the single execution surface for provider resolution, cache lookup, batch splitting, retry/backoff, and write-through persistence. Current callers keep their high-level behavior, but the embedding facade now resolves cache hits before provider calls and only retries transient provider failures. Cache state is persisted under `.ragit/cache/embeddings/` inside the repo so it follows the existing local-first model.

**Tech Stack:** TypeScript, Node `fetch`, `node:fs/promises`, existing zvec store, current CLI/config pipeline, existing docs/test setup.

---

## Why This Is Next Priority

`ragit` already has real provider support for `local-placeholder`, `openai`, and `ollama`, but the current execution path still sends each embedding request directly through the provider facade without persistent reuse or controlled batching. That means large `ingest` runs, `migrate embeddings`, and repeated `query`/`context pack` calls still pay provider cost every time.

This is the highest-leverage next step because it improves the operational core that every embedding-dependent command already uses:

1. `ingest` repeatedly embeds chunk text.
2. `query` embeds user queries on every request.
3. `artifacts` and `memory` derive retrieval signals from the same embedding path.
4. `migrate embeddings` re-embeds the entire corpus and is the most obvious place where batching and retries matter.

The cache/batch/retry layer is the missing piece between "provider support exists" and "provider support is operationally usable."

---

## Public Interface

### Command surface

- No new top-level command is required in v1.
- The cache layer is surfaced through existing embedding-dependent commands and existing diagnostics.

### Config surface

- `embedding.cache_enabled`
- `embedding.cache_dir`
- Provider-specific batch and retry policy remains code-fixed in v1.

### Cache key contract

- The cache namespace MUST include `provider`, `model`, `version`, `dimensions`, and normalized `baseUrl`.
- The cache leaf key MUST include the text hash.
- The text hash MUST be computed from the exact provider input string after newline normalization only (`\r\n` -> `\n`), not from a semantic normalization pass.
- The canonical cache key SHOULD be represented as:
  - `schemaVersion`
  - `provider`
  - `model`
  - `version`
  - `dimensions`
  - `baseUrl`
  - `textHash`
- `local-placeholder` participates in the same cache contract so the facade stays uniform, even though it does not need retries.

### Storage location and format

- Repository-local cache root: `.ragit/cache/embeddings/`
- Namespace directory layout:
  - `.ragit/cache/embeddings/v1/<namespaceId>/namespace.json`
  - `.ragit/cache/embeddings/v1/<namespaceId>/entries/<textHash>.json`
- `namespaceId` MUST be derived from the embedding profile fingerprint, not from the text.
- `namespace.json` MUST store the active profile contract and lightweight counters.
- Each entry JSON MUST store:
  - `schemaVersion`
  - `cacheKey`
  - `provider`
  - `model`
  - `version`
  - `dimensions`
  - `baseUrl`
  - `textHash`
  - `embedding`
  - `createdAt`
  - `updatedAt`
  - `lastHitAt`
  - `hitCount`
- The cache is repository-local and gitignored through the existing `.ragit/cache/` rule.

### Read-through / write-through policy

- Read-through is mandatory.
- For every unique input text, the facade MUST check the cache before any provider call.
- Write-through is mandatory on successful provider responses.
- Cache write failures MUST not fail the embedding request; they should degrade to a non-fatal cache warning while the provider result remains authoritative.
- Duplicate requests in the same process SHOULD reuse the same in-flight work instead of issuing duplicate provider calls.

### Batch size policy and provider limits

- The batch layer MUST split requests by both item count and approximate UTF-8 byte size.
- Provider-specific defaults are fixed in code, not config:
  - `local-placeholder`: `maxItems=256`, `maxBytes=4 MiB`, `retryAttempts=0`
  - `openai`: `maxItems=96`, `maxBytes=1 MiB`, `retryAttempts=4`
  - `ollama`: `maxItems=32`, `maxBytes=256 KiB`, `retryAttempts=5`
- A single oversized text MAY be sent alone even if it exceeds the normal batch size limit.
- The batch packer MUST preserve input order in the final output vectors.

### Retry / backoff policy

- Retryable failures are:
  - network failures
  - request timeouts
  - HTTP `429`
  - HTTP `5xx`
- Non-retryable failures are:
  - `CREDENTIAL_MISSING`
  - `PROVIDER_UNSUPPORTED`
  - `DIMENSION_MISMATCH`
  - HTTP `4xx` other than `429`
- Backoff MUST be exponential with jitter.
- The default schedule MUST be:
  - `openai`: `250ms`, `500ms`, `1000ms`, `2000ms`
  - `ollama`: `150ms`, `300ms`, `600ms`, `1200ms`, `2400ms`
- `Retry-After` SHOULD be respected when a provider returns it.
- Retries are batch-scoped, not item-scoped, because the embedding APIs are called in batched requests.

### `migrate embeddings` interaction

- `ragit migrate embeddings` MUST use the same embedding facade so it benefits from batching and cache reuse.
- Cache namespaces MUST remain contract-scoped, so a migration to a new provider/model/version/dimensions never collides with an older namespace.
- `migrate embeddings --dry-run` MUST not write cache files.
- `migrate embeddings` apply mode SHOULD populate the target cache namespace while rebuilding the temp store.
- Migration MUST stay correct if the cache is disabled or partially unreadable; cache failure cannot block store migration.

### `status` / `doctor` visibility

- `status` SHOULD expose a lightweight `embedding.cache` block with:
  - `enabled`
  - `dir`
  - `namespaceId`
  - `entryCount`
  - `batchPolicy`
  - `retryPolicy`
- `doctor` SHOULD expose integrity checks for:
  - cache directory existence and writability
  - namespace manifest readability
  - configured profile vs cache namespace match
  - invalid or corrupt cache entry counts
- `doctor` MUST stay lightweight; it should not do a full cache scan unless the cache manifest is missing or unreadable.

---

## Implementation Changes

### Task 1: Lock the cache contract and file layout

**Files:**
- Modify: `src/core/embedding.ts`
- Modify: `src/core/types.ts`
- Modify: `src/core/config.ts`
- Modify: `src/core/project.ts`
- Test: `test/embedding-cache.test.ts`

**Step 1: Write the failing tests**

- Add tests for cache namespace fingerprinting, text hash normalization, and on-disk path generation.
- Add tests that prove `provider/model/version/dimensions/baseUrl/textHash` all affect the cache key.
- Add tests that prove newline-only normalization does not collapse different texts.

Run:

```bash
pnpm exec vitest run test/embedding-cache.test.ts
```

Expected: FAIL because cache contract helpers do not exist yet.

**Step 2: Write minimal implementation**

- Add cache-related config fields to the existing `embedding` section.
- Add a cache namespace resolver and a record serializer/deserializer.
- Add a file-path strategy under `.ragit/cache/embeddings/v1/<namespaceId>/entries/`.

**Step 3: Run the tests again**

Run:

```bash
pnpm exec vitest run test/embedding-cache.test.ts
```

Expected: PASS.

**Step 4: Commit**

```bash
git add src/core/embedding.ts src/core/types.ts src/core/config.ts src/core/project.ts test/embedding-cache.test.ts
git commit -m "feat: add embedding cache contract and storage layout"
```

### Task 2: Add batch packing and retry/backoff to the embedding facade

**Files:**
- Modify: `src/core/embedding.ts`
- Test: `test/embedding-batch.test.ts`

**Step 1: Write the failing tests**

- Add tests for provider-specific batch splitting.
- Add tests for retry classification and backoff scheduling.
- Add tests for in-flight deduplication when the same text appears multiple times in one call.

Run:

```bash
pnpm exec vitest run test/embedding-batch.test.ts
```

Expected: FAIL because batch scheduler and retry helpers do not exist yet.

**Step 2: Write minimal implementation**

- Refactor `embedTexts` into an orchestrator that:
  - resolves cache hits first
  - batches remaining misses by provider policy
  - retries only transient failures
  - writes successful vectors through to cache
- Keep `embedText` as a thin wrapper over `embedTexts`.
- Preserve `local-placeholder` behavior, but still let it benefit from cache hits.

**Step 3: Run the tests again**

Run:

```bash
pnpm exec vitest run test/embedding-batch.test.ts
```

Expected: PASS.

**Step 4: Commit**

```bash
git add src/core/embedding.ts test/embedding-batch.test.ts
git commit -m "feat: add batching and retry execution for embeddings"
```

### Task 3: Wire the callers and migration path through the new execution layer

**Files:**
- Modify: `src/core/ingest.ts`
- Modify: `src/core/retrieval.ts`
- Modify: `src/core/artifacts.ts`
- Modify: `src/core/migrate.ts`
- Test: `test/embedding-execution.integration.test.ts`

**Step 1: Write the failing tests**

- Add an integration test that proves `ingest`, `query`, `artifacts`, and `migrate embeddings` all reuse the same cache-aware embedding facade.
- Add a test that proves migration still works when the cache is cold and that it reuses cache entries when the target profile already exists.

Run:

```bash
pnpm exec vitest run test/embedding-execution.integration.test.ts
```

Expected: FAIL because the integration assertions for cache reuse are not implemented yet.

**Step 2: Write minimal implementation**

- Keep the call sites as they are where possible, but route all provider calls through the upgraded facade.
- Ensure `migrate embeddings` does not bypass the cache layer.
- Ensure cache failures do not change the functional output of ingest/retrieval/migration.

**Step 3: Run the tests again**

Run:

```bash
pnpm exec vitest run test/embedding-execution.integration.test.ts
```

Expected: PASS.

**Step 4: Commit**

```bash
git add src/core/ingest.ts src/core/retrieval.ts src/core/artifacts.ts src/core/migrate.ts test/embedding-execution.integration.test.ts
git commit -m "feat: route embedding callers through cache-aware execution"
```

### Task 4: Expose cache health in `status` and `doctor`, then document the surface

**Files:**
- Modify: `src/commands/bootstrap.ts`
- Modify: `src/cli.ts`
- Modify: `src/core/commandRegistry.ts`
- Modify: `src/core/config.ts`
- Modify: `apps/docs/content/docs/en/commands/status.mdx`
- Modify: `apps/docs/content/docs/ko/commands/status.mdx`
- Modify: `apps/docs/content/docs/en/commands/doctor.mdx`
- Modify: `apps/docs/content/docs/ko/commands/doctor.mdx`
- Modify: `apps/docs/content/docs/en/commands/config/set.mdx`
- Modify: `apps/docs/content/docs/ko/commands/config/set.mdx`
- Test: `test/status-cache.test.ts`

**Step 1: Write the failing tests**

- Add tests that assert `status.embedding.cache` shows the active namespace, entry count, and policy summary.
- Add tests that assert `doctor` reports cache writability and namespace consistency without scanning the full cache tree.

Run:

```bash
pnpm exec vitest run test/status-cache.test.ts
```

Expected: FAIL because status/doctor do not expose cache health yet.

**Step 2: Write minimal implementation**

- Add the cache summary fields to `status`.
- Add lightweight cache integrity checks to `doctor`.
- Document the new `embedding.cache_*` config keys and the cache behavior in command docs.

**Step 3: Run the tests again**

Run:

```bash
pnpm exec vitest run test/status-cache.test.ts
```

Expected: PASS.

**Step 4: Commit**

```bash
git add src/commands/bootstrap.ts src/cli.ts src/core/commandRegistry.ts src/core/config.ts apps/docs/content/docs/en/commands/status.mdx apps/docs/content/docs/ko/commands/status.mdx apps/docs/content/docs/en/commands/doctor.mdx apps/docs/content/docs/ko/commands/doctor.mdx apps/docs/content/docs/en/commands/config/set.mdx apps/docs/content/docs/ko/commands/config/set.mdx test/status-cache.test.ts
git commit -m "feat: surface embedding cache health in status and doctor"
```

### Task 5: Verify regressions and refresh the docs bundle

**Files:**
- Modify: any remaining command docs that mention embedding/provider behavior
- Test: existing embedding, migration, ingest, retrieval, and CLI contract tests

**Step 1: Run the focused test bundle**

Run:

```bash
pnpm exec vitest run test/embedding-cache.test.ts test/embedding-batch.test.ts test/embedding-execution.integration.test.ts test/status-cache.test.ts test/embedding-migrate.integration.test.ts test/cli.contract.test.ts
```

Expected: PASS.

**Step 2: Run the typecheck**

Run:

```bash
pnpm exec tsc --noEmit
```

Expected: PASS.

**Step 3: Rebuild docs**

Run:

```bash
pnpm docs:build
```

Expected: PASS.

**Step 4: Commit**

```bash
git add .
git commit -m "docs: finish embedding cache and execution layer rollout"
```

---

## Test Plan

- Unit tests MUST cover cache key derivation, namespace layout, and newline-only text normalization.
- Unit tests MUST cover batch splitting by item count and payload size.
- Unit tests MUST cover retryable vs non-retryable embedding errors and backoff timing.
- Integration tests MUST cover cache hits, cache misses, write-through persistence, and retry recovery for `ingest`, `query`, `artifacts`, and `migrate embeddings`.
- `status` and `doctor` tests MUST verify that cache health is exposed without forcing a full cache scan.
- Regression tests MUST prove that `local-placeholder` still works with no config changes and that `migrate embeddings` still preserves manifest behavior.

Concrete commands to run before merge:

```bash
pnpm exec vitest run test/embedding-cache.test.ts test/embedding-batch.test.ts test/embedding-execution.integration.test.ts test/status-cache.test.ts test/embedding-migrate.integration.test.ts test/cli.contract.test.ts
pnpm exec tsc --noEmit
pnpm docs:build
```

---

## Assumptions

- `local-placeholder`, `openai`, and `ollama` remain the only supported providers in v1.
- The cache is repository-local and does not attempt cross-repository reuse.
- No automatic eviction/compaction is planned in v1; the cache behaves as a persistent content-addressed store.
- No new top-level CLI command is required for cache management in v1.
- Provider-specific batch and retry constants are fixed in code, not user-configurable, so the first implementation stays deterministic.
- The cache layer must never change the semantic result of embedding calls; it only reduces provider traffic and improves resilience.

### Non-Scope

- Cross-process distributed cache sharing
- Background cache compaction or TTL eviction
- Provider SDK adoption beyond Node `fetch`
- Automatic provider fallback when one provider fails
- Global cache warming across repositories
- Changes to `ragit log` / `timeline`
