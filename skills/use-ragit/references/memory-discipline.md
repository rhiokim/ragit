# Memory Discipline

Use this file to decide when to use `memory recall`, `memory wrap`, and `memory promote`.

## Memory Surfaces

- `.ragit/memory/**` is the control plane for working state and session history.
- `docs/memory/**` is the searchable long-term memory corpus that joins normal ingest and retrieval.

Do not treat them as interchangeable.

## Prefer `memory recall` For Active Work

Choose `memory recall` when the user wants to resume a task, reopen open loops, restore constraints, or reconstruct the next useful packet for an in-progress goal.

Prefer:

```bash
ragit memory recall "resume auth flow" --view minimal --format json
```

Use `query` instead when the user only wants snapshot-scoped retrieval with no working-memory continuity.

## Allow `memory wrap` Only For Deliberate Session State

Use `memory wrap` only when the payload contains a real execution handoff:

- `goal`
- `summary`
- `constraints`
- `decisions`
- `openLoops`
- `nextActions`

Do not use `memory wrap` as a transcript dump, scratchpad save, or "just in case" write.

Run `--dry-run` first:

```bash
ragit memory wrap --input - --dry-run --format json
```

## Allow `memory promote` Only For Stable Knowledge

Use `memory promote` only when the knowledge should become durable and searchable in future sessions without reopening the original session history.

Current promotion kinds are:

- `decision`
- `glossary`
- `plan`

Do not promote speculative notes, temporary debugging observations, or unvalidated ideas.

Run `--dry-run` first:

```bash
ragit memory promote --input - --dry-run --format json
```

## Practical Selection Rules

- Continue active work: `memory recall`
- Preserve current continuity for later: `memory wrap`
- Crystallize stable knowledge for future retrieval: `memory promote`
- Search the indexed corpus only: `query`
- Build a token-bounded packet for the next agent step: `context pack`
