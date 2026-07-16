# Read-only MCP Projection Design

**Design direction:** Approved
**Written-spec review:** Approved
**Workstream:** D
**Approved approach:** Fixed-repository, in-process stdio adapter
**Baseline:** `origin/main` at `19d9708`, package `ragit@1.1.2`
**Date:** 2026-07-16
**Implementation plan:** docs/superpowers/plans/2026-07-16-read-only-mcp.md

## Outcome

Expose RAGit's existing status, query, and context-pack read paths to local MCP clients without making any write-capable command, repository switch, HTTP listener, or mutable embedding-cache path reachable from the MCP process.

The shipped executable is `ragit-mcp`. A client starts one process per repository and fixes that repository at process startup:

```text
ragit-mcp --cwd /absolute/path/to/repository
```

When `--cwd` is omitted, the process resolves its startup working directory once. Tool inputs never accept `cwd` and cannot change the fixed repository.

## Scope

Workstream D adds exactly three tools over stdio:

- `ragit_status`
- `ragit_query`
- `ragit_context_pack`

It also adds the minimum shared read-command execution layer needed for the CLI and MCP adapter to use the same input normalization, retrieval, masking, citation, snapshot, and result-projection contracts.

Workstream D does not add:

- HTTP, SSE, authentication, sessions, resources, prompts, sampling, or elicitation;
- generic command-registry exposure or any mutating command;
- per-call repository selection;
- background indexing, cache warming, automatic ingest, or fallback writes;
- retrieval-weight, benchmark-threshold, provider-support, native-target, or package-version changes;
- a public programmatic MCP export from the `ragit` package root.

## Approaches Considered

### 1. Fixed-repository in-process adapter — selected

The MCP server resolves one repository at startup and invokes the existing TypeScript read APIs directly. This keeps structured errors intact, avoids subprocess parsing, and prevents a model from using tool arguments to inspect another local repository.

### 2. Per-call repository in-process adapter — rejected

Accepting `cwd` on every tool would make one server convenient for multiple repositories, but it would widen the local data-access boundary and make the advertised fixed-workspace behavior false. MCP clients can instead configure one process per workspace.

### 3. CLI subprocess bridge — rejected

Spawning `ragit` and parsing JSON would reuse the executable contract, but it would duplicate envelope handling, weaken typed error propagation, add process overhead, and make write-path and stdout-discipline proofs harder.

## Dependency and Transport Contract

Pin `@modelcontextprotocol/sdk` at `1.29.0` for this release and add direct dependency `zod@^3.25.76`, which that SDK accepts. The v2 split-package SDK remains pre-release and is not part of workstream D.

Only `StdioServerTransport` is instantiated. Standard output is reserved for MCP JSON-RPC frames. Startup diagnostics and fatal errors go to standard error, and successful startup emits no free-form output.

The package adds a second executable mapping:

```json
{
  "bin": {
    "ragit": "dist/cli.js",
    "ragit-mcp": "dist/mcp.js"
  }
}
```

The build adds `src/mcp-entry.ts` as the `mcp` entry. No HTTP dependency or listener is introduced.

## Architecture

### Startup boundary

`src/mcp-entry.ts` owns only process concerns:

1. parse `--cwd <path>` and `--help` without writing to stdout after transport startup;
2. resolve the fixed repository root with the existing `resolveCwd` behavior;
3. construct the MCP server with that resolved root;
4. connect `StdioServerTransport`;
5. report fatal startup errors to stderr with a non-zero exit status.

Unknown startup arguments fail before the transport connects.

### Shared read-command execution

A focused shared module owns the application-level behavior currently assembled in CLI actions:

- normalize a query or context-pack input with the existing command normalizers;
- normalize the existing `minimal|default|full` view;
- execute `runStatus`, `searchKnowledge`, or `packContext`;
- sanitize the echoed query;
- project retrieval hits and context packets with the existing projection functions;
- return the same data object and warnings used by the CLI envelope.

The CLI delegates its existing query, context-pack, and status actions to this module. Its flags, text rendering, JSON envelope, exit behavior, and defaults remain unchanged. The MCP adapter delegates to the same module and wraps the returned data in an MCP-specific envelope.

### MCP registration boundary

`src/mcp/server.ts` constructs the SDK's low-level `Server` and installs static `tools/list` and `tools/call` request handlers for the three tools. It does not import `commandRegistry`, `cli.ts`, ingest, repair, memory, artifact mutation, config mutation, migration, hooks, or security-purge modules.

The low-level server is intentional. In SDK 1.29.0, high-level `McpServer.registerTool` validates a Zod input before invoking the tool callback and converts validation failures to an SDK-owned text-only error. Owning the two tool request handlers lets RAGit advertise strict JSON Schemas while returning the same structured RAGit failure envelope for schema, normalization, and execution failures. No generic protocol router is added.

The server constructor receives a narrow dependency object containing only the three shared read-command functions. This makes the allowed call graph explicit and lets tests prove that no generic or mutating executor is available.

Every listed tool is annotated as read-only, non-destructive, idempotent, and closed-world:

```text
readOnlyHint=true
destructiveHint=false
idempotentHint=true
openWorldHint=false
```

## Tool Contracts

### `ragit_status`

Input is an empty strict object. The result is the existing status data, including exact-HEAD snapshot readiness, runtime support, store state, configured embedding state, cache summary, security summary, writer-lock state, and recovery diagnostics.

### `ragit_query`

Input fields are:

- `question`: required non-empty string;
- `topK`: optional positive safe integer from 1 through 50;
- `at`: optional exact Git ref input resolved by the existing snapshot contract;
- `scope`: optional `durable|session|harness|evidence|all`, defaulting to `durable`;
- `view`: optional `minimal|default|full`, defaulting to `default`;
- `explain`: optional boolean, defaulting to `false`.

The data result matches the CLI query data projection: sanitized query, exact snapshot metadata, scope, explanation flag, projected hits, warnings, citations, and redaction summary.

### `ragit_context_pack`

Input fields are:

- `goal`: required non-empty string;
- `budget`: optional positive safe integer, with an MCP transport maximum of 32,000;
- `at`: optional exact Git ref input;
- `scope`: optional `durable|session|harness|evidence|all`, defaulting to `durable`;
- `view`: optional `minimal|default|full`, defaulting to `default`.

The data result is the existing projected context packet, including strict budget accounting, deterministic selection telemetry, exact citations, warnings, and redaction summary.

The MCP-only maxima bound response work without changing the CLI contract.

## Success and Error Envelopes

Successful calls return both JSON text content and identical `structuredContent`:

```json
{
  "ok": true,
  "tool": "ragit_query",
  "version": "1.1.2",
  "cwd": "/fixed/repository",
  "data": {},
  "warnings": []
}
```

Tool failures set `isError: true` and return both representations of a stable failure envelope:

```json
{
  "ok": false,
  "tool": "ragit_query",
  "version": "1.1.2",
  "cwd": "/fixed/repository",
  "data": null,
  "warnings": [],
  "error": {
    "code": "SNAPSHOT_NOT_INDEXED",
    "category": "not_ready",
    "message": "...",
    "retryable": false,
    "details": {},
    "recovery": { "command": "ragit ingest --all" }
  }
}
```

Existing `RagitOperationalError` payloads pass through unchanged. MCP input-schema and normalization failures map to a stable `MCP_INVALID_INPUT` payload. A remote embedding cache miss under the read-only policy maps to `MCP_REMOTE_EMBEDDING_CACHE_MISS`. Unexpected failures map to `MCP_INTERNAL_ERROR` without serializing stack traces, secrets, or arbitrary cause objects.

MCP-owned errors have these fixed properties:

| Code | Category | Retryable | Recovery |
| --- | --- | --- | --- |
| `MCP_INVALID_INPUT` | `invalid_input` | `false` | Correct the tool arguments and retry. |
| `MCP_REMOTE_EMBEDDING_CACHE_MISS` | `not_ready` | `false` | Run the equivalent CLI query outside MCP to populate the configured remote cache, then retry. |
| `MCP_INTERNAL_ERROR` | `transient` | `true` | Run `ragit doctor` and inspect stderr before retrying. |

## Read-only Retrieval Policy

The current CLI behavior remains the default. Workstream D adds an explicit retrieval execution policy that MCP passes through `searchKnowledge`, `packContext`, unified retrieval, and artifact candidate embedding.

The MCP policy is:

```text
embeddingCacheMode=readonly
remoteProviderOnCacheMiss=deny
```

`readonly` means cache namespace manifests and entries may be read but are never created, updated, touched, or counted as a hit by writing metadata.

Provider execution on a cache miss is decided from the existing embedding-egress classification:

- local placeholder: provider execution is allowed, cache writes remain disabled;
- loopback Ollama: provider execution is allowed, cache writes remain disabled;
- OpenAI: only complete cache hits are allowed; any miss fails before a provider request;
- non-loopback Ollama: only complete cache hits are allowed; any miss fails before a provider request.

The miss check occurs after all requested cache lookups but before any provider batch starts. A partially cached remote batch therefore fails as a unit without network egress or cache mutation.

The policy is propagated to both the query embedding and artifact/evidence candidate embeddings. No nested retrieval path may silently return to the existing read-write default.

Status does not invoke an embedding provider. It retains its existing read-only config, manifest, store-meta, cache-summary, security-state, lock, and recovery inspection paths.

## Filesystem Invariant

For every successful and failing MCP call:

- no `.ragit` path is created when it was absent;
- no cache namespace, cache entry, manifest, ledger, transaction journal, report, memory record, artifact, store file, config file, or repository document is created or changed;
- all repository-owned regular-file paths and bytes are identical before and after the call.

Tests compare a deterministic map of repository-relative path to content hash before and after each tool call. Runtime-owned `.git` files that can change because the test harness itself runs Git commands are excluded from the byte map; the repository worktree and all `.ragit` content are included. A separate assertion proves `.ragit` remains absent for status against an uninitialized repository.

## Verification Strategy

### Focused unit and integration tests

1. Embedding tests prove readonly hits do not touch entries and remote misses make zero provider requests and zero writes.
2. Retrieval tests prove the policy reaches query and artifact embedding paths while the default CLI path remains read-write compatible.
3. Shared read-command tests prove CLI-equivalent normalization and projection.
4. Protocol-handler tests prove the exact tool-name set, strict input JSON Schemas, and read-only annotations.
5. A source/import coverage test rejects forbidden mutating imports from the MCP subtree.
6. Handler tests cover success, operational failure, invalid input, remote-cache-miss, and unexpected-error envelopes.

### Protocol test

An SDK client spawns the actual `ragit-mcp` stdio entry and performs:

1. MCP initialization;
2. `tools/list`, expecting exactly three tools;
3. one successful call to each tool;
4. at least one failing call with a structured error;
5. repository byte-map comparison around every individual call;
6. graceful client and server shutdown.

### Package and regression gates

The packed tarball must contain an executable `dist/mcp.js` and install both bin links. The installed MCP binary must initialize and list the three tools without depending on the source checkout.

The workstream also runs:

- focused D tests;
- the full test suite;
- retrieval benchmark verification because retrieval execution is reachable;
- build, runtime, build-contract, pack-contract, packed CLI smoke, and upgrade smoke;
- documentation build, command contract, internal-link, i18n, and search-index checks;
- `git diff --check` and a prohibited-scope audit.

## Documentation

Add bilingual user guidance that includes:

- the `ragit-mcp --cwd <repo>` client configuration pattern;
- the exact three tools and their bounded inputs;
- the fixed-repository and read-only guarantees;
- local Ollama behavior versus cached-only remote-provider behavior;
- recovery guidance for an unindexed snapshot or remote cache miss;
- the supported Node and native-platform matrix inherited from workstream C.

## Exit Criteria

Workstream D is complete only when:

- the actual stdio protocol test initializes, lists, and calls all three tools;
- successful and failing calls return stable structured envelopes;
- each tool preserves the repository byte map;
- the static MCP call graph exposes no mutating command;
- packed installation exposes a working `ragit-mcp` executable;
- all focused, full-suite, benchmark, package, and documentation gates pass;
- the focused D pull request is green, reviewed, and merged before workstream E starts.

## Research Basis

- The official v1 SDK documents `McpServer`, `StdioServerTransport`, `registerTool`, structured content, and tool-level `isError` results: <https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/docs/server.md>
- The official SDK repository states that v1.x remains the production recommendation until v2 stabilizes: <https://github.com/modelcontextprotocol/typescript-sdk>
