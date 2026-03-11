# RAGit Init Scenarios

## Summary

This document fixes the current product boundary for `ragit init`.
`ragit init` is a **discover-first bootstrap command**: it inspects repository state, reuses existing knowledge sources, fills only missing foundations, and then prepares the control plane and canonical zvec store.

Current stage-1 behavior:

- checks Git state and normalizes nested paths to the repository root
- scans repository code/docs/build files
- selects `empty`, `existing`, `docs-heavy`, or `monorepo` mode
- runs documentation census, coverage scoring, maturity scoring, and knowledge-slot mapping
- plans missing foundational docs and reuses existing sources when possible
- writes only the missing foundational docs for stage 1:
  - `RAGIT.md`
  - `docs/workspace-map.md`
  - `docs/ragit/ingestion-policy.md`
  - `docs/known-gaps.md`
  - `docs/adr/README.md`
- writes `.ragit/config.toml`, `.ragit/guide/templates/*`, `.ragit/guide/guide-index.json`
- bootstraps empty zvec collections and writes `.ragit/store/meta.json`

It still does **not**:

- chunk repository documents into queryable records
- create snapshot manifests
- upsert document/chunk records into zvec
- make the repository search-ready
- introduce separate `adopt`, `map`, or `sync` commands

The key interpretation rule is:

- `init` may read and classify repository documents
- only `ingest` turns repository documents into searchable knowledge

## User Scenarios

### U1. Empty repository bootstrap

**Preconditions**
- Current directory is not a Git repository, or is a fresh repository with almost no code/docs
- No root `AGENTS.md`
- No usable `.ragit/` structure

**User goal**
- Bootstrap a foundational knowledge operating system from almost nothing

**Expected flow**
1. User runs `pnpm ragit init --yes --git-init`
2. RAGit initializes Git if needed
3. RAGit scans the repository and classifies it as `empty`
4. RAGit plans the foundational draft docs
5. RAGit writes the missing docs plus `.ragit/**`, `AGENTS.md`, guide assets, and empty zvec store
6. RAGit returns summary + next actions

**Expected outcome**
- The repository becomes control-plane ready and zvec-store ready
- Foundational docs are present as drafts
- Searchable knowledge is still absent

### U2. Existing codebase adoption

**Preconditions**
- Current directory is a Git repository with source code and some existing docs

**User goal**
- Reuse existing repository intent and fill only missing foundations

**Expected flow**
1. User runs `pnpm ragit init`
2. RAGit scans repository structure and classifies it as `existing`
3. RAGit reuses primary sources like `README.md`, `CONTRIBUTING.md`, and architecture docs
4. RAGit generates only missing stage-1 foundational docs
5. RAGit bootstraps `.ragit/**`, guide index, and zvec store

**Expected outcome**
- Existing docs are not overwritten
- Generated drafts are additive and clearly marked as inferred

### U3. Docs-heavy repository adoption

**Preconditions**
- Repository already contains substantial docs such as `docs/`, `adr/`, architecture docs, or glossary material

**User goal**
- Build a machine-readable knowledge map without drowning the repository in duplicate templates

**Expected flow**
1. User runs `pnpm ragit init`
2. RAGit classifies the repository as `docs-heavy`
3. Coverage and maturity are computed from existing documentation
4. Only missing foundational docs are created, often fewer than in other modes
5. Guide/bootstrap steps run normally

**Expected outcome**
- Existing docs dominate as source of truth
- Generated file count stays low

### U4. Monorepo adoption

**Preconditions**
- Repository contains workspace markers such as `pnpm-workspace.yaml`, `turbo.json`, `apps/*`, or `packages/*`

**User goal**
- Establish root-level guidance while acknowledging app/package boundaries

**Expected flow**
1. User runs `pnpm ragit init`
2. RAGit classifies the repository as `monorepo`
3. Apps/packages/workspace files are mapped into the workspace slot
4. `docs/workspace-map.md` is created when needed
5. Control-plane and zvec bootstrap complete

**Expected outcome**
- Root-level bootstrap remains centralized
- Workspace structure becomes explicit for agents

### U5. Dry-run / CI planning

**Preconditions**
- Caller wants a plan without mutations

**User goal**
- Preview scan, mode, coverage, and planned files before writing

**Expected flow**
1. User runs `pnpm ragit init --dry-run --output json`
2. RAGit performs repository analysis and gap-fill planning
3. RAGit reports planned control-plane/bootstrap outcomes without writing files

**Expected outcome**
- No file system changes
- Full initialization report is still available

## System Scenario

### State Model

- `S0 Unprepared`
- `S1 Git Ready`
- `S2 Repository Diagnosed`
- `S3 Foundations Planned`
- `S4 Control Plane Ready`
- `S5 Init Complete (Control Plane + Zvec Store Ready)`

### Allowed Transitions

- `S0 -> S1`
  - Trigger: existing Git repository is detected, or `git init` is approved/executed
- `S1 -> S2`
  - Trigger: repository scan, mode selection, documentation census, coverage, maturity, and knowledge mapping complete
- `S2 -> S3`
  - Trigger: gap-fill plan is computed
- `S3 -> S4`
  - Trigger: stage-1 draft docs, `.ragit/config.toml`, guide assets, and `AGENTS.md` are written
- `S4 -> S5`
  - Trigger: empty zvec store is created/opened and summary is returned

### Forbidden Transitions

- `S5 -> Index Ready`
- `S5 -> Search Ready`

Those states still belong to `ragit ingest`.

## Inputs, Outputs, and Side Effects

### Inputs

- Working directory
- Interactive or non-interactive mode
- Optional `--git-init`
- Optional `--mode auto|empty|existing|monorepo|docs-heavy`
- Optional `--strategy minimal|balanced|full`
- Optional `--dry-run`
- Optional `--merge-existing`
- Optional summary output format

### Outputs

- Summary table or JSON summary
- JSON keys:
  - `executionMode`
  - `repositoryMode`
  - `strategy`
  - `scan`
  - `coverage`
  - `maturity`
  - `knowledgeMap`
  - `actions`
  - `bootstrap`
  - `nextActions`

### Allowed Side Effects

- Create or update `RAGIT.md`
- Create or update `docs/workspace-map.md`
- Create or update `docs/ragit/ingestion-policy.md`
- Create or update `docs/known-gaps.md`
- Create or update `docs/adr/README.md`
- Create or update `.ragit/config.toml`
- Create or update `.ragit/guide/templates/*`
- Create or update `.ragit/guide/guide-index.json`
- Create or update `.ragit/store/meta.json`
- Create or open `.ragit/store/documents/` and `.ragit/store/chunks/`
- Create or load root `AGENTS.md`
- Update `.gitignore` for local-only `.ragit/store/` and `.ragit/cache/`

### Explicit Non-Effects

- No `.ragit/manifest/*` creation
- No zvec document/chunk record creation
- No query-ready knowledge state
- No repository-wide embedding job
- No `map`, `sync`, or `adopt` command rollout in stage 1

## Error and Boundary Paths

- Interactive mode without TTY
  - Result: fail immediately with guidance to use `--yes` or `--non-interactive`
- Non-interactive mode outside Git without `--git-init`
  - Result: fail immediately
- Interactive mode outside Git with `git init` declined
  - Result: abort initialization
- Existing source docs
  - Result: reused as first-class inputs and not overwritten during stage 1
- `--dry-run`
  - Result: no mutations, but full analysis and planned actions are returned

## `init` vs `ingest`

`init` prepares the repository operating model.
`ingest` prepares searchable knowledge.

Operational sequence:

1. `pnpm ragit init`
2. `pnpm ragit hooks install`
3. `pnpm ragit ingest --all`

Interpretation rule:

- After `init`, the repository is **diagnosed + foundation-ready + zvec-store-ready**
- After `ingest`, the repository becomes **search-ready**
