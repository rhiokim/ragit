---
type: spec
---
# SPEC: Round-1 execution contract

## Scope

This specification defines the execution contract for the first RAGit self-referential test bed.
It covers initialization, isolated ingest, golden query validation, hook validation, time-travel validation, and mixed ingest validation.

## Functional Requirements

The round-1 operator runs RAGit locally with `pnpm ragit`.
The round-1 operator does not require `pnpm build` for repository-local usage.
The isolated ingest command is `pnpm ragit ingest --files "testbed/docs/**/*.md"`.
The mixed ingest command is `pnpm ragit ingest --all`.

## Interfaces and Contracts

The isolated test corpus lives under `testbed/docs/`.
The control plane lives under `.ragit/`.
`.ragit` is not itself a searchable document source because the current ingest implementation ignores `.ragit/**`.

## State and Flow

State A is the baseline test-bed corpus commit.
State B is the hook validation commit with a meaningful document update.
State C is the time-travel validation commit with a second meaningful document update.
Queries without `--at` use the latest available snapshot.
Queries with `--at <sha>` must reproduce the knowledge state of the referenced commit.

## Acceptance Criteria

- At least 8 of 10 golden queries return the expected top-1 hit during isolated validation.
- All 10 golden queries return the expected answer within top-3 during isolated validation.
- Mixed validation keeps at least 7 of 10 golden queries within top-3.
