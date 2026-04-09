---
name: use-ragit
description: Operate RAGit safely in Codex and other AI agent workflows. Use when an agent needs to resolve the correct RAGit runtime, check repository readiness, choose between status/doctor/describe/query/context pack/memory recall/memory wrap/memory promote/ingest/hooks install, or execute RAGit with JSON output and dry-run discipline inside a project repository.
---

# Use RAGit

## Quick Start

Use this skill to run RAGit as an operational layer for agent workflows, not as a generic shell shortcut.
Keep the wrapper small, resolve the runtime first, and load the reference files only when the task needs them.

1. Run `node scripts/resolve-ragit-runtime.mjs --cwd <repo-or-subdir>` and parse the JSON result.
2. If `available` is `false`, stop and follow `installGuidance`.
3. Use the resolved `argv` to run `status --format json`.
4. If `status` fails because the repository is not initialized yet, propose `init --dry-run --output json` before any mutating memory or hook command.
5. If `status` succeeds but `searchReady` is `false`, treat the repository as initialized but not indexed yet. Use `ingest --dry-run` before retrieval-heavy commands such as `query` or `context pack`.
6. If the command is unfamiliar, read `describe <command> --format json` before using it.

## Operating Rules

- Prefer `--format json` for machine consumption.
- Prefer `--view minimal` for `query`, `context pack`, and `memory recall`.
- Prefer `--input <path|->` for structured payloads.
- Run `--dry-run` first for `ingest`, `hooks install`, `hooks uninstall`, `memory wrap`, and `memory promote`.
- Treat `doctor` as structured failure diagnosis, not as the default readiness check.
- Do not lead with `hooks install`. Use it only when the user explicitly wants automatic post-commit or post-merge ingest.
- Do not use `memory wrap` as a raw transcript dump.
- Do not use `memory promote` for unstable notes or scratch observations.

## Reference Files

- Read [references/command-routing.md](references/command-routing.md) for the intent-to-command matrix and readiness branches.
- Read [references/memory-discipline.md](references/memory-discipline.md) for working-memory versus durable-memory decisions.
- Read [references/payload-patterns.md](references/payload-patterns.md) for JSON payload shapes and `--input` usage patterns.
- Read [references/interop.md](references/interop.md) for Codex versus Claude/Gemini reuse rules.

## Runtime Resolver

Use `scripts/resolve-ragit-runtime.mjs` as the only runtime selector.
It returns the runner choice, argument vector, package-manager hint, repository root, version when it can be resolved safely, and install guidance when RAGit is unavailable.

Prefer the runner order encoded there:

1. `ragit` on PATH
2. `pnpm exec ragit` when the repository is a pnpm workspace and the local CLI is available
3. `bunx ragit` in Bun-oriented environments
4. `npx ragit` as a final fallback, with a network-fetch warning
