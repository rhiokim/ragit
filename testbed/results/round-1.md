# Round-1 Self-Referential Test Bed Report

## Summary

Round-1 used the RAGit repository as a self-referential test bed.
The run normalized the `.ragit/` control plane, materialized an isolated 8-document corpus under `testbed/docs/`, validated golden queries, verified hook-driven manifest creation, checked `query --at <sha>` time travel, and ran a repository-wide mixed ingest.

## Execution SHAs

| Role | SHA | Notes |
| --- | --- | --- |
| Branch baseline | `f5163896037600693ba1a49694efd67334569e58` | Baseline before round-1 branch work |
| Corpus/control-plane commit | `f5df72d6a7d2cd4942ed039472ec5111d4301c2c` | `.ragit` init outputs + initial 8-document corpus |
| Isolated validation baseline | `ab61acf9fc5230df934c05176521a4359fa94ff0` | Corpus tuned to pass golden retrieval |
| Hook validation commit | `77887d55393922745109e8ad160846fb15ad0157` | Single-document commit used to confirm post-commit ingest |
| Time-travel validation commit | `e70bea46596a15970e664ded2a137fa86824281e` | Added explicit mixed-ingest binding in PBD |

## Control Plane Initialization

Command:

```bash
pnpm ragit init --yes --output json
```

Observed outputs:
- Existing root `AGENTS.md` was loaded without modification.
- `.ragit/config.toml` was created.
- `.ragit/guide/guide-index.json` was created.
- `.ragit/guide/templates/` contained 8 document templates: `adr`, `prd`, `srs`, `spec`, `plan`, `ddd`, `glossary`, `pbd`.

## Isolated Validation

Command:

```bash
pnpm ragit ingest --files "testbed/docs/**/*.md"
```

Baseline snapshot:
- `snapshotSha`: `ab61acf9fc5230df934c05176521a4359fa94ff0`
- `manifest`: `/Users/rhio/Works/my/ragit/.ragit/manifest/ab61acf9fc5230df934c05176521a4359fa94ff0.json`
- `docs`: 8
- `chunks`: 37

Golden query result:
- `Top-1`: 10 / 10
- `Top-3`: 10 / 10

### Context Pack Observations

Goal 1:
- Goal: `Improve the local RAGit execution guide without requiring pnpm build.`
- Snapshot: `ab61acf9fc5230df934c05176521a4359fa94ff0`
- Used tokens: 1059
- Leading hits:
  1. `testbed/docs/adr/adr-local-pnpm-runner.md` · `Decision`
  2. `testbed/docs/spec/spec-round-1-execution.md` · `Functional Requirements`
  3. `testbed/docs/adr/adr-local-pnpm-runner.md` · `Context`

Goal 2:
- Goal: `Explain Git vs RAGit with commit-bound knowledge and snapshot language.`
- Snapshot: `ab61acf9fc5230df934c05176521a4359fa94ff0`
- Used tokens: 1063
- Leading hits:
  1. `testbed/docs/plan/plan-round-1.md` · `Milestones`
  2. `testbed/docs/prd/prd-self-referential-testbed.md` · `User Value`
  3. `testbed/docs/ddd/ddd-core-models.md` · `Commit`

## Hook Validation

Commands:

```bash
pnpm ragit hooks install
pnpm ragit hooks status
```

Observed status before cleanup:
- `post-commit`: `installed`
- `post-merge`: `installed`

Validation commit:
- `hook validation sha`: `77887d55393922745109e8ad160846fb15ad0157`
- Change scope: `testbed/docs/adr/adr-local-pnpm-runner.md` only

Observed result:
- Post-commit hook generated `/Users/rhio/Works/my/ragit/.ragit/manifest/77887d55393922745109e8ad160846fb15ad0157.json`
- Hook-driven ingest therefore created a commit-bound snapshot without requiring a manual `ingest` command after the commit.

## Time-Travel Validation

Validation question:
- `What binds the isolated testbed corpus to repository-wide markdown knowledge?`

Old state:
- `sha`: `77887d55393922745109e8ad160846fb15ad0157`
- Top-1 hit: `testbed/docs/ddd/ddd-core-models.md` · `Document`
- Excerpt: `A Document is a typed markdown artifact such as ADR, PRD, SRS, SPEC, Plan, DDD, Glossary, or PBD. In the test bed, each document belongs to the testbed/docs corpus.`

New state:
- `sha`: `e70bea46596a15970e664ded2a137fa86824281e`
- Top-1 hit: `testbed/docs/pbd/pbd-phase-bindings.md` · `Mixed Ingest Binding`
- Excerpt: `Mixed ingest binds the isolated testbed/docs corpus to repository-wide markdown knowledge such as README.md, llms.txt, and the docs site content.`

Conclusion:
- `query --at <sha>` distinguished the pre-change and post-change states.
- The new PBD binding was retrievable only from the newer snapshot, which satisfies the time-travel requirement for this round.

## Mixed Validation

Command:

```bash
pnpm ragit ingest --all
```

Observed output:
- `processed`: 8
- `skipped`: 31
- `commitSha`: `e70bea46596a15970e664ded2a137fa86824281e`
- `manifest`: `/Users/rhio/Works/my/ragit/.ragit/manifest/e70bea46596a15970e664ded2a137fa86824281e.json`
- `docs`: 8
- `chunks`: 38

Golden query result after mixed ingest:
- `Top-1`: 10 / 10
- `Top-3`: 10 / 10

## Noise Pattern Observations

1. Repository-wide mixed ingest did not reduce retrieval quality in this round.
2. The mixed snapshot still contained 8 indexed docs, which means the practical searchable corpus remained the typed test-bed set.
3. The `ingest --all` run skipped 31 repository files. In observed behavior, repository root documents and docs-site pages did not displace test-bed hits.
4. Query results are chunk-based, so the same file can appear multiple times in top-3 when multiple sections are relevant.

## Cleanup

Commands:

```bash
pnpm ragit hooks uninstall
pnpm ragit hooks status
```

Observed status after cleanup:
- `post-commit`: `absent`
- `post-merge`: `absent`

Hooks were removed after validation to prevent post-commit manifest churn during result documentation.

## Round-1 Assessment

Round-1 passed all planned acceptance thresholds.

- Isolated validation met and exceeded the target (`Top-1` 10/10, `Top-3` 10/10).
- Hook automation created a new manifest for the document-only validation commit.
- `query --at <sha>` reproduced different knowledge states across old and new snapshots.
- Mixed ingest kept all golden queries inside expected bounds.

## Next Improvement Targets

1. Expand repository-native document ingestion so mixed validation includes more than the dedicated typed corpus.
2. Add a harder noise test by typing additional repository documents outside `testbed/docs/`.
3. Add a repeatable golden-query evaluator script if round-2 will be rerun frequently.
