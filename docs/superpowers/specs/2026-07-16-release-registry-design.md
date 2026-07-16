# RAGit 2.0.0 Release and Registry Verification Design

**Status:** Approved
**Release owner:** Sol Max
**Bounded implementation worker:** Terra
**Baseline:** `origin/main` at `f22e02d`, package `ragit@1.1.2`
**Release range:** `v1.1.2..release candidate`
**Date:** 2026-07-16

## Outcome

Publish one immutable `ragit@2.0.0` release whose Git commit, tag, GitHub release, npm metadata, tarball, executable contract, and provenance all identify the same source state.

The release is complete only after a clean install from the public npm registry passes the declared CLI and read-only MCP smoke paths. A successful local pack or GitHub workflow alone is not publication evidence.

## Semver Decision

The next version is `2.0.0`, not a minor or patch release.

Compared with `ragit@1.1.2`, the public runtime contract changes in breaking ways:

- the Node.js floor moves from `>=20.19.0` to `>=22.14.0`;
- the evidence-backed native matrix is limited to `darwin/arm64` and `linux/arm64`;
- Linux x64, Windows x64, and other targets now fail before loading zvec;
- the package adds a second executable, `ragit-mcp`, while retaining `ragit` as the full CLI.

The new retrieval explanations, citation-diverse context packing, crash recovery, provider evidence, and MCP reads are additive. They do not offset the runtime compatibility break.

## Operating Boundary

Terra may make deterministic, reviewable release-candidate edits:

- update the package version;
- draft release notes from the fixed Git range;
- update the README and bilingual onboarding text;
- run prescribed local checks and report exact results.

Sol Max retains decisions and external actions:

- semver and compatibility classification;
- interpretation of benchmark and distribution evidence;
- approval of every release commit;
- pull-request merge;
- release tag creation;
- npm Trusted Publishing;
- provenance and clean-registry acceptance.

Terra must not push, merge, tag, publish, change thresholds, widen provider support, or alter the supported native matrix.

## Release-Only Change Set

The release PR may change only:

- `package.json` version;
- release design, plan, notes, README, and bilingual onboarding documentation;
- release verification evidence recorded in those documents.

`pnpm-lock.yaml` does not encode the root package version in this workspace. It must be regenerated or checked with the pinned pnpm version, but a meaningless lockfile diff must not be manufactured.

The release PR must not change retrieval weights, datasets, thresholds, embedding behavior, MCP tools, zvec version, native targets, or publish credentials.

## Trusted Publishing Contract

The existing `.github/workflows/publish.yml` is the only allowed publisher. It must keep:

- GitHub-hosted execution;
- `contents: read` and `id-token: write`;
- a Node runtime at or above `22.14.0`;
- npm CLI `11.5.1` or newer before `npm publish`;
- tag-to-`package.json` version equality;
- no long-lived npm write token.

The npm Trusted Publisher identity must be `rhiokim/ragit`, workflow filename `publish.yml`, with `npm publish` allowed. The successful `ragit@1.1.2` publish and its SLSA attestation prove that this exact repository/workflow trust path was active before the release candidate. The tag workflow is still required to prove it for `2.0.0`.

Trusted Publishing generates provenance automatically for a public package from this public GitHub repository. The workflow must not disable provenance.

## Identity Invariants

After publication, all of the following must agree:

- `package.json` version: `2.0.0`;
- Git tag: `v2.0.0`;
- GitHub release target: the merged release commit;
- npm version and `latest` dist-tag: `2.0.0`;
- provenance source repository: `https://github.com/rhiokim/ragit`;
- provenance source ref: `refs/tags/v2.0.0`;
- provenance workflow: `.github/workflows/publish.yml`;
- installed `ragit --version`: `2.0.0`.

The registry integrity, shasum, tarball URL, file count, unpacked size, signatures, and attestation URL are captured as release evidence.

## Verification Layers

### Candidate content

- focused B1 through D tests;
- all 63 test files and 421 tests;
- deterministic retrieval benchmark;
- the approved loopback Ollama `nomic-embed-text` evidence profile;
- build, runtime, pack, installed CLI, upgrade, and MCP smoke contracts;
- bilingual docs build, command inventory, internal links, i18n parity, and search index;
- `npm publish --dry-run --json`.

OpenAI live evidence remains outside this release because paid execution was not authorized. Its profile stays recognized, fail-closed, and mock-contract-tested, but it is not described as production-supported.

### Distribution matrix

The release PR must pass Node `22.14.0` and Node 24 on both macOS ARM64 and Linux ARM64. All four jobs must install the packed candidate, verify the runtime guard, exercise CLI and MCP reads, and reopen the registry `1.1.2` baseline store.

### Registry install

A new temporary directory with no source-checkout dependency installs exactly `ragit@2.0.0`. It must verify:

- executable permissions for `ragit` and `ragit-mcp`;
- `ragit --version` and `ragit --help`;
- `init`, `ingest`, `status`, `query`, and `context pack`;
- MCP initialize, exact three-tool listing, and one bounded read call;
- repository-owned bytes remain unchanged by MCP reads.

## Publication Sequence

1. Push the release-only branch and open a focused PR.
2. Wait for all four runtime-matrix jobs and review the exact diff.
3. Rebase-merge the PR, matching repository convention.
4. Confirm `v2.0.0` and `ragit@2.0.0` are still unused.
5. Create and push immutable `v2.0.0` at the merged release commit.
6. Wait for the tag-triggered publish workflow; do not publish locally.
7. Create the GitHub release for the verified tag using the committed release notes.
8. Verify npm metadata, provenance, integrity, and the clean registry smoke.

The repository currently has no configured local Git signing key and previous release tags are lightweight. Do not fabricate a signed-tag claim. The package's cryptographic source identity is the npm/Sigstore provenance generated by the GitHub OIDC publish. The Git tag and GitHub release still remain immutable release identifiers.

## Failure and Rollback

- Before tagging, fix the release PR and rerun all gates.
- After tagging but before a successful publish, never move or delete the public tag to reuse the version. Fix forward with `2.0.1`, following the immutable-tag precedent from `1.1.1` to `1.1.2`.
- After npm publication, never overwrite or republish `2.0.0`.
- Existing `1.1.2` stores are proven readable by the candidate without rewriting their manifest or store metadata.
- Downgrading a repository after a new `2.0.0` write is not a proved path. Back up `.ragit` before relying on rollback across the major boundary.

## Exit

Workstream E is complete only when the merged commit, `v2.0.0`, GitHub release, npm `2.0.0` metadata, Sigstore/SLSA provenance, and clean installed smoke all agree and pass.
