---
type: plan
---
# Artifact-Aware Semantic History for `ragit log`

## Summary

`ragit log` should evolve from a snapshot delta viewer into the semantic history reader for RAGit. Its job is not to mirror `git log`; its job is to explain what changed semantically, what the next agent should believe, what is still open, and which artifacts/evidence support that state.

`timeline` should remain a separate command and keep its current role as the operational ledger reader for append-only events. The two commands should feel like two views of one coherent history model, not like unrelated features.

## Current Repo Reality

- `src/core/log.ts` currently walks git commits, loads snapshot manifests, compares document and chunk deltas, and renders `minimal/default/full` output. It does not yet surface artifact-aware belief/open/evidence state.
- `src/core/event-ledger.ts` and `src/commands/timeline.ts` currently implement an append-only event ledger reader. `timeline` already filters by goal, episode, session, kind, and time range, and it is the right place for operational events such as `session.materialize`, `artifact.review`, `memory.wrap`, `memory.promote`, `harness.capture`, `harness.promote`, and `ingest.completed`.
- `src/core/artifacts.ts`, `src/core/manifest.ts`, and `src/core/types.ts` already contain the structural pieces needed for richer semantic history:
  - `ArtifactRecord`
  - `ArtifactManifestEntry`
  - `SnapshotManifest.artifactEntries`
  - `SnapshotManifest.chunkScopes`
  - artifact provenance and binding status
- The docs already draw the philosophical split:
  - `log` answers semantic snapshot-history questions
  - `timeline` answers operational time-axis questions
  - the memory docs already use the vocabulary of goal, constraint, open loop, next action, durable knowledge, and evidence

## Public Interface Decisions

- Keep the `ragit log` command name and the existing flags (`revRange`, `--max-count`, `--view`, `--type`, `--path`, `--show-missing`, `--format`, `--cwd`).
- Keep the `timeline` command name and its existing flags unchanged.
- Keep JSON compatibility additive. Existing `snapshot` fields should remain, and any new semantic information should be added as sibling fields rather than replacing the current snapshot contract.
- Keep `snapshot` as the primary unit inside each log entry. Add a semantic overlay on top of it instead of turning `log` into a second event ledger.
- Do not introduce a new top-level command for this feature.
- Keep `timeline` JSON and text contracts behaviorally unchanged. The implementation may refactor shared vocabulary helpers, but `timeline` itself must remain an operational ledger projection.

Recommended shape for the log entry contract:

```json
{
  "commitSha": "string",
  "subject": "string",
  "authorName": "string",
  "authoredAt": "ISO-8601",
  "snapshot": {
    "status": "indexed|missing",
    "createdAt": "ISO-8601|null",
    "docs": 0,
    "chunks": 0,
    "delta": {
      "added": 0,
      "modified": 0,
      "deleted": 0
    },
    "types": {},
    "changed": []
  },
  "semantic": {
    "available": true,
    "headline": "string",
    "counts": {
      "beliefs": 0,
      "openLoops": 0,
      "evidence": 0,
      "artifacts": 0
    },
    "beliefs": [],
    "openLoops": [],
    "evidence": [],
    "artifacts": []
  }
}
```

## Proposed Semantic Model

The implementation should derive semantic history from the current snapshot plus its bound artifacts.

- **Single source of truth:** semantic overlay is derived from `SnapshotManifest.artifactEntries` only. `timeline`, raw transcript ledgers, and event replay must not be used as semantic inputs.
- **Artifact loading rule:** `artifactEntries[].artifactId` is the only lookup key. If the backing artifact JSON is loadable, enrich the overlay with `title`, `summary`, `authority`, `confidence`, and `evidenceRefs`. If the file is missing, keep the support item using manifest metadata only and mark it as degraded rather than failing the entire entry.
- **Deterministic classification rules are fixed as follows:**
  - `beliefs`: loaded artifacts with `status=reviewed` and `kind in {feedback,constraint,insight,oracle,checker,rubric,envAssumption}`
  - `openLoops`: loaded artifacts with `status in {captured,reviewed}` and `kind in {openLoop,failure}`
  - `evidence`: `evidenceRefs` flattened from the artifacts already selected into `beliefs` or `openLoops`
  - `artifacts`: every manifest-referenced artifact entry, whether the artifact JSON was fully loaded or not
- **Sorting is fixed:**
  - `beliefs` / `openLoops`: higher authority first, then newer `updatedAt`, then `artifactId`
  - `evidence`: source artifact sort order first, then `evidenceId`
  - `artifacts`: `reviewed` before `captured`, then `artifactScope`, then `artifactId`
- **Deduplication is fixed:** lists dedupe by `artifactId`, except `evidence`, which dedupes by `artifactId + evidenceId`.
- **Confidence is not recomputed in `log`:** the overlay must only reuse stored `authority` / `confidence` values from artifact records. No new scoring logic belongs in `log`.
- The semantic layer must stay deterministic and derivable from stored snapshot-bound data. It must not depend on live event replay, and it must not read raw transcript material back into the log.

## View Contract

- `minimal`
  - keep one-line scan output
  - append compact semantic counts only
  - JSON projection includes `semantic.available`, `semantic.headline`, and `semantic.counts`, but omits semantic arrays
- `default`
  - become the main semantic reader
  - show current snapshot delta plus short `beliefs`, `openLoops`, `evidence`, and `artifacts` lists
  - JSON projection includes full semantic arrays with concise fields
- `full`
  - include the same semantic arrays plus `authority`, `confidence`, `bindingStatus`, `sourceSessionId`, `goalId`, `episodeId`, and artifact path/session metadata

## Backward-Compatibility Rules

- If `snapshot.status === "missing"`, `semantic.available = false` and all semantic arrays are empty.
- Because `loadSnapshotManifest()` normalizes older manifests into the current shape, the runtime cannot reliably distinguish “old manifest backfill” from “current manifest with no artifact entries”. In both cases, the contract should be `semantic.available = true` with zero counts and an empty semantic overlay.
- This feature must not require a manifest schema migration.

## Performance Rules

- `runRagitLog()` must cache manifests by commit SHA as it already does.
- It must also cache artifact-record lookups by `artifactId` for the full command run.
- No per-entry filesystem scan is allowed beyond loading the artifact IDs referenced by that entry’s manifest.
- No event-ledger reads are allowed inside `log`.

## Timeline / Log Boundary

`timeline` must stay operational and append-only. It should continue to expose what happened across workflow events, but it should not absorb the snapshot semantic model.

The shared model between `log` and `timeline` should be conceptual, not behavioral:

- shared identifiers: `goalId`, `episodeId`, `sessionId`, `sourceHeadSha`, `artifactIds`
- shared provenance vocabulary: actor, producer, producerVersion, operation, evidence refs
- shared mental model: `log` explains semantic state, `timeline` explains event order

That means `timeline` can stay as-is structurally, while `log` gains a semantic overlay derived from manifests and artifacts.

## Likely Files To Touch

- `src/core/log.ts`
- `src/core/types.ts`
- `src/core/artifacts.ts`
- `src/core/manifest.ts`
- `src/core/commandRegistry.ts`
- `src/cli.ts`
- `src/core/output.ts` if formatting projection needs to be shared or generalized
- `src/core/event-ledger.ts` only if shared history vocabulary is factored out
- `apps/docs/content/docs/en/commands/log.mdx`
- `apps/docs/content/docs/ko/commands/log.mdx`
- `apps/docs/content/docs/en/commands/timeline.mdx`
- `apps/docs/content/docs/ko/commands/timeline.mdx`
- `apps/docs/content/docs/en/commands/index.mdx`
- `apps/docs/content/docs/ko/commands/index.mdx`
- `apps/docs/content/docs/en/commands/status.mdx`
- `apps/docs/content/docs/ko/commands/status.mdx`
- `test/log.integration.test.ts`
- `test/cli.contract.test.ts`
- `test/timeline.integration.test.ts`
- `test/manifest.compat.test.ts`

If the implementation wants a cleaner boundary, a new shared helper such as `src/core/history.ts` or `src/core/history-model.ts` would be reasonable for semantic-state derivation, artifact classification, and reusable display metadata.

## Implementation Plan

1. Define the semantic history model in `src/core/types.ts`.
   - Add explicit log semantic-state types for beliefs, open loops, evidence, and artifact support.
   - Keep the existing snapshot/change types intact.
   - Reuse existing artifact provenance fields instead of inventing a parallel vocabulary.
2. Add a shared derivation layer for snapshot semantic state.
   - Load manifest `artifactEntries` for each indexed commit.
   - Load supporting artifact records by `artifactId` with a per-run cache.
   - Derive deterministic buckets for beliefs, open loops, evidence, and supporting artifacts using the fixed classification rules above.
   - Preserve a graceful fallback for commits with missing manifests, old manifests, or missing artifact JSON files.
3. Extend `src/core/log.ts` to emit the new semantic overlay.
   - Keep the current document/chunk diff logic.
   - Add artifact-aware semantic summarization per entry.
   - Keep `minimal/default/full` views, but make `default` the main semantic reader instead of a raw change list.
4. Keep `timeline` separate.
   - Avoid making `timeline` depend on the semantic log derivation.
   - If code sharing is needed, share only low-level history vocabulary or provenance helpers.
5. Update CLI metadata and docs.
   - Refresh `describe log` and `describe timeline` wording.
   - Rewrite the command docs to explain the split: `log` = semantic snapshot history, `timeline` = operational ledger.
   - Update the command index and status pages so the navigation reflects the new mental model.
6. Add regression coverage.
   - Verify that the new semantic block appears in `log` JSON output.
   - Verify that `timeline` output is unchanged.
   - Verify that v2 manifests still backfill cleanly and do not break `log`.
   - Verify that `log` and `timeline` remain meaningfully distinct in docs and contracts.

## Text / JSON Output Direction

- `minimal` should remain a one-line scan format, but it can include a short semantic headline and compact artifact counts.
- `default` should become the main semantic reading mode. It should still show the current snapshot delta, but underneath that it should explain beliefs, open loops, evidence, and supporting artifacts.
- `full` should expose the richest artifact support, including status, authority, confidence, binding status, and evidence refs.
- JSON output should remain machine-friendly and additive. The new `semantic` block should be enough for downstream agents to answer:
  - what changed semantically
  - what the next agent should believe
  - what is still open
  - which artifacts and evidence support the state

## Compatibility / Migration Notes

- Existing `log` callers should keep working because the command name, flags, and top-level snapshot information stay in place.
- Old manifests should still work. If `artifactEntries` is absent after normalization, the semantic block should degrade to an empty overlay rather than failing.
- `timeline` should not gain new responsibilities as part of this change. It is the operational ledger reader, not the semantic history reader.
- This feature should not require a manifest format migration. It should consume the artifact metadata that already exists in the current snapshot model.

## Test Plan

- `test/log.integration.test.ts`
  - add assertions for semantic `available`, `counts`, `beliefs`, `openLoops`, `evidence`, and `artifacts`
  - keep existing snapshot delta assertions
  - verify the `show-missing` path still works
- `test/cli.contract.test.ts`
  - verify `log` JSON still includes the old snapshot contract and now also includes the semantic overlay
  - verify `timeline` JSON remains unchanged
- `test/timeline.integration.test.ts`
  - verify operational events are still surfaced exactly as before
  - confirm no semantic snapshot data leaks into timeline output
- `test/manifest.compat.test.ts`
  - verify older manifests still load and `log` degrades to an empty semantic overlay
- docs build / contract checks
  - update command docs and keep the documentation checks green

## Suggested Commit Split

1. `feat: add semantic history model for log entries`
   - add shared semantic-state types
   - add artifact/support derivation helpers
2. `feat: render artifact-aware ragit log output`
   - update `src/core/log.ts`
   - preserve existing snapshot delta behavior
   - extend JSON and text output
3. `docs/test: clarify log and timeline separation`
   - update command docs and command index pages
   - add/adjust integration and contract tests

## Risks / Open Questions

- The biggest design risk is overloading `log` until it starts to feel like a second `timeline`. The semantic overlay must stay snapshot-centered.
- The semantic derivation rules need to be deterministic. If the mapping from artifacts to beliefs/open loops is too subjective, the output will drift and become hard to trust.
- Large repositories may make `log` slower if every commit causes extra artifact loads. Caching and lazy loading may be needed.
- It is still an open question how much artifact detail should appear in `minimal` versus `default`. The default should be useful without becoming verbose.
- It is also an open question whether evidence should show only reviewed/promoted artifacts by default, or whether captured artifacts should appear with lower confidence.

## Acceptance Criteria

- `ragit log` answers semantic change questions better than `git log` does.
- The next agent can read the output and understand what should be believed, what is still open, and what supports that conclusion.
- `timeline` remains a separate operational ledger reader.
- Existing callers and older manifests continue to work.
- The documentation explains the split clearly enough that users do not confuse `log` and `timeline`.
