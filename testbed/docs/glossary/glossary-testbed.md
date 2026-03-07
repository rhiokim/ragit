---
type: glossary
---
# Glossary

## Terms

- **control plane**: The `.ragit/` area that stores config, guide files, manifests, store, cache, and hooks.
- **isolated ingest**: An ingest run limited to `testbed/docs/**/*.md`.
- **mixed ingest**: An ingest run across the whole repository with `pnpm ragit ingest --all`.
- **manifest**: A snapshot index file stored at `.ragit/manifest/<commit-sha>.json`.
- **snapshot**: The commit-bound retrieval state used by `query` and `context pack`.
- **context pack**: A budget-limited collection of relevant retrieval hits prepared for an AI agent task.
- **hook validation**: Verification that `post-commit` automatically creates a new manifest after a document-only commit.
- **time-travel query**: A `query --at <sha>` call that reconstructs knowledge for an older commit state.
