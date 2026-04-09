# Interop

Use this file to keep the RAGit operating model consistent across Codex, Claude, and Gemini.

## Shared Principle

The command-routing rules, readiness checks, dry-run discipline, and memory discipline are agent-neutral.
Only the wrapper surface changes between products.

## Codex

- Use `SKILL.md` and `agents/openai.yaml`.
- Run `scripts/resolve-ragit-runtime.mjs` before any RAGit command.
- Load the other reference files only when needed.

## Claude And Gemini

Do not create a separate installable skill pack in v1.
Instead, reuse the same reference files from project-level instructions such as:

- `AGENTS.md`
- `CLAUDE.md`
- `GEMINI.md`

Point those instructions at:

- `skills/use-ragit/references/command-routing.md`
- `skills/use-ragit/references/memory-discipline.md`
- `skills/use-ragit/references/payload-patterns.md`
- `skills/use-ragit/references/interop.md`

## Minimal Cross-Agent Contract

Keep these behaviors identical across agent products:

- Resolve runtime first.
- Use `status --format json` as the default readiness check.
- Use `describe <command> --format json` before first-time command integration.
- Prefer `--view minimal` for `query`, `context pack`, and `memory recall`.
- Run `--dry-run` before mutating commands.
- Treat `hooks install` as optional automation, not as the core workflow.

## What Not To Fork

Do not create agent-specific copies of the command-routing or memory-discipline rules unless the public RAGit CLI contract changes.
Differences should stay in metadata, trigger wording, and product-specific wrapper instructions.
