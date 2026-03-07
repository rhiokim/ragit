---
type: adr
---
# ADR-TESTBED-001: Adopt the local `pnpm ragit` runner

## Context

This repository is the first self-referential test bed for RAGit.
The local developer workflow should run the CLI without a global install.
Recent repository changes added a `pnpm ragit` script that executes `tsx src/cli.ts`.
Recent repository changes also made `pnpm build` optional for repository-local usage.

## Decision

RAGit local execution in this repository uses `pnpm ragit <command>` as the canonical runner.
`pnpm build` remains optional and is used only when `dist/` artifacts or packaged CLI validation are needed.

## Consequences

The round-1 test bed must use `pnpm ragit` in all operational commands.
Golden queries should explicitly confirm that RAGit can run locally without building `dist/`.
Setup guidance should explain that `pnpm build` is optional, not mandatory, for repository-local usage.
Hook validation should use a document-only commit so that post-commit indexing can be observed without unrelated markdown noise.
