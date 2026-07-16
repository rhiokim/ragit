import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runStatus } from "../src/commands/bootstrap.js";
import { runInit } from "../src/commands/init.js";
import { loadConfig, writeConfig } from "../src/core/config.js";
import { runIngest } from "../src/core/ingest.js";
import { CURRENT_MANIFEST_VERSION } from "../src/core/manifest.js";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const writeDoc = async (cwd: string, body = "Committed snapshot content."): Promise<void> => {
  await mkdir(path.join(cwd, "docs"), { recursive: true });
  await writeFile(
    path.join(cwd, "docs", "status.spec.md"),
    `---\ntype: spec\narchitecture_view: lld\n---\n# Status Snapshot\n${body}\n`,
    "utf8",
  );
};

const createInitializedRepository = async (prefix: string): Promise<{ cwd: string; headSha: string }> => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), prefix));
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.email", "ragit@example.com"]);
  git(cwd, ["config", "user.name", "ragit-test"]);
  await writeDoc(cwd);
  git(cwd, ["add", "--", "docs/status.spec.md"]);
  git(cwd, ["commit", "-m", "seed status doc"]);
  await runInit(cwd, { nonInteractive: true });
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-m", "initialize ragit"]);
  return { cwd, headSha: git(cwd, ["rev-parse", "HEAD"]) };
};

const createIndexedRepository = async (prefix: string): Promise<{ cwd: string; headSha: string }> => {
  const repository = await createInitializedRepository(prefix);
  await runIngest(repository.cwd, { all: true });
  return repository;
};

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_OPENAI_API_KEY === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = ORIGINAL_OPENAI_API_KEY;
});

describe("status current-HEAD snapshot diagnostics", () => {
  it("reports an indexed exact HEAD and its repository metadata", async () => {
    const { cwd, headSha } = await createIndexedRepository("ragit-status-indexed-");

    const status = await runStatus(cwd);

    expect(status.branch).toBe("main");
    expect(status.head).toBe(headSha);
    expect(status.snapshot).toEqual({
      requestedRef: "HEAD",
      resolvedSha: headSha,
      selection: "head-exact",
      status: "indexed",
      branch: "main",
      detached: false,
      worktreeDirty: false,
    });
    expect(status.zvec.status).toBe("loaded");
    expect(status.zvec.searchReady).toBe(true);
    expect(status.knowledge.durableReady).toBe(true);
  });

  it("does not treat an older unrelated manifest as current-HEAD readiness", async () => {
    const { cwd } = await createIndexedRepository("ragit-status-unindexed-head-");
    await writeFile(path.join(cwd, "notes.txt"), "new commit without a snapshot\n", "utf8");
    git(cwd, ["add", "--", "notes.txt"]);
    git(cwd, ["commit", "-m", "advance without ingest"]);
    const unindexedHead = git(cwd, ["rev-parse", "HEAD"]);

    const status = await runStatus(cwd);

    expect(status.manifests).toBeGreaterThan(0);
    expect(status.snapshot).toMatchObject({
      requestedRef: "HEAD",
      resolvedSha: unindexedHead,
      selection: "head-exact",
      status: "missing",
    });
    expect(status.zvec.searchReady).toBe(false);
    expect(status.knowledge.durableReady).toBe(false);
  });

  it("reports a corrupt exact manifest as invalid without failing status", async () => {
    const { cwd, headSha } = await createIndexedRepository("ragit-status-corrupt-");
    await writeFile(path.join(cwd, ".ragit", "manifest", `${headSha}.json`), "{not-json\n", "utf8");

    const status = await runStatus(cwd);

    expect(status.snapshot).toMatchObject({ resolvedSha: headSha, status: "invalid" });
    expect(status.zvec.searchReady).toBe(false);
    expect(status.knowledge.durableReady).toBe(false);
  });

  it("reports a future exact manifest as invalid without failing status", async () => {
    const { cwd, headSha } = await createIndexedRepository("ragit-status-future-");
    const manifestPath = path.join(cwd, ".ragit", "manifest", `${headSha}.json`);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.indexVersion = CURRENT_MANIFEST_VERSION + 1;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const status = await runStatus(cwd);

    expect(status.snapshot).toMatchObject({ resolvedSha: headSha, status: "invalid" });
    expect(status.zvec.searchReady).toBe(false);
    expect(status.knowledge.durableReady).toBe(false);
  });

  it("reports a valid exact manifest with a missing store as store-unavailable", async () => {
    const { cwd, headSha } = await createIndexedRepository("ragit-status-store-missing-");
    await rm(path.join(cwd, ".ragit", "store"), { recursive: true, force: true });

    const status = await runStatus(cwd);

    expect(status.snapshot).toMatchObject({ resolvedSha: headSha, status: "store-unavailable" });
    expect(status.zvec.status).toBe("missing");
    expect(status.zvec.searchReady).toBe(false);
    expect(status.knowledge.durableReady).toBe(false);
    expect(status.embedding.store).toBeNull();
  });

  it("reports a valid exact manifest with corrupt store metadata as store-unavailable", async () => {
    const { cwd, headSha } = await createIndexedRepository("ragit-status-store-corrupt-");
    await writeFile(path.join(cwd, ".ragit", "store", "meta.json"), "{}\n", "utf8");

    const status = await runStatus(cwd);

    expect(status.snapshot).toMatchObject({ resolvedSha: headSha, status: "store-unavailable" });
    expect(status.zvec.status).toBe("missing");
    expect(status.zvec.searchReady).toBe(false);
    expect(status.knowledge.durableReady).toBe(false);
    expect(status.embedding.store).toBeNull();
  });

  it("reports detached HEAD metadata while retaining exact snapshot readiness", async () => {
    const { cwd, headSha } = await createIndexedRepository("ragit-status-detached-");
    git(cwd, ["checkout", "--detach", headSha]);

    const status = await runStatus(cwd);

    expect(status.branch).toBeNull();
    expect(status.head).toBe(headSha);
    expect(status.snapshot).toMatchObject({
      resolvedSha: headSha,
      status: "indexed",
      branch: null,
      detached: true,
      worktreeDirty: false,
    });
  });

  it("reports dirty worktree metadata without invalidating the committed snapshot", async () => {
    const { cwd, headSha } = await createIndexedRepository("ragit-status-dirty-");
    await writeDoc(cwd, "Uncommitted worktree content.");

    const status = await runStatus(cwd);

    expect(status.snapshot).toMatchObject({
      resolvedSha: headSha,
      status: "indexed",
      worktreeDirty: true,
    });
    expect(status.zvec.searchReady).toBe(true);
    expect(status.knowledge.durableReady).toBe(true);
  });

  it("normalizes a nested cwd to the repository root before diagnosing status", async () => {
    const { cwd, headSha } = await createIndexedRepository("ragit-status-nested-");
    const nested = path.join(cwd, "packages", "app");
    await mkdir(nested, { recursive: true });

    const status = await runStatus(nested);

    expect(status.head).toBe(headSha);
    expect(status.snapshot).toMatchObject({ resolvedSha: headSha, status: "indexed" });
    expect(status.manifests).toBe(1);
  });

  it("reports an unborn HEAD as missing with nullable metadata", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "ragit-status-unborn-"));
    git(cwd, ["init", "-b", "main"]);
    await writeFile(path.join(cwd, "README.md"), "# Unborn repository\n", "utf8");

    const status = await runStatus(cwd);

    expect(status.branch).toBe("main");
    expect(status.head).toBeNull();
    expect(status.snapshot).toEqual({
      requestedRef: "HEAD",
      resolvedSha: null,
      selection: "head-exact",
      status: "missing",
      branch: "main",
      detached: false,
      worktreeDirty: true,
    });
    expect(status.zvec.searchReady).toBe(false);
    expect(status.knowledge.durableReady).toBe(false);
  });

  it("does not invoke a remote embedding provider while checking readiness", async () => {
    const { cwd, headSha } = await createInitializedRepository("ragit-status-no-provider-");
    const config = await loadConfig(cwd);
    config.embedding.provider = "openai";
    delete config.embedding.dimensions;
    delete config.embedding.version;
    await writeConfig(cwd, config);
    await rm(path.join(cwd, ".ragit", "store"), { recursive: true, force: true });
    process.env.OPENAI_API_KEY = "test-key";
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      return new Response(
        JSON.stringify({ data: body.input.map((_text, index) => ({ index, embedding: Array(1536).fill(0.1) })) }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    globalThis.fetch = fetchSpy as typeof fetch;
    await runIngest(cwd, { all: true });
    expect(fetchSpy).toHaveBeenCalled();
    fetchSpy.mockClear();

    const status = await runStatus(cwd);

    expect(status.snapshot).toMatchObject({ resolvedSha: headSha, status: "indexed" });
    expect(fetchSpy).not.toHaveBeenCalled();
  }, 20_000);
});
