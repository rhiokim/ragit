# Runtime, Platform, and Packed Package E2E Implementation Plan

**Design:** `docs/superpowers/specs/2026-07-15-runtime-platform-package-e2e-design.md`
**Scope:** Workstream C
**Package version:** unchanged (`1.1.2`)

## 1. Lock the runtime contract

Files:

- `test/runtime.test.ts`
- `src/core/runtime.ts`
- `src/core/zvec.ts`
- `src/core/store.ts`

Verify:

- Node `22.14.0` and 24 pass; Node 20 and `22.13.x` fail.
- Only `darwin/arm64`, `linux/arm64`, and `linux/x64` pass.
- Windows diagnostics enumerate the supported matrix.

## 2. Guard executable startup

Files:

- `src/cli-entry.ts`
- `src/cli.ts`
- `scripts/verify-runtime-contract.mjs`
- `scripts/verify-build-contract.mjs`
- `package.json`

Verify:

- The built executable preserves its shebang and executable bit.
- A simulated `win32/x64` process receives the RAGit diagnostic before zvec can throw.
- Package metadata and the startup check both require Node `>=22.14.0`.

## 3. Project the same contract through diagnostics

Files:

- `src/commands/bootstrap.ts`
- `src/cli.ts`
- `test/cli.contract.test.ts`

Verify:

- `status` exposes the current Node, minimum Node, current target, supported targets, and aggregate support state.
- `doctor` includes passing Node and platform checks on supported CI targets.

## 4. Prove packed install and store reopen

Files:

- `scripts/smoke-packed-cli.mjs`
- `scripts/smoke-packed-upgrade.mjs`
- `package.json`

Verify:

- Candidate tarball completes `init → commit → ingest → query → context pack → status`.
- Candidate tarball reopens and queries a store created by registry `ragit@1.1.2`.
- Manifest and store metadata bytes remain unchanged during the reopen proof.

## 5. Add the declared matrix and user guidance

Files:

- `.github/workflows/runtime-matrix.yml`
- `README.md`
- `apps/docs/content/docs/en/(workflows)/getting-started.mdx`
- `apps/docs/content/docs/ko/(workflows)/getting-started.mdx`
- `apps/docs/content/docs/en/commands/init.mdx`
- `apps/docs/content/docs/ko/commands/init.mdx`
- `apps/docs/content/docs/en/commands/status.mdx`
- `apps/docs/content/docs/ko/commands/status.mdx`
- `apps/docs/content/docs/en/commands/doctor.mdx`
- `apps/docs/content/docs/ko/commands/doctor.mdx`
- `docs/superpowers/plans/2026-07-15-practical-readiness-final.md`

Verify:

- Documentation and code name the same Node floor and three targets.
- Linux guidance and CI declare and install the zvec `libaio` prerequisite.
- Windows is explicitly unsupported for zvec 0.2.1.
- All docs checks and the static docs build pass.

## 6. Release gate for C

Run focused tests first, then:

```bash
pnpm test
pnpm build
pnpm runtime:verify
pnpm build:verify
pnpm pack:verify
pnpm pack:smoke
pnpm pack:upgrade-smoke
pnpm docs:check:commands
pnpm docs:build
pnpm docs:check:internal-links
pnpm docs:check:i18n
pnpm docs:check:search-index
git diff --check
```

Open a focused PR, require every runtime-matrix lane to pass, then merge before starting workstream D.
