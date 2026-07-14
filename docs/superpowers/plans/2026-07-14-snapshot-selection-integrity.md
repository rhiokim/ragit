# Snapshot Selection Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every retrieval and incremental-ingest operation use only the exact, validated snapshot that belongs to the requested Git commit, with explicit degraded recall and stable machine-readable failures when that proof is unavailable.

**Architecture:** Add a small typed operational-error layer, extend Git and manifest primitives, and centralize read-side and ingest-base policy in `src/core/snapshot.ts`. Retrieval, recall, ingest, status, and CLI projection consume that shared policy. Individual manifest publication becomes atomic, while store transactions and exclusive ingest locking remain deferred.

**Tech Stack:** Node.js 20.19+, TypeScript 5.9, Commander 14, Vitest 4, pnpm 10, Git CLI, zvec 0.2.1.

## Global Constraints

- Implement only the approved design in `docs/superpowers/specs/2026-07-14-snapshot-selection-integrity-design.md`.
- Never select a lexicographically latest manifest for retrieval or as an incremental-ingest base.
- Preserve `snapshotSha` and string `warnings`; add `snapshot` and `error` fields without renaming existing fields.
- Keep `latestSnapshotSha` only for existing diagnostic consumers such as drift and security. Retrieval and ingest must not import or call it.
- Keep `ingest` with no selector equivalent to `ingest --all` for current CLI compatibility.
- Treat a detached HEAD as `branch: null` and `detached: true`. Treat a repository without a commit as `headSha: null`; strict retrieval reports `SNAPSHOT_NOT_INDEXED`, while `status` remains successful and diagnostic.
- JSON failures go to stdout, text failures go to stderr, and `both` emits text to stderr plus JSON to stdout. All formats use the same exit code.
- Do not add branch, tag, or arbitrary revision-expression support to `query --at`. Only `HEAD`, a full commit SHA, and a unique hexadecimal commit prefix are accepted.
- Do not bump the package version or publish a release in this workstream.
- Do not add ingest locks, store transactions, cross-worktree state sharing, orphan cleanup, or an uncommitted-content retrieval overlay.
- Every implementation task starts with a failing test, makes the smallest production change that passes it, reruns the focused test, and commits only the files named by that task.

---

## File and Responsibility Map

| File | Responsibility in this workstream |
| --- | --- |
| `src/core/errors.ts` | Stable operational error codes, categories, retryability, recovery metadata, and exit-code mapping. |
| `src/core/git.ts` | Worktree-root facts, commit SHA normalization, ancestry, parent lookup, commit ranges, and dirty paths relative to HEAD. |
| `src/core/manifest.ts` | Exact catalog operations, runtime validation, legacy normalization, future-version rejection, and atomic publication. |
| `src/core/snapshot.ts` | Repository context, exact read-side selector, nearest-ancestor diagnostics, ingest-base selector, and shared snapshot output metadata. |
| `src/core/retrieval.ts` | Strict selection and store validation before embedding; no latest-manifest fallback. |
| `src/core/context.ts` | Additive snapshot projection for context packets. |
| `src/core/memory.ts`, `src/core/memoryTypes.ts` | Explicit keyword-only degraded recall and commit-before-ingest promotion behavior. |
| `src/core/ingest.ts` | Exact base selection, relevant dirty-candidate admission, and dry-run failure preview. |
| `src/core/harness.ts` | Stop automatic ingest of newly created, uncommitted promotion documents. |
| `src/commands/bootstrap.ts` | Repository-root normalization and current-HEAD snapshot diagnostics in status. |
| `src/core/cliContract.ts`, `src/cli.ts` | Additive failure envelope, text/JSON error projection, root cwd output, and stable process exit codes. |
| `src/core/commandRegistry.ts` | Describe the additive snapshot and ingest failure fields. |
| `src/commands/hooks.ts` | Resolve hook bases to full SHAs before invoking `ingest --since`. |
| `test/snapshot.test.ts` | Pure selector and error-policy tests with fake adapters. |
| `test/snapshot.integration.test.ts` | Real Git repository, branch, worktree, detached HEAD, prefix, and dirty-state tests. |
| Existing focused tests | Manifest, retrieval, context, recall, ingest, status, CLI, promotion, and legacy-contract regression coverage. |
| `scripts/smoke-packed-cli.mjs` | Installed-tarball strict branch-isolation flow. |
| `scripts/benchmark-snapshot-selection.ts`, `package.json` | Reference local p95 selection benchmark with 1,000 manifests. |
| English and Korean docs plus `README.md` | Commit-before-ingest onboarding, strict selection, degraded recall, status, and error recovery. |

## Execution Preflight

- [ ] Confirm this isolated worktree points at the approved design commit:

  ```bash
  git rev-parse --short HEAD
  ```

  Expected: `0d7ebdb` or a descendant containing that commit.

- [ ] Create the implementation branch before making commits because the planning worktree currently has a detached HEAD:

  ```bash
  git switch -c feat/snapshot-selection-integrity
  ```

  Expected: `Switched to a new branch 'feat/snapshot-selection-integrity'`.

- [ ] Commit this plan separately so subsequent task commits remain surgical:

  ```bash
  git add docs/superpowers/plans/2026-07-14-snapshot-selection-integrity.md
  git commit -m "docs(plan): add snapshot selection implementation plan"
  ```

- [ ] Install the locked dependencies and capture the baseline:

  ```bash
  pnpm install --frozen-lockfile
  pnpm test
  pnpm build
  ```

  Expected: all existing tests pass and the TypeScript build succeeds before production changes begin. If the baseline fails, record the pre-existing failure and stop rather than weakening a test.

---

## Task 1: Add the Typed Operational Error Contract

**Files:**

- Create: `src/core/errors.ts`
- Create: `test/errors.test.ts`

**Interfaces and invariants:**

```ts
export type RagitErrorCategory = "invalid_input" | "not_ready" | "corrupt_or_incompatible" | "transient";

export type RagitErrorCode =
  | "SNAPSHOT_REF_INVALID"
  | "SNAPSHOT_REF_AMBIGUOUS"
  | "SNAPSHOT_NOT_INDEXED"
  | "SNAPSHOT_MANIFEST_INVALID"
  | "SNAPSHOT_SCHEMA_UNSUPPORTED"
  | "SNAPSHOT_STORE_UNAVAILABLE"
  | "INGEST_BASE_NOT_INDEXED"
  | "INGEST_BASE_NOT_ANCESTOR"
  | "INGEST_CANDIDATES_DIRTY"
  | "REPOSITORY_STATE_CHANGED";

export interface RagitRecovery {
  command: string;
}

export interface RagitErrorPayload {
  code: RagitErrorCode;
  category: RagitErrorCategory;
  message: string;
  retryable: boolean;
  details: Record<string, unknown>;
  recovery: RagitRecovery;
}
```

Use this single definition table so category and exit status cannot drift:

```ts
export const RAGIT_ERROR_DEFINITIONS = {
  SNAPSHOT_REF_INVALID: { category: "invalid_input", exitCode: 2, retryable: false },
  SNAPSHOT_REF_AMBIGUOUS: { category: "invalid_input", exitCode: 2, retryable: false },
  SNAPSHOT_NOT_INDEXED: { category: "not_ready", exitCode: 3, retryable: false },
  SNAPSHOT_MANIFEST_INVALID: { category: "corrupt_or_incompatible", exitCode: 4, retryable: false },
  SNAPSHOT_SCHEMA_UNSUPPORTED: { category: "corrupt_or_incompatible", exitCode: 4, retryable: false },
  SNAPSHOT_STORE_UNAVAILABLE: { category: "not_ready", exitCode: 3, retryable: false },
  INGEST_BASE_NOT_INDEXED: { category: "not_ready", exitCode: 3, retryable: false },
  INGEST_BASE_NOT_ANCESTOR: { category: "invalid_input", exitCode: 2, retryable: false },
  INGEST_CANDIDATES_DIRTY: { category: "not_ready", exitCode: 3, retryable: false },
  REPOSITORY_STATE_CHANGED: { category: "transient", exitCode: 3, retryable: true },
} as const satisfies Record<RagitErrorCode, {
  category: RagitErrorCategory;
  exitCode: 2 | 3 | 4;
  retryable: boolean;
}>;
```

`RagitOperationalError` must expose `code`, `category`, `exitCode`, `retryable`, `details`, and `recovery`, preserve the original error as `cause` when supplied, and provide a `toPayload()` method returning `RagitErrorPayload`. Every operational error construction must supply one concrete recovery command. Do not classify unexpected errors as an operational error; the existing unexpected-error path remains exit `1`.

### Steps

- [ ] Write `test/errors.test.ts` with one table-driven assertion per code:

  ```ts
  import { describe, expect, it } from "vitest";
  import { RAGIT_ERROR_DEFINITIONS, RagitOperationalError } from "../src/core/errors.js";

  describe("RagitOperationalError", () => {
    it.each(Object.entries(RAGIT_ERROR_DEFINITIONS))(
      "keeps %s metadata stable",
      (code, definition) => {
        const error = new RagitOperationalError(
          code as keyof typeof RAGIT_ERROR_DEFINITIONS,
          "failure",
          { details: { ref: "abc123" }, recovery: { command: "ragit status" } },
        );
        expect(error.exitCode).toBe(definition.exitCode);
        expect(error.toPayload()).toMatchObject({
          code,
          category: definition.category,
          retryable: definition.retryable,
          details: { ref: "abc123" },
          recovery: { command: "ragit status" },
        });
      },
    );
  });
  ```

- [ ] Run the focused test and confirm it fails because the module does not exist:

  ```bash
  pnpm test -- test/errors.test.ts
  ```

- [ ] Implement `src/core/errors.ts` with the exact definitions above, the error class, and an `isRagitOperationalError(value: unknown)` type guard.
- [ ] Rerun the focused test:

  ```bash
  pnpm test -- test/errors.test.ts
  ```

  Expected: `test/errors.test.ts` passes.

- [ ] Commit only the new error contract and its test:

  ```bash
  git add src/core/errors.ts test/errors.test.ts
  git commit -m "feat(core): add typed operational errors"
  ```

---

## Task 2: Resolve Repository and Git Commit Context Exactly

**Files:**

- Modify: `src/core/git.ts`
- Modify: `src/commands/bootstrap.ts`
- Modify: `src/cli.ts`
- Create: `test/git-context.integration.test.ts`
- Modify: `test/cli.contract.test.ts`

**Interfaces:**

```ts
export interface GitDirtyPath {
  path: string;
  state: "modified" | "deleted" | "untracked";
}

export const getHeadShaIfExists: (cwd: string) => Promise<string | null>;
export const getCurrentBranch: (cwd: string) => Promise<string | null>;
export const resolveCommitSha: (cwd: string, ref: string) => Promise<string>;
export const getParentShaForCommit: (cwd: string, sha: string) => Promise<string | null>;
export const isAncestorCommit: (cwd: string, ancestor: string, descendant: string) => Promise<boolean>;
export const listCommitAncestry: (cwd: string, sha: string) => Promise<string[]>;
export const listChangedFilesBetween: (cwd: string, base: string, target: string) => Promise<string[]>;
export const listDirtyPathsAgainstHead: (cwd: string, headSha: string | null) => Promise<GitDirtyPath[]>;
```

**Resolution rules:**

- `resolveCommitSha` accepts only `HEAD` or `/^[0-9a-fA-F]{4,40}$/` for the repository format currently supported by this project.
- Normalize returned SHAs to lowercase full commit SHAs.
- Use `git rev-parse --disambiguate=` plus `git cat-file -t` to distinguish zero, one, and multiple commit objects. Do not accept a blob that shares the prefix.
- Throw `SNAPSHOT_REF_INVALID` for an invalid form or zero commit matches and `SNAPSHOT_REF_AMBIGUOUS` for multiple commit matches.
- `isAncestorCommit` returns `false` only for Git exit `1`; other Git failures are rethrown.
- `listDirtyPathsAgainstHead` combines `git diff --name-status -z HEAD` with `git ls-files --others --exclude-standard -z`. It reports staged and unstaged changes, deletions, and untracked files once each.
- A worktree rename contributes the old path as `deleted` and the new path as `modified`; this keeps both sides eligible for the ingest candidate filter.
- On an unborn branch, every tracked or untracked path is dirty relative to the absent HEAD.
- Add an internal raw Git execution path for `-z` commands. Do not call `.trim()` before parsing NUL-delimited path output, because leading or trailing whitespace can be part of a valid Git path.

Change `resolveCwd` to an asynchronous worktree-root resolver:

```ts
export const resolveCwd = async (input?: string): Promise<string> => {
  const requested = input ? path.resolve(input) : process.cwd();
  return (await tryGetGitRoot(requested)) ?? requested;
};
```

Every `src/cli.ts` call site must await it. `init` keeps its non-repository fallback through `resolveInitRoot`; all commands inside a repository emit the active worktree root in the envelope.

### Steps

- [ ] Write real-Git tests covering nested cwd, detached HEAD, unborn HEAD, full SHA, unique prefix, ambiguous prefix, invalid branch-name input, nonexistent prefix, ancestry true/false, and modified/deleted/untracked paths.
- [ ] Build the ambiguous-prefix fixture deterministically with repeated `git commit-tree` objects until two commit SHAs share the same four-character prefix. Keep those objects unreferenced; `git rev-parse --disambiguate=` must still discover them, and blob-only collisions must be filtered out.
- [ ] Extend the CLI contract test with a nested `query --cwd` invocation and assert that `envelope.cwd` equals `git rev-parse --show-toplevel`, not the nested directory.
- [ ] Run the tests and confirm the new assertions fail:

  ```bash
  pnpm test -- test/git-context.integration.test.ts test/cli.contract.test.ts
  ```

- [ ] Extend `src/core/git.ts` without changing the behavior of existing `getHeadSha`, `currentBranch`, and `listChangedFilesSince` callers. Implement the old helpers in terms of the new primitives where that removes duplication.
- [ ] Make `resolveCwd` asynchronous and add `await` to every `src/cli.ts` call site. Run TypeScript compilation to catch missed Promise values:

  ```bash
  pnpm build
  ```

- [ ] Rerun the focused tests:

  ```bash
  pnpm test -- test/git-context.integration.test.ts test/cli.contract.test.ts
  ```

  Expected: nested commands report the worktree root; detached and unborn repositories are represented without an uncaught Git error.

- [ ] Commit the Git and cwd layer:

  ```bash
  git add src/core/git.ts src/commands/bootstrap.ts src/cli.ts test/git-context.integration.test.ts test/cli.contract.test.ts
  git commit -m "feat(git): resolve repository and commit context"
  ```

---

## Task 3: Make the Manifest Catalog Exact, Validated, and Atomic

**Files:**

- Modify: `src/core/manifest.ts`
- Modify: `test/manifest.compat.test.ts`
- Create: `test/manifest.atomic.test.ts`

**Interfaces:**

```ts
export const CURRENT_MANIFEST_VERSION = 3;
export const listSnapshotShas: (cwd: string) => Promise<string[]>;
export const snapshotManifestExists: (cwd: string, sha: string) => Promise<boolean>;
export const loadSnapshotManifest: (cwd: string, sha: string) => Promise<SnapshotManifest>;
export const loadSnapshotManifestIfExists: (cwd: string, sha: string | null | undefined) => Promise<SnapshotManifest | null>;
export const writeSnapshotManifest: (cwd: string, manifest: SnapshotManifest) => Promise<void>;
```

**Validation and compatibility rules:**

- A missing exact file maps to `SNAPSHOT_NOT_INDEXED`.
- Invalid JSON, a non-object root, missing scalar fields, non-array `docs` or `chunks`, and filename/`commitSha` mismatch map to `SNAPSHOT_MANIFEST_INVALID`.
- `indexVersion < 3` normalizes in memory to version `3`, empty `artifactEntries`, and durable chunk scopes derived from `chunks`.
- `indexVersion === 3` is accepted and missing additive arrays are defaulted.
- `indexVersion > 3` maps to `SNAPSHOT_SCHEMA_UNSUPPORTED`.
- `buildSnapshotManifest` writes `CURRENT_MANIFEST_VERSION` rather than a second numeric literal.
- `loadSnapshotManifestIfExists` returns `null` only for `SNAPSHOT_NOT_INDEXED`; it rethrows invalid and unsupported manifests.
- A missing manifest directory behaves as an empty catalog: listing returns `[]` and exact existence returns `false`.
- Reading a legacy manifest never writes it.
- `listSnapshotShas` returns only final `*.json` names and ignores temporary files.
- Retain `latestSnapshotSha` for diagnostic callers, implemented over `listSnapshotShas`, but add a comment that it is forbidden for retrieval and ingest policy.
- `writeSnapshotManifest` creates only the manifest directory when needed; it must not initialize unrelated RAGit state.

Use same-directory temporary publication:

```ts
const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
try {
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temporary, target);
} finally {
  await rm(temporary, { force: true });
}
```

### Steps

- [ ] Expand `test/manifest.compat.test.ts` to cover legacy file immutability, valid v3, future schema, SHA mismatch, truncated JSON, and `loadSnapshotManifestIfExists` rethrowing corruption.
- [ ] Add `test/manifest.atomic.test.ts` to assert that temporary files are ignored, a successful write leaves exactly one complete JSON manifest, and no temporary file remains after publication.
- [ ] Run the focused tests and observe failures from current future-version acceptance and direct writes:

  ```bash
  pnpm test -- test/manifest.compat.test.ts test/manifest.atomic.test.ts
  ```

- [ ] Implement runtime validation and typed errors in `src/core/manifest.ts`.
- [ ] Replace direct final-path writes with the same-directory temporary write and rename shown above.
- [ ] Rerun focused and dependent manifest consumers:

  ```bash
  pnpm test -- test/manifest.compat.test.ts test/manifest.atomic.test.ts test/log.integration.test.ts test/migrate.test.ts
  ```

  Expected: supported legacy reads pass without file mutation; future, mismatched, and corrupt files fail with their exact codes.

- [ ] Commit the catalog change:

  ```bash
  git add src/core/manifest.ts test/manifest.compat.test.ts test/manifest.atomic.test.ts
  git commit -m "feat(manifest): validate and atomically publish snapshots"
  ```

---

## Task 4: Implement the Shared Snapshot and Ingest-Base Policy

**Files:**

- Create: `src/core/snapshot.ts`
- Create: `test/snapshot.test.ts`
- Create: `test/snapshot.integration.test.ts`

**Public types:**

```ts
export type SnapshotSelectionMode = "head-exact" | "explicit-exact";
export type SnapshotStatus = "indexed" | "missing" | "invalid" | "store-unavailable" | "unavailable";

export interface RepositoryContext {
  gitRoot: string;
  headSha: string | null;
  branch: string | null;
  detached: boolean;
  worktreeDirty: boolean;
  dirtyPathCount: number;
}

export interface SnapshotMetadata {
  requestedRef: string;
  resolvedSha: string | null;
  selection: SnapshotSelectionMode;
  status: SnapshotStatus;
  branch: string | null;
  detached: boolean;
  worktreeDirty: boolean;
}

export interface SnapshotSelection {
  context: RepositoryContext;
  manifest: SnapshotManifest;
  snapshotSha: string;
  snapshot: SnapshotMetadata;
  warnings: string[];
}

export interface IngestBaseSelection {
  mode: "full" | "since" | "partial-head" | "partial-parent";
  baseSha: string | null;
  manifest: SnapshotManifest | null;
}

export interface SnapshotDependencies {
  resolveRepositoryContext(cwd: string): Promise<RepositoryContext>;
  getHeadShaIfExists(cwd: string): Promise<string | null>;
  resolveCommitSha(cwd: string, ref: string): Promise<string>;
  getParentShaForCommit(cwd: string, sha: string): Promise<string | null>;
  isAncestorCommit(cwd: string, ancestor: string, descendant: string): Promise<boolean>;
  listCommitAncestry(cwd: string, sha: string): Promise<string[]>;
  listSnapshotShas(cwd: string): Promise<string[]>;
  snapshotManifestExists(cwd: string, sha: string): Promise<boolean>;
  loadSnapshotManifest(cwd: string, sha: string): Promise<SnapshotManifest>;
}
```

Export these functions:

```ts
export const resolveRepositoryContext: (cwd: string) => Promise<RepositoryContext>;
export const selectSnapshot: (cwd: string, at?: string, dependencies?: SnapshotDependencies) => Promise<SnapshotSelection>;
export const selectIngestBase: (
  cwd: string,
  request: { fullSnapshot: boolean; since?: string },
  context: RepositoryContext,
  dependencies?: SnapshotDependencies,
) => Promise<IngestBaseSelection>;
export const snapshotMetadataForUnavailable: (
  context: RepositoryContext,
  requestedRef?: string,
) => SnapshotMetadata;
```

Export one shared dirty-read warning constant so query, context, and recall do not drift:

```ts
export const WORKTREE_DIRTY_SNAPSHOT_WARNING =
  "작업 트리에 커밋되지 않은 변경이 있습니다. 조회 결과에는 해당 변경이 포함되지 않습니다.";
```

`SnapshotDependencies` is an exported interface containing only the Git and manifest functions the policy needs. Provide a default concrete adapter and pass fakes only from unit tests. Do not add a configurable fallback mode.

`resolveRepositoryContext` sets `detached` to `headSha !== null && branch === null`; an unborn named branch is not a detached HEAD.

**Default selection algorithm:**

1. Resolve repository context and capture `headSha`.
2. Require the exact final manifest and validate it.
3. Capture HEAD again, even when exact loading raised a typed manifest error.
4. If HEAD changed, discard the selection or error and retry the full operation once.
5. If the second attempt also observes movement, throw `REPOSITORY_STATE_CHANGED` with `retryable: true`.
6. If HEAD is stable, return the selection or the original exact typed error.

**Explicit selection algorithm:** resolve the supplied `HEAD`, full SHA, or hexadecimal prefix to a full commit, load only its exact manifest, and never reread HEAD after resolution. Any supplied `--at`, including `--at HEAD`, reports `selection: "explicit-exact"`; only an omitted `--at` reports `head-exact`.

When an exact manifest is missing, list the target commit ancestry, intersect it with `listSnapshotShas`, put the first matching ancestor in `details.nearestIndexedAncestor`, and recommend either `ragit ingest --since SHA` or `ragit ingest --all`. The ancestor is a hint only.

**Ingest-base algorithm:**

- Full mode, including the no-selector CLI default: return no base.
- `--since`: resolve the ref, prove it is an ancestor of current HEAD, require its exact manifest, and return it.
- Partial path or glob mode: prefer an exact current-HEAD manifest; otherwise require the exact parent manifest; otherwise throw `INGEST_BASE_NOT_INDEXED` and recommend `ragit ingest --all`.
- A non-ancestor `--since` throws `INGEST_BASE_NOT_ANCESTOR`.
- Only a genuinely absent trusted base maps to `INGEST_BASE_NOT_INDEXED`; an exact base file that is corrupt or future-versioned retains `SNAPSHOT_MANIFEST_INVALID` or `SNAPSHOT_SCHEMA_UNSUPPORTED`.

### Steps

- [ ] Write pure fake-adapter tests for exact HEAD, exact explicit SHA, unique-prefix resolution delegation, missing with nearest-ancestor hint, missing without a hint, invalid manifest, one HEAD movement followed by success, repeated movement, explicit selection ignoring movement, full ingest, exact since base, non-ancestor since, partial HEAD base, partial parent base, and missing partial base.
- [ ] The repeated-movement assertion must verify the exact code and retryability:

  ```ts
  await expect(selectSnapshot("/repo", undefined, dependencies)).rejects.toMatchObject({
    code: "REPOSITORY_STATE_CHANGED",
    exitCode: 3,
    retryable: true,
  });
  ```

- [ ] Run the pure test and confirm the missing module failure:

  ```bash
  pnpm test -- test/snapshot.test.ts
  ```

- [ ] Implement `src/core/snapshot.ts` with no imports from retrieval, ingest, status, or CLI layers.
- [ ] Rerun the pure test until every policy branch passes:

  ```bash
  pnpm test -- test/snapshot.test.ts
  ```

- [ ] Add real-Git integration scenarios for divergent branches, a branch with no manifest while another branch has one, nested cwd, linked worktree-local `.ragit` state, detached HEAD, unborn HEAD, full SHA, unique prefix, nonexistent prefix, and a manually staged temporary manifest that is invisible before rename.
- [ ] Assert branch isolation directly:

  ```ts
  await expect(selectSnapshot(featureWorktree)).rejects.toMatchObject({
    code: "SNAPSHOT_NOT_INDEXED",
    details: { resolvedSha: featureSha, nearestIndexedAncestor: baseSha },
  });
  ```

- [ ] Run both selector suites:

  ```bash
  pnpm test -- test/snapshot.test.ts test/snapshot.integration.test.ts
  ```

  Expected: no test observes or returns a manifest from a different commit.

- [ ] Commit the shared policy:

  ```bash
  git add src/core/snapshot.ts test/snapshot.test.ts test/snapshot.integration.test.ts
  git commit -m "feat(snapshot): enforce exact snapshot selection"
  ```

---

## Task 5: Move Query and Context Pack onto Strict Retrieval Context

**Files:**

- Modify: `src/core/retrieval.ts`
- Modify: `src/core/context.ts`
- Modify: `src/core/output.ts`
- Modify: `src/cli.ts`
- Modify: `test/query.integration.test.ts`
- Create: `test/retrieval-selection.integration.test.ts`
- Modify: `test/cli.contract.test.ts`

**Result contracts:**

```ts
export interface QueryResult {
  snapshotSha: string;
  snapshot: SnapshotMetadata;
  hits: RetrievalHit[];
  warnings: string[];
  redactionSummary: RedactionSummary;
}

export interface UnifiedRetrievalResult {
  snapshotSha: string | null;
  snapshot: SnapshotMetadata;
  hits: RetrievalHit[];
  warnings: string[];
  redactionSummary: RedactionSummary;
}

export interface ContextPackResult {
  goal: string;
  snapshotSha: string;
  snapshot: SnapshotMetadata;
  budget: number;
  usedTokens: number;
  selectedHits: number;
  hits: RetrievalHit[];
  warnings: string[];
  redactionSummary: RedactionSummary;
}
```

**Required strict execution order for query, context, and snapshot-backed recall:**

1. Call `selectSnapshot` and obtain its validated manifest and normalized worktree root.
2. Load configuration from `selection.context.gitRoot`.
3. Resolve the embedding profile and security policy.
4. Open the canonical store read-only and validate its embedding contract.
5. Map any open or contract failure to `SNAPSHOT_STORE_UNAVAILABLE`.
6. Only after steps 1 through 5 succeed, sanitize and embed the query.
7. Query the already-open store using `selection.manifest`; do not reload the manifest by SHA.
8. Close the store in `finally`.
9. Add a warning when `selection.context.worktreeDirty` is true: uncommitted changes are not included in the snapshot.

Refactor `buildSnapshotHits` to receive `CanonicalStore` and `SnapshotManifest` arguments instead of opening the store and loading the manifest itself. Delete the private `resolveSnapshotSha` and `isRecoverableSnapshotError` functions. Remove retrieval imports of `latestSnapshotSha`, `resolveSnapshotRef`, and `getHeadSha`.

`searchKnowledge` and `packContext` are always strict, including non-durable scopes. Artifact hits may augment a valid snapshot, but they may not turn a missing snapshot into query or context success.

Keep the existing recoverable behavior narrowly reachable only when `artifactOptions.mode === "recall"` during this task so the branch remains green between commits. Do not use it for query or context. Task 6 immediately replaces that compatibility branch with the approved zero-embedding keyword-only degradation.

### Steps

- [ ] Extend `test/query.integration.test.ts` so initialization output is committed before the first full ingest. Capture the actual initial indexed SHA and use that SHA as the next `--since` base.
- [ ] Add retrieval-selection integration cases for:
  - current HEAD missing while another branch has a manifest
  - explicit old commit time travel
  - dirty code-only read with a warning
  - dirty document read with the same warning and committed snapshot results
  - non-durable query scope still failing when the exact snapshot is missing
  - valid manifest with missing store
  - nested cwd using the root store
- [ ] Configure an OpenAI profile with a `globalThis.fetch = vi.fn()` spy in the missing-manifest and missing-store cases. Assert both errors occur before any provider request:

  ```ts
  await expect(searchKnowledge(temp, "must not embed", { topK: 3 })).rejects.toMatchObject({
    code: "SNAPSHOT_NOT_INDEXED",
  });
  expect(globalThis.fetch).not.toHaveBeenCalled();
  ```

- [ ] Run the focused tests and confirm current fallback behavior makes them fail:

  ```bash
  pnpm test -- test/query.integration.test.ts test/retrieval-selection.integration.test.ts test/cli.contract.test.ts
  ```

- [ ] Refactor `runUnifiedRetrieval` to perform selection and store validation before embedding, and to propagate `snapshot` plus `warnings`.
- [ ] Update query CLI JSON to retain `snapshotSha` and add `snapshot`. Pass retrieval warnings into `buildCliEnvelope`.
- [ ] Update `formatQueryResultText` to print requested ref, resolved SHA, selection mode, status, branch, detached state, and dirty state before the hit list.
- [ ] Update `packContext`, `projectContextPack`, and context text formatting to retain `snapshotSha`, add the same snapshot metadata, and expose warnings.
- [ ] Add the success-contract assertions:

  ```ts
  expect(queryOutput.data.snapshotSha).toBe(headSha);
  expect(queryOutput.data.snapshot).toMatchObject({
    requestedRef: "HEAD",
    resolvedSha: headSha,
    selection: "head-exact",
    status: "indexed",
    detached: false,
  });
  expect(contextOutput.data.snapshotSha).toBe(headSha);
  expect(contextOutput.data.snapshot.resolvedSha).toBe(headSha);
  ```

- [ ] Rerun focused tests and build:

  ```bash
  pnpm test -- test/query.integration.test.ts test/retrieval-selection.integration.test.ts test/memory.test.ts test/cli.contract.test.ts
  pnpm build
  ```

  Expected: strict read paths never return a different SHA and never call an embedding provider after selection or store validation fails.

- [ ] Commit strict query and context integration:

  ```bash
  git add src/core/retrieval.ts src/core/context.ts src/core/output.ts src/cli.ts test/query.integration.test.ts test/retrieval-selection.integration.test.ts test/cli.contract.test.ts
  git commit -m "feat(retrieval): require exact snapshot before embedding"
  ```

---

## Task 6: Make Memory Recall Degradation Explicit and Keyword-Only

**Files:**

- Modify: `src/core/retrieval.ts`
- Modify: `src/core/memory.ts`
- Modify: `src/core/memoryTypes.ts`
- Modify: `src/commands/memory.ts`
- Modify: `test/memory.test.ts`
- Modify: `test/memory.integration.test.ts`
- Modify: `test/cli.contract.test.ts`

**Contract changes:**

```ts
export interface RecallPacket {
  goal: string;
  constraints: string[];
  openLoops: MemoryOpenLoop[];
  relatedDecisions: MemoryDecision[];
  retrievedHits: RetrievalHit[];
  nextActions: string[];
  latestSessionId: string | null;
  sourceHeadSha: string | null;
  snapshotSha: string | null;
  snapshot: SnapshotMetadata;
  createdAt: string;
  warnings: string[];
  redactionSummary?: RedactionSummary;
}
```

Only `artifactOptions.mode === "recall"` may degrade. The degradable operational codes are:

```ts
const DEGRADABLE_RECALL_CODES = new Set<RagitErrorCode>([
  "SNAPSHOT_NOT_INDEXED",
  "SNAPSHOT_MANIFEST_INVALID",
  "SNAPSHOT_SCHEMA_UNSUPPORTED",
  "SNAPSHOT_STORE_UNAVAILABLE",
  "REPOSITORY_STATE_CHANGED",
]);
```

In the degraded branch:

- Do not call `embedText`, `embedTexts`, or open the canonical store.
- Load working memory and recall artifacts as today.
- Rank artifact candidates with `scoreVector = 0`, keyword overlap, authority, and recency only.
- Return `snapshotSha: null` and `snapshot.status: "unavailable"`.
- Preserve the attempted `requestedRef`, resolved HEAD when available, branch, detached state, and dirty state.
- Add a warning containing the operational error code and state that only working memory and artifact-derived content were used.
- Never mark an artifact hit as snapshot-backed durable knowledge.
- Use `selection: "head-exact"` in the unavailable metadata to describe the attempted policy, not a successful manifest selection.

Refactor artifact scoring to accept either a semantic context or `null`:

```ts
interface ArtifactSemanticContext {
  queryEmbedding: number[];
  embeddingProfile: ReturnType<typeof resolveEmbeddingProfile>;
  config: Awaited<ReturnType<typeof loadConfig>>;
}
```

When the context is `null`, use keyword score as the retrieval component and do not invoke an embedding function.

### Steps

- [ ] Initialize the existing no-snapshot recall fixture as a Git repository with no commit. This preserves the approved unborn-HEAD scenario without treating a non-repository directory as a valid snapshot context.
- [ ] Update the existing no-snapshot recall unit test to assert the full unavailable snapshot block and the warning code.
- [ ] Add a reviewed recall artifact whose text overlaps the goal and assert it is returned with `scoreVector === 0` in degraded mode.
- [ ] Add a fetch spy under an OpenAI profile and assert degraded recall performs zero network calls.
- [ ] Add a strict-vs-degraded regression: the same missing repository makes `query` fail with exit class `3` while `memory recall` succeeds with `snapshot.status=unavailable`.
- [ ] Run recall tests and observe failures under the current pre-selection embedding behavior:

  ```bash
  pnpm test -- test/memory.test.ts test/memory.integration.test.ts test/cli.contract.test.ts
  ```

- [ ] Implement the explicit degraded branch in retrieval and add `snapshot` to `RecallPacket`, projection, Markdown, and JSON output.
- [ ] In recall Markdown, print `snapshot_status`, `snapshot_sha`, `branch`, `detached`, and `worktree_dirty` so degraded text output is as explicit as JSON.
- [ ] Change the legacy warning assertion from free-form fallback language to the stable code-bearing form:

  ```ts
  expect(result.packet.snapshotSha).toBeNull();
  expect(result.packet.snapshot).toMatchObject({
    requestedRef: "HEAD",
    status: "unavailable",
  });
  expect(result.packet.warnings).toContainEqual(expect.stringContaining("SNAPSHOT_NOT_INDEXED"));
  expect(globalThis.fetch).not.toHaveBeenCalled();
  ```

- [ ] Rerun recall and retrieval suites:

  ```bash
  pnpm test -- test/memory.test.ts test/memory.integration.test.ts test/retrieval-selection.integration.test.ts test/cli.contract.test.ts
  ```

  Expected: recall remains useful without a snapshot, but its output cannot be mistaken for snapshot-backed knowledge and causes no embedding traffic.

- [ ] Commit degraded recall:

  ```bash
  git add src/core/retrieval.ts src/core/memory.ts src/core/memoryTypes.ts src/commands/memory.ts test/memory.test.ts test/memory.integration.test.ts test/cli.contract.test.ts
  git commit -m "feat(memory): make recall degradation explicit"
  ```

---

## Task 7: Enforce Trusted Ingest Bases and Committed Candidates

**Files:**

- Modify: `src/core/ingest.ts`
- Modify: `src/core/memory.ts`
- Modify: `src/core/harness.ts`
- Modify: `src/commands/hooks.ts`
- Modify: `src/cli.ts`
- Modify: `test/ingest.integration.test.ts`
- Modify: `test/memory.integration.test.ts`
- Modify: `test/harness.integration.test.ts`
- Modify: `test/cli-hardening.test.ts`
- Modify fixture setup in: `test/artifacts.integration.test.ts`, `test/cli.contract.test.ts`, `test/drift.integration.test.ts`, `test/embedding-execution.integration.test.ts`, `test/embedding-migrate.integration.test.ts`, `test/log.integration.test.ts`, `test/narrative-model.test.ts`, `test/narrative.integration.test.ts`, `test/query.integration.test.ts`, `test/timeline.integration.test.ts`

**Summary additions:**

```ts
export interface IngestSummary {
  mode: "apply" | "dry-run";
  processed: number;
  skipped: number;
  masked: number;
  commitSha: string;
  manifestPath: string | null;
  searchReady: boolean;
  plannedFiles: string[];
  deletedDocumentIds: string[];
  dirtyCandidates: string[];
  wouldFail: boolean;
  fullSnapshot: boolean;
  scope: "durable" | "all";
  boundArtifactIds: string[];
  admission: AdmissionSummary;
  docAuthority: {
    validated: boolean;
    violations: number;
    skipped: number;
  };
  warnings: string[];
}
```

**Required pipeline order:**

1. Resolve repository context and require a concrete HEAD. An unborn repository maps to `SNAPSHOT_NOT_INDEXED` with exit `3` and `git status` as the recovery command.
2. Resolve the exact ingest base through `selectIngestBase`.
3. Resolve candidate paths and committed deletions using the normalized base SHA.
4. List all worktree paths dirty relative to HEAD and filter them to this operation's candidate scope.
5. In apply mode, throw `INGEST_CANDIDATES_DIRTY` before content reads, embedding, store writes, artifact binding, or ledger writes.
6. In dry-run, scan all relevant dirty paths, set `wouldFail: true`, return all sorted `dirtyCandidates` with exit `0`, and perform no persistent write.
7. Process candidate content for the existing summary; only apply mode appends store records, constructs the manifest, and atomically publishes it.

Dirty dry-run continues the existing validation and planning path after collecting every blocking candidate; it does not throw on dirtiness. It must still skip store writes, artifact binding, ledger writes, and manifest publication.

Do not call the mutating `ensureRagitStructure` path during dry-run. Read an existing config when present; when only the config file is absent, use `defaultConfig()` in memory. Invalid existing config still fails. Apply mode retains the existing structure initialization before persistent work.

**Relevant dirty-path filters:**

- Full or no-selector ingest: any dirty path satisfying the implicit document policy.
- `--since`: only paths in the committed `base..HEAD` document change set.
- `--files`: document-like paths matching the supplied glob.
- `--path`: exactly the normalized explicit paths.
- Modified source code outside these filters never blocks a document ingest.

**Base rules:**

- Full or no-selector ingest uses no base.
- `--since S` requires the exact manifest for normalized `S`; do not use the parent and do not use latest.
- Partial ingest uses exact HEAD when present, otherwise exact parent, otherwise fails.
- Manifest `parentSha` remains the actual current commit parent, even when `--since` names an older indexed ancestor.

The old production block must disappear completely:

```ts
const baseSnapshot =
  candidates.fullSnapshot
    ? null
    : (await loadSnapshotManifestIfExists(cwd, parentSha)) ??
      (await loadSnapshotManifestIfExists(cwd, await latestSnapshotSha(cwd)));
```

Do not replace it with another fallback expression.

**Promotion behavior:** Newly generated memory and harness documents are necessarily uncommitted, so `memory promote` and `harness promote` must not call `runIngest` immediately. They return `ingested: false` and warn the user to commit the generated documents and run `ragit ingest --all` for the first snapshot or a supported incremental command after a trusted base exists. Keep the configuration field for compatibility, but do not violate the commit-bound contract.

**Hook behavior:** Generate a full base SHA in shell before invoking the CLI. Post-commit resolves `HEAD^`; post-merge resolves `ORIG_HEAD`. If resolution fails, exit the managed hook without invoking ingest. The CLI receives only a full SHA in `--since`.

Keep managed hooks non-blocking, but do not hide the recovery path. On incremental-ingest failure, print a concise stderr message recommending `ragit ingest --all`, then return success so the completed Git operation is not retroactively reported as failed.

### Steps

- [ ] Add ingest-base tests for full ingest, exact indexed `--since`, missing `--since`, non-ancestor `--since`, partial exact-HEAD base, partial exact-parent base, and partial missing base.
- [ ] Add dirty admission tests for modified, untracked, and deleted Markdown candidates; code-only dirty state; explicit path filtering; and a dry-run returning every dirty candidate with `wouldFail: true`.
- [ ] Add an uninitialized-repository dry-run test that snapshots the repository tree outside `.git` before and after and proves no `.ragit` path, store record, ledger entry, or manifest was created.
- [ ] In each apply-mode dirty test, spy on embedding or use a remote fetch spy and assert zero calls before the error.
- [ ] Assert typed failures:

  ```ts
  await expect(runIngest(temp, { all: true })).rejects.toMatchObject({
    code: "INGEST_CANDIDATES_DIRTY",
    exitCode: 3,
    details: { dirtyCandidates: ["docs/dirty.spec.md"] },
  });
  ```

- [ ] Update promotion tests to commit generated documents before ingest:

  ```ts
  expect(promoted.ingested).toBe(false);
  expect(promoted.warnings).toContainEqual(expect.stringContaining("commit"));
  git(temp, ["add", "."]);
  git(temp, ["commit", "-m", "commit promoted docs"]);
  const indexed = await runIngest(temp, { all: true });
  expect(indexed.searchReady).toBe(true);
  ```

- [ ] Normalize every named integration fixture so `runInit` output and foundational documents are committed before the first `runIngest`. Where a test later uses `--since`, use the SHA that actually has an exact manifest rather than a pre-init commit.
- [ ] Run the affected tests and confirm current worktree-content ingest and latest-base fallback fail the new assertions:

  ```bash
  pnpm test -- test/ingest.integration.test.ts test/memory.integration.test.ts test/harness.integration.test.ts test/cli-hardening.test.ts
  ```

- [ ] Reorder `runIngest` around `selectIngestBase` and the dirty guard. Remove its imports of `latestSnapshotSha` and `loadSnapshotManifestIfExists` when the shared selection object supplies the manifest.
- [ ] Add `dirtyCandidates` and `wouldFail` to every return path and to `formatIngestText`.
- [ ] Change memory and harness promotion to skip automatic ingest with commit-first recovery guidance.
- [ ] Update managed hook templates to pass resolved full SHAs.
- [ ] Run the complete ingest and affected-fixture group:

  ```bash
  pnpm test -- \
    test/ingest.integration.test.ts \
    test/memory.integration.test.ts \
    test/harness.integration.test.ts \
    test/artifacts.integration.test.ts \
    test/cli.contract.test.ts \
    test/drift.integration.test.ts \
    test/embedding-execution.integration.test.ts \
    test/embedding-migrate.integration.test.ts \
    test/log.integration.test.ts \
    test/narrative-model.test.ts \
    test/narrative.integration.test.ts \
    test/query.integration.test.ts \
    test/timeline.integration.test.ts \
    test/cli-hardening.test.ts
  ```

  Expected: no uncommitted document content is persisted under a commit SHA, exact incremental bases are mandatory, and existing scenarios pass after their setup commits the intended corpus.

- [ ] Run the full suite once at this cross-cutting boundary:

  ```bash
  pnpm test
  ```

  Expected: all tests pass before committing the ingest behavior change.

- [ ] Commit the ingest contract and its direct fixture updates:

  ```bash
  git add \
    src/core/ingest.ts \
    src/core/memory.ts \
    src/core/harness.ts \
    src/commands/hooks.ts \
    src/cli.ts \
    test/ingest.integration.test.ts \
    test/memory.integration.test.ts \
    test/harness.integration.test.ts \
    test/cli-hardening.test.ts \
    test/artifacts.integration.test.ts \
    test/cli.contract.test.ts \
    test/drift.integration.test.ts \
    test/embedding-execution.integration.test.ts \
    test/embedding-migrate.integration.test.ts \
    test/log.integration.test.ts \
    test/narrative-model.test.ts \
    test/narrative.integration.test.ts \
    test/query.integration.test.ts \
    test/timeline.integration.test.ts
  git commit -m "feat(ingest): enforce trusted bases and committed candidates"
  ```

---

## Task 8: Report Current-HEAD Snapshot Readiness in Status

**Files:**

- Modify: `src/commands/bootstrap.ts`
- Modify: `src/cli.ts`
- Modify: `test/cli.contract.test.ts`
- Create: `test/status-snapshot.integration.test.ts`

**Status contract:**

```ts
type StatusSecurityState = {
  maskingConfigured: boolean;
  remoteEmbeddingPolicy: Awaited<ReturnType<typeof loadConfig>>["security"]["remote_embedding_policy"];
  admissionMode: Awaited<ReturnType<typeof loadConfig>>["security"]["admission_mode"];
  providerEgressClass: "local" | "remote";
  outputRemasking: boolean;
  quarantineEntries: number;
  lastAdmissionAt: string | null;
  admissionBlockedEntries: number;
  admissionQuarantinedEntries: number;
  lastAuditAt: string | null;
  legacyUnsafeState: boolean;
};

export interface StatusResult {
  branch: string | null;
  head: string | null;
  snapshot: SnapshotMetadata;
  backend: string;
  zvec: {
    status: "missing" | "loaded";
    collections: string[];
    schemaVersion: number | null;
    searchReady: boolean;
    migrationRequired: boolean;
    stats: Record<string, unknown> | null;
  };
  supported_types: string[];
  docsAuthority: {
    tracked: number;
    violations: number;
    lastReconciledAt: string | null;
    indexPath: string;
  };
  knowledge: {
    durableReady: boolean;
    sessionArtifactCount: number;
    harnessArtifactCount: number;
    pendingBindings: number;
  };
  events: {
    eventCount: number;
    lastRecordedAt: string | null;
    latestEpisodeId: string | null;
    latestGoalId: string | null;
    latestSessionId: string | null;
  };
  manifests: number;
  embedding: StatusEmbeddingState;
  security: StatusSecurityState;
  format: Awaited<ReturnType<typeof loadConfig>>["output"]["format"];
}
```

Keep the existing full `StatusResult` fields; the abbreviated named types above may remain private aliases in `bootstrap.ts`.

**Diagnostic rules:**

- No HEAD or no exact HEAD manifest: `snapshot.status = "missing"`.
- Exact manifest malformed, SHA-mismatched, or future-versioned: `snapshot.status = "invalid"`.
- Exact valid manifest but no usable canonical store: `snapshot.status = "store-unavailable"`.
- Exact valid manifest and usable store: `snapshot.status = "indexed"`.
- `zvec.searchReady` and `knowledge.durableReady` are true only for `indexed`, never merely because any manifest exists.
- `status` exits successfully for all four diagnostic states.
- Retain total manifest count as a separate historical fact.

### Steps

- [ ] Add status integration cases for indexed HEAD, unindexed new commit with an older manifest present, corrupt exact manifest, future exact manifest, missing store, detached HEAD, dirty worktree, nested cwd, and unborn HEAD.
- [ ] Assert that an unrelated manifest no longer makes the current branch ready:

  ```ts
  const status = await runStatus(temp);
  expect(status.manifests).toBeGreaterThan(0);
  expect(status.snapshot).toMatchObject({
    resolvedSha: unindexedHead,
    status: "missing",
  });
  expect(status.zvec.searchReady).toBe(false);
  expect(status.knowledge.durableReady).toBe(false);
  ```

- [ ] Run the status tests and confirm current manifest-count readiness fails them:

  ```bash
  pnpm test -- test/status-snapshot.integration.test.ts test/cli.contract.test.ts
  ```

- [ ] Refactor `runStatus` to use repository context, exact manifest validation, and store validation without invoking an embedding provider.
- [ ] Add snapshot lines to `formatStatusText`, rendering null branch or head as `none`.
- [ ] Rerun tests:

  ```bash
  pnpm test -- test/status-snapshot.integration.test.ts test/cli.contract.test.ts
  ```

  Expected: status remains diagnostic and successful while readiness reflects only current HEAD.

- [ ] Commit status diagnostics:

  ```bash
  git add src/commands/bootstrap.ts src/cli.ts test/status-snapshot.integration.test.ts test/cli.contract.test.ts
  git commit -m "feat(status): report exact head snapshot readiness"
  ```

---

## Task 9: Project Stable CLI Failures and Describe the New Contract

**Files:**

- Modify: `src/core/cliContract.ts`
- Modify: `src/core/commandRegistry.ts`
- Modify: `src/cli.ts`
- Create: `test/cli.snapshot-contract.test.ts`
- Modify: `test/cli.contract.test.ts`

**Envelope additions:**

```ts
export interface CliEnvelope<T> {
  command: string;
  ok: boolean;
  version: string;
  cwd: string;
  data: T;
  warnings: string[];
  error?: RagitErrorPayload;
}

export const buildCliFailureEnvelope = (
  command: string,
  cwd: string,
  error: RagitOperationalError,
  warnings: string[] = [],
): CliEnvelope<null> => ({
  command,
  ok: false,
  version: RAGIT_VERSION,
  cwd,
  data: null,
  warnings,
  error: error.toPayload(),
});
```

Add a small `resolveCliFailureContext(argv)` helper in `cliContract.ts` that determines the command path, requested format, and cwd argument for the typed-error boundary. It only needs exact defaults for affected commands:

Parse both split and equals forms for `--cwd` and `--format`, regardless of whether they appear before or after positional input.

| Command | Default failure format |
| --- | --- |
| `query` | `both` |
| `context pack` | `both` |
| `memory recall` | `both` |
| `ingest` | `json` |
| other commands | `text` |

Use the normalized worktree root for `cwd` when Git resolution succeeds and the absolute requested path otherwise.

`emitCliFailure` behavior:

- `text`: write code, message, retryability, details, and recovery command to stderr.
- `json`: write one valid failure envelope to stdout and no human prefix to stderr.
- `both`: write text to stderr and the JSON envelope to stdout.

Replace the terminal catch with an asynchronous typed boundary that sets `process.exitCode` and returns. Keep unexpected errors on stderr with exit `1`; do not wrap them in one of the stable operational codes.

```ts
program.parseAsync(process.argv).catch(async (error: unknown) => {
  if (isRagitOperationalError(error)) {
    const context = await resolveCliFailureContext(process.argv.slice(2));
    emitCliFailure({
      envelope: buildCliFailureEnvelope(context.command, context.cwd, error),
      format: context.format,
    });
    process.exitCode = error.exitCode;
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[ragit] 오류: ${message}`);
  process.exitCode = 1;
});
```

### Steps

- [ ] Add a spawned-CLI helper based on `spawnSync` that returns `status`, `stdout`, and `stderr` without throwing.
- [ ] Add JSON and text cases for invalid ref (`2`), missing snapshot (`3`), corrupt/future manifest (`4`), dirty ingest (`3`), and repeated-state error projection using the pure envelope builder.
- [ ] Assert the JSON shape exactly for a missing snapshot:

  ```ts
  expect(result.status).toBe(3);
  expect(JSON.parse(result.stdout)).toMatchObject({
    command: "query",
    ok: false,
    cwd: temp,
    data: null,
    warnings: [],
    error: {
      code: "SNAPSHOT_NOT_INDEXED",
      category: "not_ready",
      retryable: false,
      details: { resolvedSha: headSha },
      recovery: { command: "ragit ingest --all" },
    },
  });
  ```

- [ ] Add a `both` assertion that stdout is parseable JSON, stderr includes the same code, and both formats exit with the same status.
- [ ] Run the CLI contract tests and observe the current unstructured exit-1 behavior:

  ```bash
  pnpm test -- test/cli.snapshot-contract.test.ts test/cli.contract.test.ts
  ```

- [ ] Add the failure envelope and emitter, wire the terminal catch, and retain the legacy unexpected-error path.
- [ ] Update `commandRegistry.ts` output summaries:
  - query: add `snapshot`
  - context pack: add `snapshot`
  - memory recall: add `snapshot`
  - status: add `snapshot`
  - ingest: add `dirtyCandidates` and `wouldFail`
- [ ] Rerun tests and build:

  ```bash
  pnpm test -- test/cli.snapshot-contract.test.ts test/cli.contract.test.ts test/cli-hardening.test.ts
  pnpm build
  ```

  Expected: operational errors have stable JSON, text, stderr, and exit-code behavior; unexpected errors remain exit `1`.

- [ ] Commit the CLI machine contract:

  ```bash
  git add src/core/cliContract.ts src/core/commandRegistry.ts src/cli.ts test/cli.snapshot-contract.test.ts test/cli.contract.test.ts
  git commit -m "feat(cli): expose structured snapshot failures"
  ```

---

## Task 10: Update Onboarding and Command Documentation

**Files:**

- Modify: `README.md`
- Modify: `docs/ragit-init-scenarios.md`
- Modify: `docs/ragit-init-scenarios.ko.md`
- Modify: `apps/docs/content/docs/en/(workflows)/getting-started.mdx`
- Modify: `apps/docs/content/docs/ko/(workflows)/getting-started.mdx`
- Modify: `apps/docs/content/docs/en/(workflows)/memory-model.mdx`
- Modify: `apps/docs/content/docs/ko/(workflows)/memory-model.mdx`
- Modify: `apps/docs/content/docs/en/(reference)/agent-cli.mdx`
- Modify: `apps/docs/content/docs/ko/(reference)/agent-cli.mdx`
- Modify: `apps/docs/content/docs/en/commands/ingest.mdx`
- Modify: `apps/docs/content/docs/ko/commands/ingest.mdx`
- Modify: `apps/docs/content/docs/en/commands/query.mdx`
- Modify: `apps/docs/content/docs/ko/commands/query.mdx`
- Modify: `apps/docs/content/docs/en/commands/context/pack.mdx`
- Modify: `apps/docs/content/docs/ko/commands/context/pack.mdx`
- Modify: `apps/docs/content/docs/en/commands/memory/recall.mdx`
- Modify: `apps/docs/content/docs/ko/commands/memory/recall.mdx`
- Modify: `apps/docs/content/docs/en/commands/memory/promote.mdx`
- Modify: `apps/docs/content/docs/ko/commands/memory/promote.mdx`
- Modify: `apps/docs/content/docs/en/commands/harness/promote.mdx`
- Modify: `apps/docs/content/docs/ko/commands/harness/promote.mdx`
- Modify: `apps/docs/content/docs/en/commands/status.mdx`
- Modify: `apps/docs/content/docs/ko/commands/status.mdx`

**Documentation requirements:**

- The canonical first-run sequence is init, create or update foundational documents, commit, full ingest, status, query.
- Explain that dirty reads use the committed snapshot and exclude worktree changes.
- Explain exact `HEAD` and `--at` selection and that nearest ancestors are hints, never automatic results.
- Document the additive `snapshot` block and stable failure envelope with exit classes `2`, `3`, and `4`.
- Document recall's keyword-only artifact/working-memory degradation and `snapshot.status=unavailable`.
- Document `ingest --since` exact-base requirements, partial-ingest base rules, dirty apply failure, and dry-run `wouldFail` output.
- Remove claims that memory or harness promotion documents are ingested immediately. State that generated durable documents must be reviewed, committed, and then ingested.
- State that this workstream alone does not establish practical readiness; locking, recovery, retrieval evaluation, and distribution matrix work remain.
- Keep English and Korean command pages structurally parallel.

Use this command sequence in both onboarding languages:

```bash
ragit init
git add AGENTS.md docs .ragit/config.toml .gitignore
git commit -m "initialize ragit knowledge"
ragit ingest --all
ragit status --format json
ragit query "project goal" --format json
```

If `.ragit/config.toml` is ignored by the selected init policy, the prose must tell users to stage only the repository files their policy keeps tracked; do not recommend forcing ignored runtime state.

### Steps

- [ ] Update README quick start, recommended post-init flow, ingest notes, and the memory-promote description.
- [ ] Update both init-scenario documents with the commit boundary.
- [ ] Update the English and Korean affected command and agent-reference pages with the contracts above.
- [ ] Run command, link, language, and search-index checks:

  ```bash
  pnpm docs:check:commands
  pnpm docs:check:internal-links
  pnpm docs:check:i18n
  pnpm docs:check:search-index
  ```

  Expected: all documentation checks pass with no missing command page or language counterpart.

- [ ] Run the Markdown link regression test:

  ```bash
  pnpm test -- test/internal-doc-links.test.ts test/i18n-routing.test.ts
  ```

- [ ] Commit only documentation:

  ```bash
  git add \
    README.md \
    docs/ragit-init-scenarios.md \
    docs/ragit-init-scenarios.ko.md \
    'apps/docs/content/docs/en/(workflows)/getting-started.mdx' \
    'apps/docs/content/docs/ko/(workflows)/getting-started.mdx' \
    'apps/docs/content/docs/en/(workflows)/memory-model.mdx' \
    'apps/docs/content/docs/ko/(workflows)/memory-model.mdx' \
    'apps/docs/content/docs/en/(reference)/agent-cli.mdx' \
    'apps/docs/content/docs/ko/(reference)/agent-cli.mdx' \
    apps/docs/content/docs/en/commands/ingest.mdx \
    apps/docs/content/docs/ko/commands/ingest.mdx \
    apps/docs/content/docs/en/commands/query.mdx \
    apps/docs/content/docs/ko/commands/query.mdx \
    apps/docs/content/docs/en/commands/context/pack.mdx \
    apps/docs/content/docs/ko/commands/context/pack.mdx \
    apps/docs/content/docs/en/commands/memory/recall.mdx \
    apps/docs/content/docs/ko/commands/memory/recall.mdx \
    apps/docs/content/docs/en/commands/memory/promote.mdx \
    apps/docs/content/docs/ko/commands/memory/promote.mdx \
    apps/docs/content/docs/en/commands/harness/promote.mdx \
    apps/docs/content/docs/ko/commands/harness/promote.mdx \
    apps/docs/content/docs/en/commands/status.mdx \
    apps/docs/content/docs/ko/commands/status.mdx
  git commit -m "docs: document strict snapshot workflow"
  ```

---

## Task 11: Prove Installed-Package Behavior and the Selection Budget

**Files:**

- Modify: `scripts/smoke-packed-cli.mjs`
- Create: `scripts/benchmark-snapshot-selection.ts`
- Modify: `package.json`

Add the script entry:

```json
{
  "scripts": {
    "benchmark:snapshot": "tsx scripts/benchmark-snapshot-selection.ts"
  }
}
```

Merge it into the existing `scripts` object without removing any current script.

**Installed-tarball smoke flow:**

1. Pack and install the tarball into a temporary prefix as today.
2. Create a separate temporary Git repository and configure test identity.
3. Run the installed binary's `init --yes --output json`.
4. Create a supported Markdown document, stage all intended repository files, and commit.
5. Run installed `ingest --all --format json` and assert `commitSha` equals HEAD.
6. Run installed `query --format json` and assert `snapshotSha` and `snapshot.resolvedSha` equal HEAD.
7. Create and switch to a divergent branch, commit a document change, and do not ingest.
8. Spawn installed query, assert exit `3`, parse stdout, and assert `SNAPSHOT_NOT_INDEXED` for the divergent HEAD even though the earlier branch manifest exists.
9. Switch back and assert the original branch query still succeeds.
10. Clean both temporary directories and the generated tarball in `finally`.

Use `execFileSync` only for successful commands and `spawnSync` for the expected failure. Never invoke the source CLI in this script.

**Reference benchmark:**

- Create a temporary committed Git repository.
- Commit a `.gitignore` entry for `.ragit/manifest/` before generating benchmark manifests so runtime files do not become dirty worktree input.
- Initialize `.ragit/manifest` and write 1,000 valid final manifest files, including the exact HEAD manifest.
- Warm `selectSnapshot` five times.
- Measure thirty exact-HEAD selections with `performance.now()`.
- Sort durations, take index `Math.ceil(length * 0.95) - 1`, print JSON containing `samples`, `manifestCount`, and `p95Ms`, and throw when `p95Ms > 100`.
- Clean the temporary repository in `finally`.
- Keep this as a reference-local gate, not a claim about every filesystem or platform.

### Steps

- [ ] Extend the packed CLI smoke script with the exact success and divergent-branch failure flow.
- [ ] Run it before production changes are considered complete:

  ```bash
  pnpm build
  pnpm pack:smoke
  ```

  Expected: packed init, committed ingest, exact query, and strict missing-snapshot failure all pass.

- [ ] Add the benchmark script and package entry.
- [ ] Run the reference benchmark:

  ```bash
  pnpm benchmark:snapshot
  ```

  Expected: JSON reports `manifestCount: 1000`, `samples: 30`, and `p95Ms` no greater than `100` on the reference local environment.

- [ ] Confirm forbidden fallback imports are absent:

  ```bash
  rg -n 'latestSnapshotSha|resolveSnapshotRef' src/core/retrieval.ts src/core/ingest.ts
  ```

  Expected: no matches.

- [ ] Run the complete release verification without publishing:

  ```bash
  pnpm test
  pnpm build
  pnpm build:verify
  pnpm pack:verify
  pnpm pack:smoke
  pnpm docs:check:commands
  pnpm docs:check:internal-links
  pnpm docs:check:i18n
  pnpm docs:check:search-index
  ```

  Expected: every command succeeds. Do not change the package version and do not run a publish command.

- [ ] Commit the package and benchmark gates:

  ```bash
  git add scripts/smoke-packed-cli.mjs scripts/benchmark-snapshot-selection.ts package.json
  git commit -m "test(package): verify strict installed cli flow"
  ```

- [ ] Confirm the branch is clean and inspect the implementation-only commit sequence:

  ```bash
  git status --short
  git log --oneline 0d7ebdb..HEAD
  ```

  Expected: no status output and one plan commit followed by the focused implementation commits above.

---

## Specification Coverage Review

| Approved design requirement | Implemented in | Primary verification |
| --- | --- | --- |
| Worktree-root normalization | Task 2 | nested and linked-worktree integration plus CLI cwd assertion |
| HEAD, full SHA, and unique prefix only | Tasks 2 and 4 | Git context and selector tests |
| Exact manifest with no silent latest fallback | Tasks 4, 5, and 7 | divergent branch, explicit time travel, and forbidden-import scan |
| HEAD race retry once | Task 4 | fake-adapter one-move and repeated-move tests |
| Store and selection before embedding | Task 5 | fetch spy remains at zero |
| Query and context strict failure | Task 5 | retrieval and CLI integration tests |
| Recall keyword-only degradation | Task 6 | unavailable metadata, artifact hit, and zero-fetch assertions |
| Status remains diagnostic | Task 8 | missing, invalid, store-unavailable, and indexed matrix |
| Exact `--since` and partial ingest bases | Tasks 4 and 7 | ingest base matrix |
| Dirty and untracked candidate rejection | Task 7 | modified, deleted, untracked, code-only, and dry-run cases |
| Atomic individual manifest publication | Task 3 | atomic write and temporary-file visibility tests |
| Legacy manifest compatibility without rewrite | Task 3 | v2 immutability and normalization test |
| Future/corrupt manifest explicit failure | Tasks 3, 8, and 9 | manifest, status, and CLI exit-4 tests |
| Stable errors and exit classes | Tasks 1 and 9 | definition table and spawned CLI text/JSON tests |
| Additive `snapshotSha`, `snapshot`, and `warnings` | Tasks 5, 6, 8, and 9 | CLI success and degradation contract assertions |
| Installed CLI branch isolation | Task 11 | tarball smoke flow |
| p95 no greater than 100 ms with 1,000 manifests | Task 11 | reference benchmark |
| Commit-before-ingest onboarding | Tasks 7 and 10 | promotion regressions, fixture commits, and bilingual docs checks |
| No premature practical-readiness claim | Tasks 10 and 11 | documentation language and no release action |

## Final Acceptance Checklist

- [ ] Wrong-branch or wrong-SHA snapshot returns are zero across unit, integration, CLI, and packed tests.
- [ ] Every successful query and context result has `snapshotSha === snapshot.resolvedSha`.
- [ ] No embedding or store call occurs after snapshot selection failure.
- [ ] No dirty, deleted, or untracked document is persisted as commit-bound knowledge.
- [ ] Supported legacy manifests read successfully without file changes.
- [ ] Future, corrupt, and SHA-mismatched manifests fail explicitly.
- [ ] Text, JSON, and both formats agree on exit status.
- [ ] Current-HEAD status readiness does not depend on unrelated manifest count.
- [ ] The reference selection benchmark meets the approved p95 budget.
- [ ] Existing `snapshotSha` consumers and the full test suite have no regressions.
- [ ] The worktree is clean, the package version is unchanged, and no release was published.
