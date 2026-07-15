# Runtime, Platform, and Packed Package E2E Design

**Status:** Approved (evidence-based target revision)
**Owner:** Sol Max
**Implementation boundary:** Workstream C only
**Date:** 2026-07-15

## Goal

Make RAGit's declared runtime and native-platform support match what the packed npm artifact actually proves.

## Approved Contract

- Minimum Node.js: `22.14.0`.
- Compatibility lane: Node.js 24.
- Production-supported native targets:
  - `darwin/arm64`
  - `linux/arm64`
- Linux requires the zvec runtime dependency `libaio`; Debian/Ubuntu CI installs `libaio-dev` before loading the binding.
- `linux/x64` and `win32/x64` are unsupported in this release and must fail before `@zvec/zvec` loads.
- Keep `@zvec/zvec@0.2.1` pinned. A zvec upgrade and Windows support require a separate compatibility workstream.
- Do not change package version, retrieval behavior, provider thresholds, MCP, or publishing behavior in C.

Node 20 is excluded because it is end-of-life. Node 22 and 24 are the supported LTS lines for this package contract.

The initial matrix included Linux x64. PR run [29422478371](https://github.com/rhiokim/ragit/actions/runs/29422478371) proved that the pinned zvec 0.2.1 binding terminates with `SIGILL` during direct import on the standard Ubuntu 24 x64 runner under both Node 22.14 and Node 24, even with `libaio` installed. The contract therefore excludes Linux x64 instead of hiding the binding failure or changing zvec inside C.

## Runtime Boundary

The executable entrypoint becomes a lightweight guard:

1. Validate the running Node version.
2. Validate the exact `platform/arch` pair.
3. Only then dynamically load the CLI implementation and its zvec dependency graph.

This ordering is required because zvec 0.2.1 imports its native binding at module evaluation time. Without a guard, an unsupported target fails with an upstream binary-resolution error before RAGit can state its own support policy.

RAGit declares zvec as a platform optional dependency so an unsupported native package failure does not prevent the executable guard from reporting the RAGit matrix. On every supported target, the packed E2E requires zvec to be installed and fully operational; it is not an optional runtime capability there.

The same pure runtime contract feeds:

- executable startup;
- `status` runtime fields;
- `doctor` checks;
- unit and built-artifact contract tests;
- the documented support table.

## Packed Artifact Proof

The existing packed CLI smoke is extended to run:

`init → commit → ingest → query → context pack → status`

It must assert exact snapshot binding for query, context pack, and status, while retaining the existing divergent-branch isolation check.

A second packed smoke installs the registry baseline `ragit@1.1.2`, creates and ingests a repository, then opens that repository with the candidate tarball. It proves the current package can reopen the existing zvec store and query its committed snapshot without rewriting the manifest or store metadata.

## CI Matrix

The pull-request matrix uses standard GitHub-hosted runners:

| Lane | Runner | Node | Expected target |
| --- | --- | --- | --- |
| Minimum Linux ARM64 | `ubuntu-24.04-arm` | `22.14.0` | `linux/arm64` |
| Current LTS Linux ARM64 | `ubuntu-24.04-arm` | `24` | `linux/arm64` |
| Minimum macOS ARM64 | `macos-latest` | `22.14.0` | `darwin/arm64` |
| Current LTS macOS ARM64 | `macos-latest` | `24` | `darwin/arm64` |

Every lane verifies its actual target, installs declared system prerequisites, performs a frozen install, imports the zvec binding directly, runs tests, builds, verifies the build and pack contracts, and executes both packed smokes.

## Exit Criteria

- Package metadata requires Node `>=22.14.0`.
- Unsupported Node and platform cases fail before zvec binding import with an accurate RAGit diagnostic.
- `status`, `doctor`, README, bilingual docs, runtime constants, and CI list the same two targets.
- The full packed flow and registry-baseline reopen smoke pass locally and on all four CI lanes.
- Full tests, docs checks/build, build verification, pack verification, and `git diff --check` pass.
