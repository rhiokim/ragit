---
status: draft
source: inferred-from-repository
confidence: medium
last_generated_by: ragit init
---

# Ingestion Policy

## Include

- `README.md`
- `docs/**`
- `apps/**/README.md`
- `packages/**/README.md`

## Exclude

- `.git/**`
- `.ragit/**`
- `node_modules/**`
- `dist/**`
- `coverage/**`
- `.next/**`

## Notes

- Prefer stable human-authored docs as primary knowledge sources.
- Generated drafts remain indexable, but should not outrank validated repository docs.
