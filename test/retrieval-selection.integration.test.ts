import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runInit } from "../src/commands/init.js";
import { defaultConfig, writeConfig } from "../src/core/config.js";
import { runIngest } from "../src/core/ingest.js";
import { searchKnowledge } from "../src/core/retrieval.js";
import { WORKTREE_DIRTY_SNAPSHOT_WARNING } from "../src/core/snapshot.js";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const cleanupPaths: string[] = [];

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const createIndexedRepository = async (prefix: string): Promise<{ cwd: string; indexedSha: string }> => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanupPaths.push(cwd);
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.email", "ragit@example.com"]);
  git(cwd, ["config", "user.name", "ragit-test"]);
  await mkdir(path.join(cwd, "docs"), { recursive: true });
  await writeFile(
    path.join(cwd, "docs", "selection.spec.md"),
    `---
type: spec
---
# Snapshot Selection
Committed snapshot marker remains authoritative for retrieval.
`,
    "utf8",
  );
  git(cwd, ["add", "."]);
  git(cwd, ["commit", "-m", "seed docs"]);

  await runInit(cwd, { nonInteractive: true });
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-m", "initialize ragit"]);
  const indexedSha = git(cwd, ["rev-parse", "HEAD"]);
  await runIngest(cwd, { all: true });
  return { cwd, indexedSha };
};

const commitFile = async (
  cwd: string,
  relativePath: string,
  contents: string,
  message: string,
): Promise<string> => {
  const target = path.join(cwd, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents, "utf8");
  git(cwd, ["add", "--", relativePath]);
  git(cwd, ["commit", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
};

const configureOpenAi = async (cwd: string): Promise<ReturnType<typeof vi.fn>> => {
  const config = defaultConfig();
  config.embedding.provider = "openai";
  delete config.embedding.dimensions;
  delete config.embedding.version;
  await writeConfig(cwd, config);
  process.env.OPENAI_API_KEY = "test-key";
  const fetchSpy = vi.fn(async () => new Response("provider must not be called", { status: 500 }));
  globalThis.fetch = fetchSpy as typeof fetch;
  return fetchSpy;
};

afterEach(async () => {
  vi.restoreAllMocks();
  if (ORIGINAL_FETCH === undefined) {
    // @ts-expect-error node fetch may be undefined in some runtimes
    delete globalThis.fetch;
  } else {
    globalThis.fetch = ORIGINAL_FETCH;
  }
  if (ORIGINAL_OPENAI_API_KEY === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = ORIGINAL_OPENAI_API_KEY;
  await Promise.all(cleanupPaths.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

describe("retrieval snapshot selection", () => {
  it("rejects a missing current HEAD even when another branch has an indexed manifest", async () => {
    const { cwd, indexedSha } = await createIndexedRepository("ragit-retrieval-missing-head-");
    git(cwd, ["branch", "indexed", indexedSha]);
    const missingSha = await commitFile(cwd, "src/runtime.ts", "export const changed = true;\n", "change code");

    await expect(searchKnowledge(cwd, "committed snapshot marker", { topK: 3 })).rejects.toMatchObject({
      code: "SNAPSHOT_NOT_INDEXED",
      details: {
        resolvedSha: missingSha,
        nearestIndexedAncestor: indexedSha,
      },
    });
  });

  it("supports explicit old-commit time travel without substituting the current snapshot", async () => {
    const { cwd, indexedSha } = await createIndexedRepository("ragit-retrieval-time-travel-");
    const currentSha = await commitFile(
      cwd,
      "docs/selection.spec.md",
      `---
type: spec
---
# Snapshot Selection
Current snapshot marker replaces the historical wording.
`,
      "update selection docs",
    );
    await runIngest(cwd, { since: indexedSha });

    const historical = await searchKnowledge(cwd, "committed snapshot marker", { at: indexedSha, topK: 3 });
    const current = await searchKnowledge(cwd, "current snapshot marker", { at: currentSha, topK: 3 });

    expect(historical.snapshotSha).toBe(indexedSha);
    expect(historical.snapshot).toMatchObject({
      requestedRef: indexedSha,
      resolvedSha: indexedSha,
      selection: "explicit-exact",
      status: "indexed",
    });
    expect(historical.hits[0]?.text).toContain("Committed snapshot marker");
    expect(current.snapshotSha).toBe(currentSha);
    expect(current.hits[0]?.text).toContain("Current snapshot marker");
  });

  it("returns the committed snapshot with a warning for dirty code-only changes", async () => {
    const { cwd, indexedSha } = await createIndexedRepository("ragit-retrieval-dirty-code-");
    await mkdir(path.join(cwd, "src"), { recursive: true });
    await writeFile(path.join(cwd, "src", "dirty.ts"), "export const dirty = true;\n", "utf8");

    const result = await searchKnowledge(cwd, "committed snapshot marker", { topK: 3 });

    expect(result.snapshotSha).toBe(indexedSha);
    expect(result.snapshot.worktreeDirty).toBe(true);
    expect(result.warnings).toContain(WORKTREE_DIRTY_SNAPSHOT_WARNING);
  });

  it("ignores dirty document contents and returns the committed snapshot with the same warning", async () => {
    const { cwd, indexedSha } = await createIndexedRepository("ragit-retrieval-dirty-doc-");
    await writeFile(
      path.join(cwd, "docs", "selection.spec.md"),
      `---
type: spec
---
# Snapshot Selection
Dirty document marker must not appear in snapshot-backed retrieval.
`,
      "utf8",
    );

    const result = await searchKnowledge(cwd, "committed snapshot marker", { topK: 3 });

    expect(result.snapshotSha).toBe(indexedSha);
    expect(result.warnings).toContain(WORKTREE_DIRTY_SNAPSHOT_WARNING);
    expect(result.hits[0]?.text).toContain("Committed snapshot marker");
    expect(result.hits[0]?.text).not.toContain("Dirty document marker");
  });

  it("keeps non-durable query scopes strict when the exact snapshot is missing", async () => {
    const { cwd } = await createIndexedRepository("ragit-retrieval-scope-");
    const missingSha = await commitFile(cwd, "src/runtime.ts", "export const changed = true;\n", "change code");

    await expect(searchKnowledge(cwd, "committed snapshot marker", { scope: "session", topK: 3 })).rejects.toMatchObject({
      code: "SNAPSHOT_NOT_INDEXED",
      details: { resolvedSha: missingSha },
    });
  });

  it("does not call the embedding provider when the exact manifest is missing", async () => {
    const { cwd } = await createIndexedRepository("ragit-retrieval-no-manifest-");
    const missingSha = await commitFile(cwd, "src/runtime.ts", "export const changed = true;\n", "change code");
    const fetchSpy = await configureOpenAi(cwd);

    await expect(searchKnowledge(cwd, "must not embed", { topK: 3 })).rejects.toMatchObject({
      code: "SNAPSHOT_NOT_INDEXED",
      details: { resolvedSha: missingSha },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("maps a missing canonical store before calling the embedding provider", async () => {
    const { cwd, indexedSha } = await createIndexedRepository("ragit-retrieval-no-store-");
    await rm(path.join(cwd, ".ragit", "store"), { recursive: true, force: true });
    const fetchSpy = await configureOpenAi(cwd);

    await expect(searchKnowledge(cwd, "must not embed", { topK: 3 })).rejects.toMatchObject({
      code: "SNAPSHOT_STORE_UNAVAILABLE",
      details: { resolvedSha: indexedSha },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("resolves nested cwd queries against the repository root store", async () => {
    const { cwd, indexedSha } = await createIndexedRepository("ragit-retrieval-nested-");
    const nested = path.join(cwd, "packages", "app", "src");
    await mkdir(nested, { recursive: true });

    const result = await searchKnowledge(nested, "committed snapshot marker", { topK: 3 });

    expect(result.snapshotSha).toBe(indexedSha);
    expect(result.snapshot.resolvedSha).toBe(indexedSha);
    expect(result.hits[0]?.path).toBe("docs/selection.spec.md");
  });
});
