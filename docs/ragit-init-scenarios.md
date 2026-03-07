# RAGit Init Scenarios

## Summary

This document fixes the user and system scenarios for `ragit init`.
`ragit init` is defined as a **guide/control-plane + zvec-store bootstrap command**, not a full RAG construction command.

Current behavior boundary:

- It checks Git state
- It loads or creates the root `AGENTS.md`
- It creates `.ragit/config.toml`
- It incrementally creates `.ragit/guide/templates/*`
- It writes `.ragit/guide/guide-index.json`
- It bootstraps empty zvec collections and writes `.ragit/store/meta.json`

It does **not**:

- discover repository documents
- chunk markdown content
- create manifests
- upsert chunk/document records into zvec
- create searchable knowledge

`storage.backend = "zvec"` now means the canonical backend, and `init` prepares an empty store without indexing repository documents.

## User Scenarios

### U1. New local bootstrap

**Preconditions**
- Current directory is not a Git repository
- No root `AGENTS.md`
- No usable `.ragit/` structure

**User goal**
- Prepare the repository for RAGit-guided documentation work

**Expected flow**
1. User runs `pnpm ragit init`
2. RAGit detects that Git is missing
3. Interactive mode proposes `git init`
4. RAGit creates `AGENTS.md`
5. RAGit creates `.ragit/config.toml`, guide templates, and `guide-index.json`
6. RAGit prints next actions for `hooks install` and `ingest`

**Expected outcome**
- The repository becomes control-plane ready and zvec-store ready
- Searchable knowledge is still absent

### U2. Existing Git repository with existing `AGENTS.md`

**Preconditions**
- Current directory is a Git repository
- Root `AGENTS.md` already exists

**User goal**
- Attach the RAGit standard guide structure without mutating the existing instruction file

**Expected flow**
1. User runs `pnpm ragit init`
2. RAGit loads `AGENTS.md` in read-only mode
3. RAGit creates only missing `.ragit` files
4. RAGit regenerates `guide-index.json`

**Expected outcome**
- Existing instructions remain unchanged
- Standard guide structure is incrementally added

### U3. Re-run on a partially initialized repository

**Preconditions**
- `.ragit/` exists
- Some templates or index files are missing

**User goal**
- Repair or complete the guide structure without destructive reset

**Expected flow**
1. User runs `pnpm ragit init`
2. Existing files are preserved
3. Missing templates are created
4. `guide-index.json` is refreshed

**Expected outcome**
- `init` behaves incrementally and idempotently

### U4. Non-interactive or CI initialization

**Preconditions**
- TTY is unavailable, or the caller intentionally uses `--yes`

**User goal**
- Prepare the same control-plane structure from automation

**Expected flow**
1. User runs `pnpm ragit init --yes`
2. If Git already exists, initialization proceeds
3. If Git does not exist, `--git-init` is required for automatic Git initialization
4. RAGit returns a table or JSON summary

**Expected outcome**
- CI can prepare guide/control-plane state
- Searchable knowledge still requires a later `ingest`

## System Scenario

### State Model

- `S0 Unprepared`
- `S1 Git Ready`
- `S2 Instruction Ready`
- `S3 Guide Ready`
- `S4 Init Complete (Guide + Zvec Store Ready)`

### Allowed Transitions

- `S0 -> S1`
  - Trigger: existing Git repository is detected, or `git init` is approved/executed
- `S1 -> S2`
  - Trigger: root `AGENTS.md` is loaded or created
- `S2 -> S3`
  - Trigger: guide templates are incrementally ensured, boundaries are parsed, and `guide-index.json` is written
- `S3 -> S4`
  - Trigger: zvec is initialized, collections are created/opened, and summary is returned

### Forbidden Transitions

- `S4 -> Index Ready`
- `S4 -> Search Ready`

Those states are outside `init` and belong to later commands such as `ragit ingest`.

## Inputs, Outputs, and Side Effects

### Inputs

- Working directory
- Interactive or non-interactive mode
- Optional `--git-init`
- Optional summary output format

### Outputs

- Summary table or JSON summary
- Next actions:
  - `ragit migrate from-json-store` (when legacy JSON store is detected)
  - `ragit hooks install`
  - `ragit ingest --all`

### Allowed Side Effects

- Create or update `.ragit/config.toml`
- Create or update `.ragit/guide/templates/*`
- Create or update `.ragit/guide/guide-index.json`
- Create or update `.ragit/store/meta.json`
- Create or open `.ragit/store/documents/` and `.ragit/store/chunks/`
- Create or load root `AGENTS.md`
- Update `.gitignore` for local-only `.ragit/store/` and `.ragit/cache/`

### Explicit Non-Effects

- No `.ragit/manifest/*` creation
- No zvec chunk/document record creation
- No document index records
- No repository-wide markdown traversal
- No repository knowledge embedding job

## Error and Boundary Paths

- Interactive mode without TTY
  - Result: fail immediately with guidance to use `--yes` or `--non-interactive`
- Non-interactive mode outside Git without `--git-init`
  - Result: fail immediately
- Interactive mode outside Git with `git init` declined
  - Result: abort initialization
- Existing `AGENTS.md`
  - Result: load only, do not mutate source content

## `init` vs `ingest`

`init` prepares the control plane.
`ingest` prepares searchable knowledge.

Operational sequence:

1. `pnpm ragit init`
2. `pnpm ragit hooks install`
3. `pnpm ragit ingest --all`

Interpretation rule:

- After `init`, the repository is **guide-ready + zvec-store-ready**
- After `ingest`, the repository becomes **search-ready**
