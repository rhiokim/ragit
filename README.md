# RAGit

RAGit is a **zvec + git bound RAG CLI** that runs inside your project repository.  
It collects, analyzes, and retrieves documents produced during AI agent workflows, then version-controls snapshots bound to commit SHAs.

## Product Purpose

RAGit is a local-first RAG CLI that turns AI agent project documents and context into commit-bound, reusable knowledge inside the repository.

## Core Value

- Preserve project context across AI agent work
- Reproduce knowledge at a specific commit state
- Turn structured docs into agent-ready inputs
- Automate indexing without adding workflow friction

## MVP Document Types (v0.1)

- ADR
- PRD
- SRS
- SPEC
- Plan
- DDD
- Glossary
- PBD

- `SRS`: system-level software requirements
- `SPEC`: implementation-level functional requirements and interface contracts
- `PBD`: phase and binding topology for understanding implementation structure and coupling

## Installation

Requirements:

- Node.js `20.19.0` or newer
- pnpm `10.13.1` or newer

```bash
pnpm install
pnpm build
pnpm exec ragit --help
```

## Documentation (Fumadocs + GitHub Pages)

- Primary URL (English): `https://rhiokim.github.io/ragit/en/`
- Korean URL: `https://rhiokim.github.io/ragit/ko/`
- English is the source of truth, and Korean is provided in the same structure.

Run locally:

```bash
pnpm docs:dev
```

Build static output and preview:

```bash
pnpm docs:check:i18n
pnpm docs:build
pnpm docs:serve
```

Deployment:

- GitHub Actions deploys automatically to `gh-pages` when `main` is pushed.
- For manual redeploy, run `docs-gh-pages` via `workflow_dispatch`.
- In Repository Settings > Pages, set Source to `gh-pages` / root(`/`).

## Core Commands

```bash
ragit init
ragit init --yes --output json
ragit init --yes --git-init
ragit config set retrieval.top_k 8
ragit hooks install
ragit ingest --all
ragit query "DDD bounded context principles" --format both
ragit context pack "Implementation plan for this sprint" --budget 1200
ragit migrate from-sqlitevss --dry-run
ragit status
ragit doctor
```

## Storage Layout

```text
.ragit/
  config.toml
  guide/guide-index.json
  guide/templates/
  manifest/<commit-sha>.json
  store/index.json
  cache/
  hooks/
```

- Recommended for Git tracking: `.ragit/config.toml`, `.ragit/manifest/**`
- Local-only (default `.gitignore`): `.ragit/store/**`, `.ragit/cache/**`

## Interactive `init` Guide

By default, `ragit init` runs a 6-step interactive wizard:

1. Check Git environment (suggest `git init` if not a repository)
2. Confirm initialization mode
3. Load or create root `AGENTS.md`
4. Confirm document template scope (ADR/PRD/SRS/SPEC/Plan/DDD/Glossary/PBD)
5. Incrementally generate `.ragit/guide` and refresh `guide-index.json`
6. Print summary table and next actions

Supported options:

```bash
ragit init --yes              # non-interactive with defaults
ragit init --non-interactive  # alias of --yes
ragit init --git-init         # allow git init in non-interactive mode
ragit init --output json      # JSON summary output
```

## Hook Strategy

- `post-commit`: automatically indexes changes from `HEAD~1..HEAD`
- `post-merge`: automatically indexes changes from `${ORIG_HEAD:-HEAD~1}..HEAD`
- Failures are warning-only and do not block commit/merge flows.

## Retrieval Strategy

- 1st pass: zvec embedding similarity
- 2nd pass: keyword score
- Final score: `alpha * vector + (1-alpha) * keyword` (default `alpha=0.7`)

## Security Defaults

- Secret masking is enabled by default during ingestion (`security.secret_masking=true`)
- OpenAI/GitHub/AWS keys and `api_key/token/secret` patterns are masked.

## Test

```bash
pnpm test
```
