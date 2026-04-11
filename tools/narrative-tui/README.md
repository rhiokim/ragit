# Narrative TUI

Isolated Bun/OpenTUI viewer for sanitized `ragit narrative` models.

## Scope

- Input: `--model <path>` only
- Output: local interactive explorer
- Data source: sanitized JSON model exported by `ragit narrative --emit-model <path>`
- Boundary: no direct `.ragit` reads, no git reads, no root workspace coupling

## Usage

```bash
cd tools/narrative-tui
bun run src/index.ts --model fixtures/sample-model.json
```

## Smoke Test

```bash
cd tools/narrative-tui
bun run smoke
```
