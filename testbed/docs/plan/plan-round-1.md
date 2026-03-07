---
type: plan
---
# Plan: Round-1 self-referential execution

## Milestones

M1. Normalize `.ragit/` with `pnpm ragit init`.
M2. Materialize the isolated test corpus under `testbed/docs/`.
M3. Run isolated ingest and golden queries.
M4. Validate hook automation and commit-bound time travel.
M5. Run mixed ingest and publish the round-1 report.

## Work Breakdown

Task 1. Verify baseline with `pnpm test` and `pnpm ragit --help`.
Task 2. Create eight documents and a golden query file.
Task 3. Run isolated validation and capture acceptance metrics.
Task 4. Run hook validation with a single-document commit.
Task 5. Run time-travel validation with `--at <sha>`.
Task 6. Run mixed validation and summarize noise patterns.
