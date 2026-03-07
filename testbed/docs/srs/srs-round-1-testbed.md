---
type: srs
---
# SRS: Round-1 self-referential test bed requirements

## Functional Requirements

FR-001: The test bed must start from `pnpm ragit init --yes --output json`.
FR-002: The test bed must create eight test documents, one per supported document type.
FR-003: The isolated ingest phase must use `pnpm ragit ingest --files "testbed/docs/**/*.md"`.
FR-004: The test bed must validate `query`, `context pack`, `hooks install`, and `query --at <sha>`.
FR-005: The test bed must record results in a round-1 report document.

## Non-Functional Requirements

NFR-001: The test corpus must use only facts already present in this repository.
NFR-002: The control plane stays in `.ragit/`, while searchable corpus stays outside `.ragit/`.
NFR-003: Golden queries should be specific enough to be checked repeatedly across isolated and mixed ingest runs.
