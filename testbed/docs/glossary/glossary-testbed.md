---
type: glossary
---
# Glossary

## Control Plane

The control plane is the `.ragit/` area that stores config, guide files, manifests, store, cache, and hooks.

## Isolated Ingest

Isolated ingest is an ingest run limited to `testbed/docs/**/*.md`.

## Mixed Ingest

Mixed ingest is an ingest run across the whole repository with `pnpm ragit ingest --all`.

## Manifest

A manifest in the round-1 test bed is a snapshot index file stored at `.ragit/manifest/<commit-sha>.json`.
The manifest binds documents and chunks to one commit SHA.

## Snapshot

A snapshot in the round-1 test bed is the commit-bound retrieval state used by `query` and `context pack`.
The snapshot answers what knowledge should be used at a specific commit.

## Context Pack

A context pack is a budget-limited collection of relevant retrieval hits prepared for an AI agent task.

## Hook Validation

Hook validation is verification that `post-commit` automatically creates a new manifest after a document-only commit.

## Time-Travel Query

A time-travel query is a `query --at <sha>` call that reconstructs knowledge for an older commit state.
