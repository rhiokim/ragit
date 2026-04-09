# Command Routing

Use this file to map agent intent to the correct RAGit command.

## Default Entry Sequence

1. Run `node scripts/resolve-ragit-runtime.mjs --cwd <repo-or-subdir>`.
2. Run `<resolved argv> status --format json`.
3. If the target command is unfamiliar, run `<resolved argv> describe <command> --format json`.
4. Use the routing table below.

## Readiness Branches

- If `status` fails because the repository has no usable RAGit state yet, propose `init --dry-run --output json`.
- If `status` succeeds and `data.zvec.searchReady` is `false`, treat the repository as initialized but not indexed yet.
- If retrieval is required while `searchReady` is `false`, run `ingest --dry-run` before `query` or `context pack`.
- If only working-memory continuity is required, `memory recall` can still be useful even when snapshot retrieval is empty.

## Intent-To-Command Matrix

| Intent | Command | Default shape | Notes |
| --- | --- | --- | --- |
| Check current readiness | `status` | `status --format json` | Default first command after runtime resolution |
| Diagnose structural failure | `doctor` | `doctor --format json` | Use only after failure; it may exit non-zero |
| Read contract for an unfamiliar command | `describe` | `describe <command> --format json` | Use before first-time integration |
| Inspect raw retrieval hits | `query` | `query --input - --view minimal --format json` | Prefer when the user wants search results, not a prompt packet |
| Build a bounded packet for another agent step | `context pack` | `context pack --input - --view minimal --format json` | Prefer over `query` when the next consumer is an agent prompt |
| Resume active work | `memory recall` | `memory recall "<goal>" --view minimal --format json` | Prefer over `query` when working memory exists |
| Save current session continuity | `memory wrap` | `memory wrap --input - --dry-run --format json` | Re-run without `--dry-run` only after the payload is validated |
| Promote stable knowledge | `memory promote` | `memory promote --input - --dry-run --format json` | Re-run without `--dry-run` only for stable knowledge |
| Reindex current repository knowledge | `ingest` | `ingest --dry-run --format json` | Choose `--all`, `--since`, or `--input` based on scope |
| Enable automatic post-commit or post-merge ingest | `hooks install` | `hooks install --dry-run --format json` | Only when the user explicitly asks for automatic ingest hooks |

## Priority Rules

- Prefer `memory recall` over `query` when the task is "continue what I was doing".
- Prefer `context pack` over `query` when the next consumer is another agent prompt or handoff.
- Do not route to `doctor` just to learn current state. Use `status` first.
- Do not route to `hooks install` unless automation is explicitly requested.
- Do not route to mutating commands before their `--dry-run` succeeds.
