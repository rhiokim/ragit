# Payload Patterns

Prefer structured payloads for reproducible agent calls.

## Input Rules

- Prefer `--input -` for generated payloads streamed from the agent.
- Prefer file-based `--input <path>` when the payload should be inspected or reused by humans.
- Do not mix `--input` with positional `question`, `goal`, `--top-k`, `--budget`, or `--at` when a command forbids that combination.

## `query`

```json
{
  "question": "restore auth context",
  "topK": 5,
  "at": "HEAD"
}
```

Recommended call:

```bash
ragit query --input - --view minimal --format json
```

## `context pack`

```json
{
  "goal": "implementation plan for auth",
  "budget": 1200,
  "at": "HEAD"
}
```

Recommended call:

```bash
ragit context pack --input - --view minimal --format json
```

## `memory wrap`

```json
{
  "goal": "finish auth migration",
  "summary": "Refined token refresh boundaries and left one open loop.",
  "constraints": [
    "Do not break snapshot contracts."
  ],
  "decisions": [
    {
      "id": "decision-auth-refresh-boundary",
      "title": "Keep refresh handling outside manifest mutation",
      "summary": "Separate live token refresh from snapshot writes."
    }
  ],
  "openLoops": [
    {
      "id": "loop-auth-refresh-tests",
      "title": "Update refresh adapter tests",
      "status": "open",
      "nextAction": "Patch adapter tests and rerun the suite"
    }
  ],
  "nextActions": [
    "Patch adapter tests",
    "Run pnpm test"
  ],
  "promotionCandidates": [],
  "sourceHeadSha": "HEAD"
}
```

Recommended sequence:

```bash
ragit memory wrap --input - --dry-run --format json
ragit memory wrap --input - --format json
```

## `memory promote`

```json
{
  "promotionCandidates": [
    {
      "kind": "decision",
      "title": "Keep refresh handling outside manifest mutation",
      "summary": "Separate live token refresh from snapshot writes.",
      "context": "Auth migration",
      "decision": "Refresh token logic stays outside manifest writes.",
      "consequences": [
        "Snapshot contracts remain stable during live auth updates."
      ]
    }
  ]
}
```

Recommended sequence:

```bash
ragit memory promote --input - --dry-run --format json
ragit memory promote --input - --format json
```

## `memory recall`

`memory recall` does not take JSON input today. Pass the goal positionally.

```bash
ragit memory recall "resume auth flow" --view minimal --format json
```
