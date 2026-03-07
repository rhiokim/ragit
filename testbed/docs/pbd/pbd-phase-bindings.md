---
type: pbd
---
# PBD: Phase and binding documents for round-1

## Implementation Scope

This PBD describes how the round-1 self-referential test bed moves through phases and how each phase binds to the next.

## What PBD Describes

The PBD describes the phase topology and binding structure of this project.
It explains how `init`, `ingest`, `query`, `context pack`, and hook automation connect to each other.

## Phase Topology

Phase 1 is baseline verification.
Phase 2 is `init` normalization of the `.ragit` control plane.
Phase 3 is isolated corpus materialization under `testbed/docs/`.
Phase 4 is isolated ingest and golden retrieval validation.
Phase 5 is hook validation through a document-only commit.
Phase 6 is time-travel validation with `query --at <sha>`.
Phase 7 is mixed ingest validation across the whole repository.

## Binding Map

`init` binds `AGENTS.md` to `.ragit/guide/guide-index.json`.
`ingest` binds documents to chunks and binds chunks to a manifest at a commit SHA.
`query` binds a user question to a specific snapshot.
`context pack` binds a goal to a selected subset of retrieval hits.
`post-commit` binds a new commit event to automatic incremental ingest.

## Interaction Paths

Git produces a commit.
RAGit observes the commit SHA.
RAGit indexes changed markdown knowledge.
RAGit returns commit-bound knowledge for queries and agent context.

## Failure and Drift Points

If `.ragit/**` is assumed to be searchable corpus, retrieval will fail because current ingest ignores `.ragit/**`.
If hook validation commits unrelated markdown changes, isolated validation noise increases.
If a manifest is missing for a target SHA, `query --at <sha>` cannot reconstruct that state.

## Mixed Ingest Binding

Mixed ingest binds the isolated `testbed/docs/` corpus to repository-wide markdown knowledge such as `README.md`, `llms.txt`, and the docs site content.
This binding is observed to measure whether repository noise displaces the intended top hits from the isolated baseline.

## Observability Notes

The most important observations are manifest count, top hit path, top-3 stability, and differences between isolated and mixed ingest.
