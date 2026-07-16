# RAGit 2.0.0 (2026-07-16)

## Highlights

- Adds crash-safe, serialized knowledge-store writes with transaction journals, deterministic recovery diagnostics, finalization, and manifest-driven rebuilds.
- Makes retrieval evidence inspectable through an offline bilingual benchmark, stable citations, opt-in score explanations, and citation-diverse Context Pack v2 selection.
- Ships `ragit-mcp`, a fixed-repository stdio server with exactly three bounded read-only tools: `ragit_status`, `ragit_query`, and `ragit_context_pack`.
- Declares and tests the actual packed-package runtime matrix instead of inferring support from dependency metadata.
- Records live production evidence for loopback Ollama `nomic-embed-text` while keeping unproved provider claims out of the release contract.

## Breaking changes

- Node.js `>=22.14.0` is required; `ragit@1.1.2` required Node.js `>=20.19.0`.
- The supported native targets are macOS ARM64 and Linux ARM64. Linux x64, Windows x64, and other targets fail before zvec loads.
- Linux ARM64 requires `libaio` (`libaio-dev` on Debian/Ubuntu).

These runtime compatibility changes require the `2.0.0` major version. The full `ragit` CLI remains available under the same executable name.

## Upgrade notes

1. Confirm the host is macOS ARM64 or Linux ARM64.
2. Install Node.js `22.14.0` or newer; Node 24 is covered by the release matrix.
3. On Linux, install `libaio` before starting RAGit.
4. Back up `.ragit` before the major upgrade if rollback matters.
5. Install the exact release and verify it:

   ```bash
   npm install -g ragit@2.0.0
   ragit --version
   ragit status --format json
   ```

The package gate creates state with registry `ragit@1.1.2`, then installs the candidate and reopens and queries that store without rewriting its manifest or store metadata. Downgrading after a new `2.0.0` write is not a proved path.

## Features

### Reliable writes and recovery

- Serializes every store-mutating path behind the same writer lock ([#17](https://github.com/rhiokim/ragit/pull/17)).
- Journals snapshot publication and closes precommit/postcommit crash windows ([#18](https://github.com/rhiokim/ragit/pull/18), [#19](https://github.com/rhiokim/ragit/pull/19)).
- Diagnoses interrupted ingest work and provides bounded repair paths ([#20](https://github.com/rhiokim/ragit/pull/20)).
- Rebuilds canonical store state from durable manifests without rewriting those manifests ([#21](https://github.com/rhiokim/ragit/pull/21)).

### Retrieval quality and context

- Adds a deterministic bilingual retrieval evaluation corpus, metrics, thresholds, and regression gate ([#22](https://github.com/rhiokim/ragit/pull/22)).
- Adds stable source citations and opt-in ranking explanations to query output ([#23](https://github.com/rhiokim/ragit/pull/23)).
- Selects context packets with strict budgets, exact-citation deduplication, and source diversity while preserving deterministic ranking ([#24](https://github.com/rhiokim/ragit/pull/24)).

### Embedding providers

- Rejects malformed provider responses, bounds retry and timeout behavior, and namespaces cached embeddings by profile.
- Adds precommitted provider evidence profiles and a live loopback Ollama `nomic-embed-text` gate ([#25](https://github.com/rhiokim/ragit/pull/25)).
- Keeps OpenAI recognized, opt-in, fail-closed, and mock-contract-tested without claiming production support in this release.

### Distribution and MCP

- Guards Node and native-platform support before loading zvec and verifies installed tarballs on every declared target ([#28](https://github.com/rhiokim/ragit/pull/28)).
- Adds the read-only `ragit-mcp` stdio executable with fixed startup repository identity, strict schemas, bounded results, structured errors, and byte-preserving reads ([#29](https://github.com/rhiokim/ragit/pull/29)).
- Remote embedding profiles in MCP require a complete cache hit and fail before provider execution on a cache miss. The CLI remains the explicit path for writes and cache population.

## Security

- MCP handlers have no generic command dispatch or write-capable tool path.
- Repository-owned files, including `.ragit`, are hashed before and after MCP protocol calls in integration and packed-package smoke tests.
- Trusted Publishing uses GitHub OIDC with no long-lived npm write token and automatically emits npm/Sigstore provenance.

## Dependencies

- Pins `@modelcontextprotocol/sdk` to `1.29.0` for the production v1 protocol API.
- Adds direct `zod` `^3.25.76` validation support for MCP schemas.
- Keeps `@zvec/zvec` pinned at `0.2.1` and moves it to optional dependencies so the early RAGit runtime guard owns unsupported-target diagnostics.

## Operations / infrastructure

- Tests Node `22.14.0` and Node 24 on macOS ARM64 and Linux ARM64.
- Verifies the zvec binding, runtime guard, build contract, packed file list, installed CLI/MCP behavior, executable bits, and `1.1.2` store reopening.
- Publishes only from `.github/workflows/publish.yml` after a matching `v2.0.0` tag is pushed.

## Database / migrations

- No database migration command is required.
- The release gate proves forward opening from a registry `1.1.2` store to the `2.0.0` candidate.
- Reverse compatibility after new `2.0.0` writes is not claimed.

## Known issues

- Linux x64 and Windows x64 remain unsupported with the pinned zvec runtime.
- OpenAI is not an evidence-backed production profile for this release because paid live evidence was not authorized.
- `ragit-mcp` is intentionally read-only, stdio-only, and limited to one repository per process.

## Verification

The release candidate is accepted only after all of the following pass on the final release commit:

- focused B1-D tests and the full test suite;
- deterministic and Ollama-labeled retrieval gates;
- build, runtime, packed CLI/MCP, and `1.1.2` upgrade smoke contracts;
- bilingual documentation build and consistency checks;
- four-axis pull-request runtime matrix;
- tag-triggered Trusted Publishing;
- clean public-registry install, provenance, integrity, executable, CLI workflow, and MCP protocol verification.

## Risk / notes

- npm versions and release tags are immutable. If the tag workflow fails before publication, do not move `v2.0.0`; fix forward with a new patch version.
- Back up `.ragit` before the major upgrade when rollback is operationally important.
- Retrieval thresholds, score weights, provider support declarations, native targets, zvec, and MCP tool scope are unchanged by the release-only PR.
