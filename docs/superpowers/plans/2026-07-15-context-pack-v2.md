# Context Pack v2 Implementation Plan

**Design:** `docs/superpowers/specs/2026-07-15-context-pack-v2-design.md`
**Branch:** `feat/context-pack-v2`
**Base:** `origin/main` at `4633ba5`
**Executor:** Terra, one task at a time
**Reviewer/integrator:** Sol Max

## Success Criteria

1. Exact citation duplicates are removed deterministically.
2. Distinct source families are selected before repeated-source fill when they fit.
3. `usedTokens <= budget` always; no first-hit overflow.
4. Context Pack exposes additive, internally consistent selection telemetry.
5. Raw retrieval scores and ranked paths remain unchanged.
6. Full test, benchmark, build, package, and docs gates pass.

## Task 1 — Implement the Pure Selector

**Files**

- Create: `src/core/context-selection.ts`
- Create: `test/context-selection.test.ts`

### Red tests

Add fixtures that construct complete `RetrievalHit` values with stable citations. Cover:

- citation dedupe keeps first occurrence;
- document paths, artifact IDs, and evidence source IDs form the expected source families;
- the diversity pass chooses `A1, B1, C1` before `A2`;
- the fill pass then chooses remaining ranked hits that fit;
- an oversized first hit is skipped;
- a later smaller hit can fit;
- repeated calls are deep-equal;
- inputs are not mutated;
- summary equations and strict budget invariant hold.

Run:

```bash
pnpm exec vitest run test/context-selection.test.ts --reporter=dot
```

Expected: fail because the module does not exist.

### Minimal implementation

Implement:

- `countContextTokens(text)`;
- `contextSourceFamily(hit)`;
- `selectContextHits(hits, budget)`;
- the approved summary and result types.

Validate a positive safe-integer budget. Preserve incoming order and object identity; do not mutate or rescore hits.

### Green and commit

```bash
pnpm exec vitest run test/context-selection.test.ts test/retrieval.test.ts test/retrieval-explanation.test.ts --reporter=dot
git diff --check
git status --short
git add src/core/context-selection.ts test/context-selection.test.ts
git commit -m "feat(context): select citation-diverse packets"
```

Stop for Sol Max review.

## Task 2 — Integrate Selection and Integer Budget Contracts

**Files**

- Modify: `src/core/context.ts`
- Modify: `src/core/retrieval.ts`
- Modify: `src/core/commandInputs.ts`
- Modify: `src/core/commandRegistry.ts`
- Modify: `src/cli.ts`
- Modify: `test/cli.contract.test.ts`
- Modify: `test/cli-hardening.test.ts`

### Red tests

Cover:

- Context Pack result includes `selection.strategy === "citation-diverse-v2"`;
- summary counters satisfy the design equations;
- citations remain present and score breakdowns remain absent;
- text output includes strategy, candidate, unique-citation, selected-source, duplicate, and budget-rejected counts;
- raw JSON and positional fractional budgets are rejected;
- no-fit budget returns an empty packet plus the approved warning;
- existing snapshot metadata and warning projection remain unchanged.

Run the focused tests and record the failing assertions.

### Minimal implementation

- Replace the old selector call with `selectContextHits`.
- Add the required `selection` field to `ContextPackResult` and its projection.
- Append the no-fit warning only when retrieval returned candidates and selection returned no hits.
- Add context-specific positive-safe-integer parsers; do not change number semantics for unrelated commands.
- Update `context pack` command metadata and output schema summary.
- Remove the now-unused `selectHitsWithinBudget` function from `retrieval.ts`; do not touch any other retrieval behavior.

Do not add a flag, change `topK`, expose score breakdowns, or alter scopes.

### Green and commit

```bash
pnpm exec vitest run test/context-selection.test.ts test/cli.contract.test.ts test/cli-hardening.test.ts test/cli.snapshot-contract.test.ts test/output.test.ts --reporter=dot
git diff --check
git status --short
git add src/core/context.ts src/core/retrieval.ts src/core/commandInputs.ts src/core/commandRegistry.ts src/cli.ts test/cli.contract.test.ts test/cli-hardening.test.ts
git commit -m "feat(context): expose v2 packing telemetry"
```

Stop for Sol Max review.

## Task 3 — Document the Stable Contract

**Files**

- Modify: `README.md`
- Modify: `apps/docs/content/docs/en/commands/context/pack.mdx`
- Modify: `apps/docs/content/docs/ko/commands/context/pack.mdx`
- Modify only additional reference pages directly required by docs checks

Document:

- two-pass selection order;
- citation dedupe and source-family definitions;
- strict whole-hit budget behavior;
- integer budget requirement;
- content-unit limitation;
- empty-packet warning;
- additive selection fields;
- unchanged snapshot, scope, masking, and view contracts.

Run:

```bash
pnpm docs:build
pnpm docs:check:commands
pnpm docs:check:internal-links
pnpm docs:check:i18n
pnpm docs:check:search-index
git diff --check
git status --short
git add README.md apps/docs/content/docs
git commit -m "docs(context): explain v2 packet selection"
```

Stop for Sol Max review.

## Task 4 — Independent Parent Verification

Sol Max cherry-picks only approved commits, then runs sequentially:

```bash
pnpm exec vitest run \
  test/context-selection.test.ts \
  test/retrieval.test.ts \
  test/retrieval-explanation.test.ts \
  test/cli.contract.test.ts \
  test/cli-hardening.test.ts \
  test/cli.snapshot-contract.test.ts \
  test/output.test.ts \
  --reporter=dot

pnpm benchmark:retrieval:verify --output /tmp/ragit-retrieval-b3-parent.json
pnpm test
pnpm build
pnpm build:verify
pnpm pack:verify
pnpm pack:smoke
pnpm docs:build
pnpm docs:check:commands
pnpm docs:check:internal-links
pnpm docs:check:i18n
pnpm docs:check:search-index
```

Compare the B3 report to the accepted B1/B2 report:

- aggregate quality metrics equal;
- clean/noisy metrics equal;
- all 108 `rankedPaths` arrays equal;
- p95 remains below the approved threshold.

Final audit:

```bash
git diff --check origin/main...HEAD
git diff origin/main...HEAD -- \
  package.json \
  pnpm-lock.yaml \
  benchmarks/retrieval/v1/thresholds.json \
  src/core/embedding.ts \
  src/core/zvec.ts
git status --short --branch
```

## Task 5 — PR and Merge

- Push `feat/context-pack-v2`.
- Create a focused PR describing the selector, strict budget change, compatibility, exact benchmark comparison, and all verification results.
- Merge only when the PR is mergeable and every configured check is green.
- Delete the remote feature branch.
- Fetch `origin/main` and verify the rebase-merged tree is byte-identical to the reviewed branch.

## Prohibited Scope

Reject any change to:

- retrieval weights or candidate limits;
- B1 dataset or thresholds;
- embedding profiles, cache behavior, or provider evidence;
- zvec support matrix;
- MCP;
- package version, release notes, or publish workflow;
- unrelated formatting or refactors.
