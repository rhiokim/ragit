# Read-only MCP Projection Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship a fixed-repository stdio MCP executable that exposes only status, query, and context pack while proving every successful and failing call is byte-for-byte read-only.

**Architecture:** Add a fail-closed embedding-cache policy and thread it through existing retrieval APIs, then move the CLI's three read-command projections into one shared executor. Build a low-level MCP SDK v1 server with static tool schemas and handlers so RAGit owns structured validation errors, and guard the separate executable before any zvec import.

**Tech Stack:** TypeScript 5.9, Node.js 22.14+, Vitest 4, @modelcontextprotocol/sdk 1.29.0, zod 3.25, tsdown, pnpm, zvec 0.2.1, Fumadocs/Next.js

---

## Preconditions and Boundaries

- Work only in /Users/rhio/.config/superpowers/worktrees/ragit/read-only-mcp on branch feat/read-only-mcp.
- Treat docs/superpowers/specs/2026-07-16-read-only-mcp-design.md as authoritative.
- Keep package version 1.1.2 throughout workstream D.
- Do not change retrieval weights, benchmark datasets or thresholds, provider support labels, zvec version, or supported native targets.
- Do not add HTTP, authentication, resources, prompts, generic command dispatch, per-call cwd, background indexing, or write fallbacks.
- Use apply_patch for source and documentation edits. Dependency installation and formatter-generated lockfile changes are mechanical exceptions.
- Before every commit, run the named focused tests and git diff --check. Remove only hook-generated untracked .ragit files that were absent before the commit.

### Task 1: Fail Closed Before Provider Execution

**Files:**
- Modify: src/core/embedding.ts
- Modify: test/embedding-cache.test.ts

**Step 1: Write failing cache-miss tests**

Extend test/embedding-cache.test.ts with three cases:

1. An OpenAI profile with cacheMode=readonly and providerOnCacheMiss=deny rejects an uncached input with EmbeddingCacheMissError, calls fetch zero times, and does not create .ragit.
2. A partially cached remote batch rejects before any provider request and leaves every existing cache file byte-identical.
3. local-placeholder with cacheMode=readonly and providerOnCacheMiss=allow computes an embedding without creating .ragit.

Use this public contract in the assertions:

~~~ts
await expect(
  embedTexts(["uncached"], profile, {
    cwd,
    cacheMode: "readonly",
    providerOnCacheMiss: "deny",
  }),
).rejects.toMatchObject({
  name: "EmbeddingCacheMissError",
  provider: "openai",
  model: "text-embedding-3-small",
  missingCount: 1,
});
expect(fetchSpy).not.toHaveBeenCalled();
~~~

For the partial-hit case, populate one entry through the existing read-write default, snapshot the cache tree, clear fetchSpy, then request the cached and uncached strings together under deny.

**Step 2: Run the focused test and verify red**

Run:

~~~bash
pnpm vitest run test/embedding-cache.test.ts --pool=forks --no-isolate --maxWorkers=1 --no-file-parallelism
~~~

Expected: FAIL because providerOnCacheMiss and EmbeddingCacheMissError do not exist and the uncached request attempts provider execution.

**Step 3: Add the minimal embedding execution contract**

In src/core/embedding.ts add:

~~~ts
export type EmbeddingProviderOnCacheMiss = "allow" | "deny";

export interface EmbeddingExecutionOptions {
  cwd?: string;
  cacheMode?: EmbeddingCacheMode;
  providerOnCacheMiss?: EmbeddingProviderOnCacheMiss;
}

export class EmbeddingCacheMissError extends Error {
  readonly provider: EmbeddingProvider;
  readonly model: string;
  readonly missingCount: number;

  constructor(profile: EmbeddingProfile, missingCount: number) {
    super("read-only embedding cache does not contain every requested input");
    this.name = "EmbeddingCacheMissError";
    this.provider = profile.provider;
    this.model = profile.model;
    this.missingCount = missingCount;
  }
}
~~~

Inside embedTexts, collect unique cache misses while reading cache entries. When providerOnCacheMiss is deny, do not join an in-flight request and do not create a deferred request. After all cache lookups and before splitEmbeddingBatches or executeProviderBatchWithRetry, throw one EmbeddingCacheMissError if any unique miss exists.

Keep allow as the default so every current CLI, ingest, migration, benchmark, and provider test retains its behavior.

**Step 4: Run focused embedding tests and verify green**

~~~bash
pnpm vitest run test/embedding-cache.test.ts test/embedding.test.ts test/embedding-batch.test.ts --pool=forks --no-isolate --maxWorkers=1 --no-file-parallelism
~~~

Expected: PASS; no provider test changes its existing call count or retry behavior.

**Step 5: Inspect and commit**

~~~bash
git diff --check
git diff -- src/core/embedding.ts test/embedding-cache.test.ts
git add src/core/embedding.ts test/embedding-cache.test.ts
git commit -m "feat(embedding): deny provider execution on cache miss"
~~~

### Task 2: Propagate an Explicit Read-only Retrieval Policy

**Files:**
- Modify: src/core/retrieval.ts
- Modify: src/core/context.ts
- Create: test/retrieval-readonly.integration.test.ts

**Step 1: Write failing retrieval-policy integration tests**

Create test/retrieval-readonly.integration.test.ts. Reuse the repository setup style from test/status-snapshot.integration.test.ts and the repository-byte snapshot helper from test/ingest.integration.test.ts.

Cover:

- a cached OpenAI query succeeds with no fetch and no byte changes;
- an uncached OpenAI query throws EmbeddingCacheMissError before fetch and preserves bytes;
- an uncached OpenAI context-pack goal does the same;
- an uncached local-placeholder query succeeds without cache writes;
- the default searchKnowledge call still uses read-write cache behavior.

The policy passed to query and context must be:

~~~ts
export const READ_ONLY_RETRIEVAL_POLICY = {
  embeddingCacheMode: "readonly",
  remoteProviderOnCacheMiss: "deny",
} as const;
~~~

**Step 2: Run the new test and verify red**

~~~bash
pnpm vitest run test/retrieval-readonly.integration.test.ts --pool=forks --no-isolate --maxWorkers=1 --no-file-parallelism
~~~

Expected: FAIL because QueryOptions and ContextPackOptions do not accept an execution policy and retrieval still defaults to read-write cache access.

**Step 3: Add and thread the policy**

In src/core/retrieval.ts add:

~~~ts
export interface RetrievalExecutionPolicy {
  embeddingCacheMode?: EmbeddingCacheMode;
  remoteProviderOnCacheMiss?: EmbeddingProviderOnCacheMiss;
}

export const READ_ONLY_RETRIEVAL_POLICY: Readonly<RetrievalExecutionPolicy> = {
  embeddingCacheMode: "readonly",
  remoteProviderOnCacheMiss: "deny",
};
~~~

Add executionPolicy to QueryOptions and UnifiedRetrievalRequest. Resolve embedding options once per profile:

~~~ts
const embeddingOptionsForRetrieval = (
  cwd: string,
  profile: EmbeddingProfile,
  policy?: RetrievalExecutionPolicy,
): EmbeddingExecutionOptions => ({
  cwd,
  cacheMode: policy?.embeddingCacheMode,
  providerOnCacheMiss:
    policy?.remoteProviderOnCacheMiss === "deny" &&
    classifyEmbeddingEgress(profile) === "remote"
      ? "deny"
      : "allow",
});
~~~

Pass the resolved options to the query embedText call and to every embedTexts call in buildArtifactHits. Do not reconstruct options without the policy in a nested path.

In src/core/context.ts add executionPolicy to ContextPackOptions and pass it to runUnifiedRetrieval. Pass QueryOptions.executionPolicy from searchKnowledge to runUnifiedRetrieval.

**Step 4: Run focused retrieval tests**

~~~bash
pnpm vitest run test/retrieval-readonly.integration.test.ts test/query.integration.test.ts test/retrieval-selection.integration.test.ts test/embedding-execution.integration.test.ts --pool=forks --no-isolate --maxWorkers=1 --no-file-parallelism
~~~

Expected: PASS; cached remote reads are allowed, remote misses perform zero fetches, and existing retrieval behavior remains green.

**Step 5: Commit**

~~~bash
git diff --check
git add src/core/retrieval.ts src/core/context.ts test/retrieval-readonly.integration.test.ts
git commit -m "feat(retrieval): propagate read-only execution policy"
~~~

### Task 3: Share Read-command Normalization and Projection

**Files:**
- Create: src/core/readCommands.ts
- Create: test/read-commands.test.ts
- Modify: src/cli.ts
- Modify: test/cli.contract.test.ts

**Step 1: Write failing shared-executor tests**

Create test/read-commands.test.ts with injected fake dependencies for runStatus, searchKnowledge, and packContext. Assert:

- query trims and normalizes input, normalizes view, sanitizes the echoed query, merges redaction summaries, and projects hits with explain;
- context pack normalizes input and projects with the selected view;
- status returns the unchanged status object and an empty warnings array;
- retrieval execution policy is forwarded unchanged to query and context;
- unexpected input fields still fail through the existing normalizers.

~~~ts
const executor = createReadCommandExecutor(fakeDependencies);
const executed = await executor.query(
  "/repo",
  { question: "  restore auth  ", topK: 3, explain: true },
  { view: "minimal", executionPolicy: READ_ONLY_RETRIEVAL_POLICY },
);

expect(fakeDependencies.searchKnowledge).toHaveBeenCalledWith(
  "/repo",
  "restore auth",
  expect.objectContaining({
    topK: 3,
    executionPolicy: READ_ONLY_RETRIEVAL_POLICY,
  }),
);
expect(executed.data.explain).toBe(true);
expect(executed.data.hits[0].citation).toBeDefined();
~~~

**Step 2: Run and verify red**

~~~bash
pnpm vitest run test/read-commands.test.ts --pool=forks --no-isolate --maxWorkers=1 --no-file-parallelism
~~~

Expected: FAIL because src/core/readCommands.ts does not exist.

**Step 3: Implement the shared executor**

Create src/core/readCommands.ts with this production surface:

~~~ts
export interface ReadCommandDependencies {
  runStatus: typeof runStatus;
  searchKnowledge: typeof searchKnowledge;
  packContext: typeof packContext;
}

export interface ReadCommandOptions {
  view?: string;
  executionPolicy?: RetrievalExecutionPolicy;
}

export const createReadCommandExecutor = (
  dependencies: ReadCommandDependencies = defaultReadCommandDependencies,
) => ({
  status: async (cwd: string) => ({
    data: await dependencies.runStatus(cwd),
    warnings: [] as string[],
  }),

  query: async (cwd: string, value: unknown, options: ReadCommandOptions = {}) => {
    const input = normalizeQueryCommandInput(value);
    const view = normalizeCliView(options.view, "default");
    const result = await dependencies.searchKnowledge(cwd, input.question, {
      topK: input.topK,
      at: input.at,
      scope: input.scope,
      executionPolicy: options.executionPolicy,
    });
    const sanitized = sanitizeKnowledgeText(input.question, "query.output", "query");
    const redactionSummary = mergeRedactionSummaries(
      sanitized.summary,
      result.redactionSummary,
    );
    const normalizedResult = { ...result, redactionSummary };
    const data = {
      query: sanitized.text,
      snapshotSha: result.snapshotSha,
      snapshot: result.snapshot,
      scope: input.scope ?? "durable",
      explain: input.explain ?? false,
      hits: projectRetrievalHits(result.hits, view, input.explain ?? false),
      warnings: result.warnings,
      redactionSummary,
    };
    return { input, view, result: normalizedResult, data, warnings: result.warnings };
  },

  contextPack: async (
    cwd: string,
    value: unknown,
    options: ReadCommandOptions = {},
  ) => {
    const input = normalizeContextPackCommandInput(value);
    const view = normalizeCliView(options.view, "default");
    const packet = await dependencies.packContext(cwd, input.goal, {
      budget: input.budget,
      at: input.at,
      scope: input.scope,
      executionPolicy: options.executionPolicy,
    });
    return {
      input,
      view,
      packet,
      data: projectContextPack(packet, view),
      warnings: packet.warnings,
    };
  },
});

export const readCommandExecutor = createReadCommandExecutor();
~~~

Use precise imported result types rather than any.

**Step 4: Delegate the existing CLI actions**

Keep Commander parsing, mixed-input checks, text formatting, envelope building, output destinations, flags, and defaults unchanged. Replace only duplicated query, context-pack, and status orchestration with readCommandExecutor.

For query, pass the raw positional/JSON object and existing view value, build the same envelope from executed.data, and render text from executed.data.query, executed.result, executed.view, and executed.data.explain.

For context pack, pass the raw object and render from executed.packet and executed.view. For status, use executed.data in the existing envelope and formatter.

Update test/cli.contract.test.ts to compare the existing keys and defaults after delegation; do not change public output.

**Step 5: Run focused tests**

~~~bash
pnpm vitest run test/read-commands.test.ts test/cli.contract.test.ts test/output.test.ts test/context-selection.test.ts --pool=forks --no-isolate --maxWorkers=1 --no-file-parallelism
~~~

Expected: PASS with unchanged CLI envelopes and text behavior.

**Step 6: Commit**

~~~bash
git diff --check
git add src/core/readCommands.ts src/cli.ts test/read-commands.test.ts test/cli.contract.test.ts
git commit -m "refactor(cli): share read command execution"
~~~

### Task 4: Implement Static MCP Tool and Error Contracts

**Files:**
- Modify: package.json
- Modify: pnpm-lock.yaml
- Modify: src/core/cliInput.ts
- Create: src/mcp/contracts.ts
- Create: src/mcp/server.ts
- Create: test/mcp-server.test.ts

**Step 1: Write failing MCP server tests**

Create test/mcp-server.test.ts. Assert:

- tools/list returns exactly ragit_status, ragit_query, and ragit_context_pack;
- each schema has type=object and additionalProperties=false;
- query topK is integer 1..50 and context budget is integer 1..32000;
- annotations advertise read-only, non-destructive, idempotent, and closed-world behavior;
- successful calls contain identical parsed content JSON and structuredContent;
- invalid types, missing values, extra fields, fractional/oversized limits, and control characters return isError=true with MCP_INVALID_INPUT;
- RagitOperationalError passes through unchanged;
- EmbeddingCacheMissError maps to MCP_REMOTE_EMBEDDING_CACHE_MISS;
- unexpected errors map to MCP_INTERNAL_ERROR without stack or cause;
- dependencies receive only the constructor cwd;
- src/mcp does not import generic or mutating command modules.

**Step 2: Add exact dependencies**

~~~bash
pnpm add --save-exact @modelcontextprotocol/sdk@1.29.0
pnpm add zod@^3.25.76
~~~

Confirm package version remains 1.1.2.

**Step 3: Run the new test and verify red**

~~~bash
pnpm vitest run test/mcp-server.test.ts --pool=forks --no-isolate --maxWorkers=1 --no-file-parallelism
~~~

Expected: FAIL because src/mcp/server.ts and src/mcp/contracts.ts do not exist.

**Step 4: Export the existing control-character guard**

Rename the private scanControlCharacters function in src/core/cliInput.ts to exported assertNoControlCharacters without changing logic. Keep readJsonInput calling it. MCP normalization calls the same guard before existing command normalizers.

**Step 5: Implement strict input and envelope contracts**

In src/mcp/contracts.ts define:

~~~ts
export type McpOwnedErrorCode =
  | "MCP_INVALID_INPUT"
  | "MCP_REMOTE_EMBEDDING_CACHE_MISS"
  | "MCP_INTERNAL_ERROR";

export interface RagitMcpEnvelope<T> {
  ok: boolean;
  tool: string;
  version: string;
  cwd: string;
  data: T | null;
  warnings: string[];
  error?: RagitErrorPayload | McpOwnedErrorPayload;
}

export const successToolResult = <T>(
  tool: RagitMcpToolName,
  cwd: string,
  data: T,
  warnings: string[],
): CallToolResult => {
  const envelope = { ok: true, tool, version: RAGIT_VERSION, cwd, data, warnings };
  return {
    content: [{ type: "text", text: JSON.stringify(envelope) }],
    structuredContent: envelope,
  };
};
~~~

Add failureToolResult with identical text and structuredContent plus isError=true. Preserve RagitOperationalError.toPayload. Map EmbeddingCacheMissError without input text. Map input-phase failures to MCP_INVALID_INPUT and unknown execution failures to MCP_INTERNAL_ERROR.

Normalizers must require a plain object, call assertNoControlCharacters, reject unknown keys, peel view before existing command normalization, enforce safe-integer MCP maxima, and return normalized input plus normalizeCliView output.

**Step 6: Implement the low-level SDK server**

In src/mcp/server.ts:

1. Construct Server with name=ragit and RAGIT_VERSION.
2. Declare tools capability only.
3. Handle ListToolsRequestSchema with three literal definitions and strict JSON Schemas.
4. Handle CallToolRequestSchema with a switch over the same names.
5. Parse through contracts.ts, execute the matching injected read dependency, and wrap success/failure.
6. Pass READ_ONLY_RETRIEVAL_POLICY to query and context.
7. Return MCP_INVALID_INPUT for unknown tool names.

Production dependencies delegate only to readCommandExecutor.status, query, and contextPack.

Use this fixed registration shape:

~~~ts
export const createRagitMcpServer = ({
  cwd,
  dependencies = defaultMcpReadDependencies,
}: CreateRagitMcpServerOptions): Server => {
  const server = new Server(
    { name: "ragit", version: RAGIT_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: RAGIT_MCP_TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = request.params.name;
    const raw = request.params.arguments ?? {};
    if (!isRagitMcpToolName(tool)) {
      return invalidInputToolResult(tool, cwd, "unsupported MCP tool");
    }
    return executeRagitMcpTool({ tool, raw, cwd, dependencies });
  });

  return server;
};
~~~

**Step 7: Run focused MCP and input tests**

~~~bash
pnpm vitest run test/mcp-server.test.ts test/cli-hardening.test.ts test/read-commands.test.ts --pool=forks --no-isolate --maxWorkers=1 --no-file-parallelism
~~~

Expected: PASS.

**Step 8: Commit**

~~~bash
git diff --check
git add package.json pnpm-lock.yaml src/core/cliInput.ts src/mcp/contracts.ts src/mcp/server.ts test/mcp-server.test.ts
git commit -m "feat(mcp): expose bounded read-only tools"
~~~

### Task 5: Add the Guarded stdio Executable and Protocol E2E

**Files:**
- Create: src/mcp/startup.ts
- Create: src/mcp-entry.ts
- Create: test/mcp-protocol.integration.test.ts
- Modify: package.json
- Modify: tsdown.config.ts
- Modify: scripts/verify-build-contract.mjs
- Modify: scripts/verify-runtime-contract.mjs

**Step 1: Write failing startup and stdio tests**

Create test/mcp-protocol.integration.test.ts with:

- parser cases for omitted cwd, --cwd path, --cwd=path, --help, missing value, duplicate cwd, and unknown argument;
- an indexed temporary Git repository;
- a deterministic repository-relative path-to-SHA-256 map excluding .git and including all .ragit/worktree regular files;
- StdioClientTransport spawning process.execPath with --import tsx, src/mcp-entry.ts, and --cwd;
- initialization, tools/list, and one successful call to every tool;
- invalid-input and operational failures;
- a fresh byte map around every call;
- status against a non-RAGit Git repository proving .ragit remains absent;
- graceful close and no successful-startup stderr.

**Step 2: Run and verify red**

~~~bash
pnpm vitest run test/mcp-protocol.integration.test.ts --pool=forks --no-isolate --maxWorkers=1 --no-file-parallelism --teardownTimeout=30000
~~~

Expected: FAIL because the executable and startup parser do not exist.

**Step 3: Implement startup and stdio connection**

Create src/mcp/startup.ts:

~~~ts
export interface McpStartupOptions {
  cwd?: string;
  help: boolean;
}

export const parseMcpStartupArgs = (argv: string[]): McpStartupOptions => {
  let cwd: string | undefined;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      help = true;
      continue;
    }
    if (argument === "--cwd") {
      if (cwd !== undefined) {
        throw new Error("--cwd may be provided only once");
      }
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--") || !value.trim()) {
        throw new Error("--cwd requires a non-empty path");
      }
      cwd = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--cwd=")) {
      if (cwd !== undefined) {
        throw new Error("--cwd may be provided only once");
      }
      const value = argument.slice("--cwd=".length);
      if (!value.trim()) {
        throw new Error("--cwd requires a non-empty path");
      }
      cwd = value;
      continue;
    }
    throw new Error("unsupported ragit-mcp argument: " + argument);
  }

  return { cwd, help };
};

export const runMcpStdio = async (argv: string[]): Promise<void> => {
  const options = parseMcpStartupArgs(argv);
  if (options.help) {
    process.stdout.write(MCP_HELP_TEXT);
    return;
  }
  const cwd = await resolveCwd(options.cwd);
  const server = createRagitMcpServer({ cwd });
  await server.connect(new StdioServerTransport());
};
~~~

Create src/mcp-entry.ts so runtime validation precedes retrieval/store/zvec imports:

~~~ts
#!/usr/bin/env node

import { assertRagitRuntime } from "./core/runtime.js";

try {
  assertRagitRuntime();
  const { runMcpStdio } = await import("./mcp/startup.js");
  await runMcpStdio(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error("[ragit-mcp] error: " + message);
  process.exitCode = 1;
}
~~~

Do not print a startup banner.

**Step 4: Add build and runtime contracts**

Update package.json without removing scripts:

~~~json
{
  "bin": {
    "ragit": "dist/cli.js",
    "ragit-mcp": "dist/mcp.js"
  },
  "scripts": {
    "mcp": "tsx src/mcp-entry.ts"
  }
}
~~~

Add mcp: src/mcp-entry.ts to tsdown entry. Require dist/mcp.js and dist/mcp.d.ts in verify-build-contract; verify shebang, executable bit, and absence of static @zvec/zvec.

Update verify-runtime-contract to simulate unsupported Node/Linux x64/Windows x64 against both dist/cli.js and dist/mcp.js, with empty stdout and stable prefixes.

**Step 5: Run protocol, build, and runtime gates**

~~~bash
pnpm vitest run test/mcp-protocol.integration.test.ts test/mcp-server.test.ts --pool=forks --no-isolate --maxWorkers=1 --no-file-parallelism --teardownTimeout=30000
pnpm build
pnpm runtime:verify
pnpm build:verify
~~~

Expected: PASS.

**Step 6: Commit**

~~~bash
git diff --check
git add src/mcp/startup.ts src/mcp-entry.ts test/mcp-protocol.integration.test.ts package.json tsdown.config.ts scripts/verify-build-contract.mjs scripts/verify-runtime-contract.mjs
git commit -m "feat(mcp): ship guarded stdio server"
~~~

### Task 6: Prove the Packed MCP Binary

**Files:**
- Modify: scripts/verify-pack-contract.mjs
- Modify: scripts/smoke-packed-cli.mjs

**Step 1: Extend the pack contract**

Require dist/mcp.js and dist/mcp.d.ts, and assert package.json maps ragit-mcp to dist/mcp.js.

**Step 2: Extend installed-package smoke**

Resolve installed node_modules/.bin/ragit-mcp and assert executable access. After the existing CLI flow, snapshot repository bytes except .git, spawn the installed binary with Client/StdioClientTransport and --cwd repositoryDir, list exactly three tools, call all three, compare bytes after each call, and close in finally. Do not pass source paths or tsx.

**Step 3: Run package gates**

~~~bash
pnpm build
pnpm pack:verify
pnpm pack:smoke
pnpm pack:upgrade-smoke
~~~

Expected: PASS; packed MCP works and the existing 1.1.2 store reopens unchanged.

**Step 4: Commit**

~~~bash
git diff --check
git add scripts/verify-pack-contract.mjs scripts/smoke-packed-cli.mjs
git commit -m "test(package): verify installed MCP read paths"
~~~

### Task 7: Document MCP Setup and Read-only Guarantees

**Files:**
- Modify: README.md
- Create: apps/docs/content/docs/en/(workflows)/mcp-readonly.mdx
- Create: apps/docs/content/docs/ko/(workflows)/mcp-readonly.mdx
- Modify: apps/docs/content/docs/en/(workflows)/meta.json
- Modify: apps/docs/content/docs/ko/(workflows)/meta.json
- Modify: docs/superpowers/plans/2026-07-15-practical-readiness-final.md
- Modify: docs/superpowers/specs/2026-07-16-read-only-mcp-design.md

**Step 1: Add bilingual guidance**

Update the README runtime description so CLI is not called the only entrypoint. Add a Read-only MCP section after Installation covering:

- ragit-mcp --cwd /absolute/repo;
- a representative client configuration;
- exactly three tools;
- fixed repository per process and no HTTP;
- readonly cache behavior;
- loopback Ollama/local-placeholder misses without writes;
- cached-only OpenAI/non-loopback Ollama;
- inherited runtime matrix.

Create matching English/Korean workflow pages and add mcp-readonly after memory-model in both meta files. Do not document extra tools, per-call cwd, remote transport, auto-ingest, or v2 SDK.

**Step 2: Run documentation checks**

~~~bash
pnpm docs:check:i18n
pnpm docs:check:internal-links
pnpm docs:check:commands
pnpm docs:check:search-index
pnpm docs:build
~~~

Expected: PASS.

**Step 3: Record verification status and commit**

Set D to Verification in the master plan. Do not mark Complete until Task 8.

~~~bash
git diff --check
git add README.md "apps/docs/content/docs/en/(workflows)/mcp-readonly.mdx" "apps/docs/content/docs/ko/(workflows)/mcp-readonly.mdx" "apps/docs/content/docs/en/(workflows)/meta.json" "apps/docs/content/docs/ko/(workflows)/meta.json" docs/superpowers/plans/2026-07-15-practical-readiness-final.md docs/superpowers/specs/2026-07-16-read-only-mcp-design.md
git commit -m "docs(mcp): explain read-only agent integration"
~~~

### Task 8: Run the Complete D Gate and Close the Workstream

**Files:**
- Modify after evidence passes: docs/superpowers/plans/2026-07-15-practical-readiness-final.md
- Modify after evidence passes: docs/superpowers/specs/2026-07-16-read-only-mcp-design.md

**Step 1: Run focused D tests**

~~~bash
pnpm vitest run test/embedding-cache.test.ts test/retrieval-readonly.integration.test.ts test/read-commands.test.ts test/mcp-server.test.ts test/mcp-protocol.integration.test.ts test/cli.contract.test.ts --pool=forks --no-isolate --maxWorkers=1 --no-file-parallelism --teardownTimeout=30000
~~~

Expected: PASS.

**Step 2: Run the full suite**

~~~bash
pnpm test
~~~

Expected: every test passes.

**Step 3: Run retrieval-quality evidence**

~~~bash
pnpm benchmark:retrieval:verify --output /tmp/ragit-d-readonly-retrieval.json
shasum -a 256 /tmp/ragit-d-readonly-retrieval.json
~~~

Expected: PASS against unchanged thresholds and ranked paths. Do not commit the report.

**Step 4: Run distribution gates**

~~~bash
pnpm build
pnpm runtime:verify
pnpm build:verify
pnpm pack:verify
pnpm pack:smoke
pnpm pack:upgrade-smoke
~~~

Expected: all PASS.

**Step 5: Run documentation gates**

~~~bash
pnpm docs:build
pnpm docs:check:commands
pnpm docs:check:internal-links
pnpm docs:check:i18n
pnpm docs:check:search-index
~~~

Expected: all PASS.

**Step 6: Audit prohibited scope**

~~~bash
git diff origin/main...HEAD -- package.json pnpm-lock.yaml src test scripts apps/docs README.md
git diff origin/main...HEAD -- benchmarks .github/workflows src/core/runtime.ts
git diff --check
git status --short
~~~

Verify package version 1.1.2, zvec 0.2.1, SDK 1.29.0, and no changes to benchmark datasets/thresholds, score weights, provider support, native targets, or publish workflow. Verify no tarball, report, dist, cache, or hook output is untracked.

**Step 7: Record evidence and mark D complete**

Only after Steps 1–6 pass, set D to Complete and add exact command results, test counts, benchmark report hash, package smoke, and docs evidence to the design spec. Keep E Pending.

~~~bash
git add docs/superpowers/plans/2026-07-15-practical-readiness-final.md docs/superpowers/specs/2026-07-16-read-only-mcp-design.md
git commit -m "docs(mcp): record workstream verification"
~~~

Remove only hook-generated untracked .ragit files, then rerun:

~~~bash
pnpm test
git diff --check
git status --short --branch
~~~

Expected: full suite PASS and clean branch.

**Step 8: Finish the branch**

Invoke finishing-a-development-branch. Review every commit, push feat/read-only-mcp, create a focused PR, wait for all required checks, address only in-scope failures, and merge before workstream E.

The PR body must include the exact tools/fixed root, remote-cache fail-closed evidence, byte invariants, actual stdio/packed results, full test/benchmark/package/runtime/docs evidence, and prohibited-scope confirmation.
