# RAGit 2.0.0 Release and Registry Verification Plan

**Design:** `docs/superpowers/specs/2026-07-16-release-registry-design.md`
**Baseline:** `origin/main` at `f22e02d`
**Candidate version:** `2.0.0`
**Previous release:** `v1.1.2`

## 1. Freeze the release contract

- Confirm `v2.0.0`, npm `ragit@2.0.0`, and `chore/release-2.0.0` are unused.
- Confirm the candidate range is exactly `v1.1.2..HEAD`.
- Record the major-version rationale: Node floor and native platform compatibility changed.
- Verify the release diff does not modify runtime, retrieval, providers, thresholds, MCP tools, zvec, or workflow credentials.

**Verify:** Git, GitHub, and npm queries all show an unused release identity and a clean branch based on `f22e02d`.

## 2. Prepare release-only artifacts

- Change `package.json` from `1.1.2` to `2.0.0`.
- Run the pinned pnpm lockfile check; accept no lockfile diff when the root version is not represented.
- Add `docs/release-v2.0.0.md` from the merged PR and Git range.
- Update the README production support table with the major-version boundary and store-upgrade statement.
- Update English and Korean getting-started requirements in parallel.
- Record the release design and this plan.

**Verify:** `git diff --check`, docs i18n parity, and a prohibited-scope audit pass.

## 3. Run the complete local gate

Run, in order:

1. focused B1-D tests, including retrieval evaluation, explanations, context selection, embedding contracts, runtime guards, MCP server, and MCP protocol;
2. `pnpm test`;
3. `pnpm benchmark:retrieval:verify`;
4. `pnpm benchmark:retrieval:ollama:verify` against loopback Ollama only;
5. `pnpm build`;
6. `pnpm runtime:verify`;
7. `pnpm build:verify`;
8. `pnpm pack:verify`;
9. `pnpm pack:smoke`;
10. `pnpm pack:upgrade-smoke`;
11. `pnpm docs:build`;
12. all four docs checks;
13. `npm publish --dry-run --json`.

Do not run the paid OpenAI evidence profile. Do not tune thresholds after seeing a result.

**Verify:** every command exits zero; the candidate tarball reports `ragit@2.0.0`, includes both executable entrypoints, and reopens `1.1.2` state.

## 4. Commit and open the release PR

- Review the full range and release-only diff.
- Commit the mechanical candidate change separately from final evidence when practical.
- Push `chore/release-2.0.0`.
- Open a ready-for-review PR with semver rationale, breaking changes, exact commands, risk, and rollback notes.

**Verify:** the remote head equals the reviewed local head and the worktree is clean.

## 5. Require the distribution matrix

- Wait for Node `22.14.0` and 24 on macOS ARM64 and Linux ARM64.
- Inspect logs for tests, runtime guard, build, pack, CLI/MCP smoke, and baseline-store reopen.
- Address only release-blocking failures; never merge an unstable matrix.

**Verify:** all four checks report success and the PR merge state is clean.

## 6. Merge and publish through OIDC

- Rebase-merge the release PR.
- Fetch `origin/main` and capture the merged release SHA.
- Reconfirm npm and tag availability.
- Create `v2.0.0` at that exact SHA and push only that tag.
- Wait for `.github/workflows/publish.yml` to pass through `npm publish`.
- Create a GitHub release from the committed notes after the tag workflow succeeds.

**Verify:** the workflow event is `push`, head branch is `v2.0.0`, head SHA is the release SHA, and the publish step succeeds using OIDC.

## 7. Verify the public registry

- Poll npm until `ragit@2.0.0` is visible without using a local auth token.
- Capture `version`, `latest`, integrity, shasum, tarball, file count, unpacked size, signatures, and attestations.
- Inspect the provenance subject, repository, tag ref, workflow path, and source SHA.
- Install the exact version into a new temporary directory.
- Run the installed CLI and MCP smoke without referencing the source checkout.
- Hash repository-owned files before and after MCP calls.

**Verify:** registry, Git, GitHub, executable output, and provenance all identify the same `2.0.0` release.

## 8. Close the readiness program

- Report the release URL, npm package URL, workflow URL, release SHA, integrity, and provenance result.
- Record any known limitations without widening the supported contract.
- Mark E complete only after registry smoke passes.

**Verify:** no required work remains and no unpublished local release state exists.
