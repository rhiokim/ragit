import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig, writeConfig } from "../src/core/config.js";
import { runIngest } from "../src/core/ingest.js";
import { readIngestTransaction } from "../src/core/ingest-transaction.js";
import { loadSnapshotManifest, snapshotManifestExists } from "../src/core/manifest.js";
import { ensureRagitStructure, resolveRagitPaths } from "../src/core/project.js";
import { searchKnowledge } from "../src/core/retrieval.js";
import { acquireStoreWriteLock } from "../src/core/store-write-lock.js";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const writeDoc = async (cwd: string, relativePath: string, title: string, body = "Committed knowledge."): Promise<void> => {
  const target = path.join(cwd, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `---\ntype: spec\narchitecture_view: lld\n---\n# ${title}\n${body}\n`, "utf8");
};

const createRepository = async (prefix: string): Promise<string> => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), prefix));
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.email", "ragit@example.com"]);
  git(cwd, ["config", "user.name", "ragit-test"]);
  await writeDoc(cwd, "docs/base.spec.md", "Base");
  git(cwd, ["add", "--", "docs/base.spec.md"]);
  git(cwd, ["commit", "-m", "seed docs"]);
  return cwd;
};

const configureOpenAi = async (cwd: string): Promise<ReturnType<typeof vi.fn>> => {
  await ensureRagitStructure(cwd);
  const config = defaultConfig();
  config.embedding.provider = "openai";
  delete config.embedding.dimensions;
  delete config.embedding.version;
  await writeConfig(cwd, config);
  process.env.OPENAI_API_KEY = "test-key";
  const fetchSpy = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { input: string[] };
    return new Response(
      JSON.stringify({ data: body.input.map(() => ({ embedding: Array(1536).fill(0.1) })) }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  globalThis.fetch = fetchSpy as typeof fetch;
  return fetchSpy;
};

const snapshotTree = async (cwd: string, relative = ""): Promise<Array<{ path: string; content: string }>> => {
  const directory = path.join(cwd, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const snapshot: Array<{ path: string; content: string }> = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!relative && entry.name === ".git") continue;
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) snapshot.push(...await snapshotTree(cwd, child));
    else snapshot.push({ path: child, content: await readFile(path.join(cwd, child), "utf8") });
  }
  return snapshot;
};

const loadOnlyIngestTransaction = async (cwd: string) => {
  const entries = (await readdir(resolveRagitPaths(cwd).runtimeTransactionsDir))
    .filter((entry) => entry.endsWith(".json"));
  if (entries.length !== 1) throw new Error(`expected one ingest transaction, found ${entries.length}`);
  const journal = await readIngestTransaction(cwd, entries[0]!.replace(/\.json$/, ""));
  if (journal === null) throw new Error("ingest transaction disappeared");
  return journal;
};

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_OPENAI_API_KEY === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = ORIGINAL_OPENAI_API_KEY;
});

describe("ingest integration", () => {
  it("rejects contention without acquiring a lock for dry-run", async () => {
    const temp = await createRepository("ragit-ingest-lock-");
    const paths = resolveRagitPaths(temp);

    await runIngest(temp, { all: true, dryRun: true });
    await expect(readFile(paths.storeWriteLockPath, "utf8")).rejects.toThrow();
    await expect(readdir(paths.runtimeTransactionsDir)).rejects.toThrow();

    const lock = await acquireStoreWriteLock(temp, { command: "migrate-embeddings" });
    try {
      await expect(runIngest(temp, { all: true })).rejects.toMatchObject({
        code: "STORE_WRITE_BUSY",
        exitCode: 3,
        retryable: true,
        details: { lockState: "active", owner: { token: lock.owner.token } },
      });
      await expect(readFile(paths.storeWriteLockPath, "utf8")).resolves.toContain(lock.owner.token);
    } finally {
      await lock.release();
    }
  });

  it("keeps a failed precommit journal when store writing fails", async () => {
    const temp = await createRepository("ragit-ingest-transaction-store-write-");
    await configureOpenAi(temp);
    const headSha = git(temp, ["rev-parse", "HEAD"]);

    await expect(
      runIngest(temp, { all: true }, {
        testHook: async (boundary) => {
          if (boundary === "store-written") throw new Error("injected store-written failure");
        },
      }),
    ).rejects.toThrow("injected store-written failure");

    await expect(snapshotManifestExists(temp, headSha)).resolves.toBe(false);
    await expect(loadSnapshotManifest(temp, headSha)).rejects.toMatchObject({ code: "SNAPSHOT_NOT_INDEXED" });
    await expect(loadOnlyIngestTransaction(temp)).resolves.toMatchObject({
      status: "failed-precommit",
      phase: "store-written",
      lastError: { message: "injected store-written failure" },
    });
  }, 20_000);

  it("detects missing records after closing and reopening the store before publishing", async () => {
    const temp = await createRepository("ragit-ingest-transaction-verify-");
    await configureOpenAi(temp);
    const headSha = git(temp, ["rev-parse", "HEAD"]);

    await expect(
      runIngest(temp, { all: true }, {
        testHook: async (boundary, context) => {
          if (boundary === "store-written") {
            context.store!.documents.deleteSync(context.documentVersionIds[0]!);
          }
        },
      }),
    ).rejects.toMatchObject({
      code: "INGEST_STORE_WRITE_UNVERIFIED",
      details: { missingDocumentVersionIds: [expect.any(String)] },
    });

    await expect(snapshotManifestExists(temp, headSha)).resolves.toBe(false);
    await expect(loadOnlyIngestTransaction(temp)).resolves.toMatchObject({
      status: "failed-precommit",
      phase: "store-written",
    });
  }, 20_000);

  it("rejects a HEAD movement after store verification without publishing", async () => {
    const temp = await createRepository("ragit-ingest-transaction-head-");
    await configureOpenAi(temp);
    const selectedHeadSha = git(temp, ["rev-parse", "HEAD"]);

    await expect(
      runIngest(temp, { all: true }, {
        testHook: async (boundary) => {
          if (boundary !== "store-verified") return;
          await writeFile(path.join(temp, "notes.txt"), "move HEAD\n", "utf8");
          git(temp, ["add", "--", "notes.txt"]);
          git(temp, ["commit", "-m", "move HEAD during ingest"]);
        },
      }),
    ).rejects.toMatchObject({
      code: "REPOSITORY_STATE_CHANGED",
      details: {
        selectedHeadSha,
        finalHeadSha: expect.any(String),
      },
    });

    await expect(snapshotManifestExists(temp, selectedHeadSha)).resolves.toBe(false);
    await expect(loadOnlyIngestTransaction(temp)).resolves.toMatchObject({
      status: "failed-precommit",
      phase: "store-verified",
    });
  }, 20_000);

  it("rejects a candidate that becomes dirty after store verification", async () => {
    const temp = await createRepository("ragit-ingest-transaction-dirty-");
    await configureOpenAi(temp);
    const headSha = git(temp, ["rev-parse", "HEAD"]);

    await expect(
      runIngest(temp, { all: true }, {
        testHook: async (boundary) => {
          if (boundary === "store-verified") {
            await writeDoc(temp, "docs/base.spec.md", "Changed after verification", "Dirty before manifest.");
          }
        },
      }),
    ).rejects.toMatchObject({
      code: "INGEST_CANDIDATES_DIRTY",
      details: { dirtyCandidates: ["docs/base.spec.md"] },
    });

    await expect(snapshotManifestExists(temp, headSha)).resolves.toBe(false);
    await expect(loadOnlyIngestTransaction(temp)).resolves.toMatchObject({
      status: "failed-precommit",
      phase: "store-verified",
    });
  }, 20_000);

  it("retains a committed journal and searchable manifest after postcommit failure", async () => {
    const temp = await createRepository("ragit-ingest-transaction-postcommit-");
    await configureOpenAi(temp);
    const headSha = git(temp, ["rev-parse", "HEAD"]);

    await expect(
      runIngest(temp, { all: true }, {
        testHook: async (boundary) => {
          if (boundary === "after-manifest") throw new Error("injected postcommit failure");
        },
      }),
    ).rejects.toThrow("injected postcommit failure");

    await expect(loadSnapshotManifest(temp, headSha)).resolves.toMatchObject({ commitSha: headSha });
    await expect(searchKnowledge(temp, "Committed knowledge", { at: headSha, topK: 1 })).resolves.toMatchObject({
      hits: [expect.objectContaining({ path: "docs/base.spec.md" })],
    });
    await expect(loadOnlyIngestTransaction(temp)).resolves.toMatchObject({
      status: "failed-postcommit",
      phase: "manifest-committed",
      lastError: { message: "injected postcommit failure" },
    });
  }, 20_000);

  it("completes the journal and releases the writer lock after a successful ingest", async () => {
    const temp = await createRepository("ragit-ingest-transaction-complete-");
    await configureOpenAi(temp);
    const paths = resolveRagitPaths(temp);

    await runIngest(temp, { all: true });

    await expect(loadOnlyIngestTransaction(temp)).resolves.toMatchObject({
      status: "completed",
      phase: "completed",
    });
    await expect(readFile(paths.storeWriteLockPath, "utf8")).rejects.toThrow();
  }, 20_000);

  it("uses a full base, exact indexed --since base, and the actual current parent", async () => {
    const temp = await createRepository("ragit-ingest-exact-since-");
    const baseSha = git(temp, ["rev-parse", "HEAD"]);
    const full = await runIngest(temp, { all: true });
    expect(full.fullSnapshot).toBe(true);
    expect(full.commitSha).toBe(baseSha);

    await writeFile(path.join(temp, "notes.txt"), "no snapshot for this commit\n", "utf8");
    git(temp, ["add", "--", "notes.txt"]);
    git(temp, ["commit", "-m", "notes only"]);
    const actualParentSha = git(temp, ["rev-parse", "HEAD"]);
    await writeDoc(temp, "docs/new.spec.md", "New", "Exact since base should retain prior docs.");
    git(temp, ["add", "--", "docs/new.spec.md"]);
    git(temp, ["commit", "-m", "add new doc"]);

    const incremental = await runIngest(temp, { since: baseSha });
    const manifest = await loadSnapshotManifest(temp, incremental.commitSha);
    expect(manifest.parentSha).toBe(actualParentSha);
    expect(manifest.docs.map((doc) => doc.path)).toEqual(expect.arrayContaining(["docs/base.spec.md", "docs/new.spec.md"]));
  }, 20_000);

  it("rejects an exact --since base that has no manifest", async () => {
    const temp = await createRepository("ragit-ingest-missing-since-");
    const baseSha = git(temp, ["rev-parse", "HEAD"]);
    await writeDoc(temp, "docs/new.spec.md", "New");
    git(temp, ["add", "--", "docs/new.spec.md"]);
    git(temp, ["commit", "-m", "add new doc"]);

    await expect(runIngest(temp, { since: baseSha })).rejects.toMatchObject({
      code: "INGEST_BASE_NOT_INDEXED",
      exitCode: 3,
      details: { baseSha },
    });
  });

  it("rejects a --since commit outside the current ancestry", async () => {
    const temp = await createRepository("ragit-ingest-non-ancestor-");
    const baseSha = git(temp, ["rev-parse", "HEAD"]);
    await runIngest(temp, { all: true });
    git(temp, ["switch", "-c", "side"]);
    await writeDoc(temp, "docs/side.spec.md", "Side");
    git(temp, ["add", "--", "docs/side.spec.md"]);
    git(temp, ["commit", "-m", "side commit"]);
    const sideSha = git(temp, ["rev-parse", "HEAD"]);
    git(temp, ["switch", "main"]);
    expect(git(temp, ["rev-parse", "HEAD"])).toBe(baseSha);
    await writeDoc(temp, "docs/main.spec.md", "Main");
    git(temp, ["add", "--", "docs/main.spec.md"]);
    git(temp, ["commit", "-m", "main commit"]);

    await expect(runIngest(temp, { since: sideSha })).rejects.toMatchObject({
      code: "INGEST_BASE_NOT_ANCESTOR",
      exitCode: 2,
      details: { baseSha: sideSha },
    });
  });

  it("uses exact HEAD and exact parent manifests for partial ingest, and rejects a missing partial base", async () => {
    const temp = await createRepository("ragit-ingest-partial-");
    await writeDoc(temp, "docs/retained.spec.md", "Retained");
    git(temp, ["add", "--", "docs/retained.spec.md"]);
    git(temp, ["commit", "-m", "add retained doc"]);
    const headWithSnapshot = git(temp, ["rev-parse", "HEAD"]);
    await runIngest(temp, { all: true });

    const sameHead = await runIngest(temp, { paths: ["docs/base.spec.md"] });
    expect(sameHead.commitSha).toBe(headWithSnapshot);
    expect((await loadSnapshotManifest(temp, headWithSnapshot)).docs.some((doc) => doc.path === "docs/retained.spec.md")).toBe(true);

    await writeDoc(temp, "docs/base.spec.md", "Base Updated");
    git(temp, ["add", "--", "docs/base.spec.md"]);
    git(temp, ["commit", "-m", "update base"]);
    const parentBased = await runIngest(temp, { paths: ["docs/base.spec.md"] });
    const parentManifest = await loadSnapshotManifest(temp, parentBased.commitSha);
    expect(parentManifest.docs.some((doc) => doc.path === "docs/retained.spec.md")).toBe(true);

    const missing = await createRepository("ragit-ingest-partial-missing-");
    await expect(runIngest(missing, { paths: ["docs/base.spec.md"] })).rejects.toMatchObject({
      code: "INGEST_BASE_NOT_INDEXED",
      exitCode: 3,
    });
  }, 20_000);

  it("rejects every relevant dirty document before embedding", async () => {
    const temp = await createRepository("ragit-ingest-dirty-");
    await writeDoc(temp, "docs/deleted.spec.md", "Deleted");
    git(temp, ["add", "--", "docs/deleted.spec.md"]);
    git(temp, ["commit", "-m", "add deletable doc"]);
    const fetchSpy = await configureOpenAi(temp);

    await writeDoc(temp, "docs/base.spec.md", "Modified");
    await writeDoc(temp, "docs/untracked.spec.md", "Untracked");
    await rm(path.join(temp, "docs/deleted.spec.md"));

    await expect(runIngest(temp, { all: true })).rejects.toMatchObject({
      code: "INGEST_CANDIDATES_DIRTY",
      exitCode: 3,
      details: {
        dirtyCandidates: ["docs/base.spec.md", "docs/deleted.spec.md", "docs/untracked.spec.md"],
      },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("ignores code-only dirtiness and filters dirty documents to an explicit path", async () => {
    const temp = await createRepository("ragit-ingest-dirty-filter-");
    await writeDoc(temp, "docs/outside.spec.md", "Outside");
    await mkdir(path.join(temp, "src"), { recursive: true });
    await writeFile(path.join(temp, "src/runtime.ts"), "export const value = 1;\n", "utf8");
    git(temp, ["add", "--", "docs/outside.spec.md", "src/runtime.ts"]);
    git(temp, ["commit", "-m", "add filter fixtures"]);
    await runIngest(temp, { all: true });

    await writeFile(path.join(temp, "src/runtime.ts"), "export const value = 2;\n", "utf8");
    const codeOnly = await runIngest(temp, { all: true });
    expect(codeOnly.dirtyCandidates).toEqual([]);

    await writeDoc(temp, "docs/outside.spec.md", "Outside Dirty");
    const explicit = await runIngest(temp, { paths: ["docs/base.spec.md"] });
    expect(explicit.dirtyCandidates).toEqual([]);

    await writeDoc(temp, ".ragit/private.spec.md", "Private");
    const filesFiltered = await runIngest(temp, { files: "docs/outside*.md", dryRun: true });
    expect(filesFiltered.dirtyCandidates).toEqual(["docs/outside.spec.md"]);

    const filesFilteredWithSince = await runIngest(temp, {
      files: "docs/outside*.md",
      since: git(temp, ["rev-parse", "HEAD"]),
      dryRun: true,
    });
    expect(filesFilteredWithSince.dirtyCandidates).toEqual(["docs/outside.spec.md"]);

    const broadFiles = await runIngest(temp, { files: "**/*.md", dryRun: true });
    expect(broadFiles.dirtyCandidates).not.toContain(".ragit/private.spec.md");
  }, 20_000);

  it("applies every comma-separated --files glob to dirty admission", async () => {
    const temp = await createRepository("ragit-ingest-dirty-files-list-");
    await writeDoc(temp, "docs/second.spec.md", "Second");
    git(temp, ["add", "--", "docs/second.spec.md"]);
    git(temp, ["commit", "-m", "add second doc"]);
    const fetchSpy = await configureOpenAi(temp);
    await runIngest(temp, { all: true });
    fetchSpy.mockClear();

    await writeDoc(temp, "docs/second.spec.md", "Second Dirty");

    await expect(runIngest(temp, { files: "docs/base*.md, docs/second*.md" })).rejects.toMatchObject({
      code: "INGEST_CANDIDATES_DIRTY",
      details: { dirtyCandidates: ["docs/second.spec.md"] },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("preserves negative --files glob semantics for deleted dirty paths", async () => {
    const temp = await createRepository("ragit-ingest-dirty-files-negative-");
    await writeDoc(temp, "docs/private/hidden.spec.md", "Private");
    git(temp, ["add", "--", "docs/private/hidden.spec.md"]);
    git(temp, ["commit", "-m", "add private doc"]);
    await runIngest(temp, { all: true });
    await rm(path.join(temp, "docs/private/hidden.spec.md"));

    const result = await runIngest(temp, {
      files: "docs/**/*.md,!docs/private/**",
      dryRun: true,
    });

    expect(result.dirtyCandidates).toEqual([]);
    expect(result.wouldFail).toBe(false);
    expect(result.plannedFiles).not.toContain("docs/private/hidden.spec.md");
  });

  it("returns deleted explicit paths in a dirty dry-run summary", async () => {
    const temp = await createRepository("ragit-ingest-dry-explicit-deleted-");
    await writeDoc(temp, "docs/deleted.spec.md", "Deleted");
    git(temp, ["add", "--", "docs/deleted.spec.md"]);
    git(temp, ["commit", "-m", "add explicit deleted doc"]);
    await runIngest(temp, { all: true });
    await rm(path.join(temp, "docs/deleted.spec.md"));

    const result = await runIngest(temp, { paths: ["docs/deleted.spec.md"], dryRun: true });

    expect(result.wouldFail).toBe(true);
    expect(result.dirtyCandidates).toEqual(["docs/deleted.spec.md"]);
    expect(result.plannedFiles).toEqual(["docs/deleted.spec.md"]);
    expect(result.processed).toBe(0);
  });

  it("blocks ignored untracked Markdown candidates before embedding", async () => {
    const temp = await createRepository("ragit-ingest-dirty-ignored-");
    await writeFile(path.join(temp, ".gitignore"), "docs/ignored/\n", "utf8");
    git(temp, ["add", "--", ".gitignore"]);
    git(temp, ["commit", "-m", "ignore generated docs"]);
    const fetchSpy = await configureOpenAi(temp);
    await runIngest(temp, { all: true });
    fetchSpy.mockClear();

    await writeDoc(temp, "docs/ignored/untracked.spec.md", "Ignored Untracked");

    await expect(runIngest(temp, { all: true })).rejects.toMatchObject({
      code: "INGEST_CANDIDATES_DIRTY",
      details: { dirtyCandidates: ["docs/ignored/untracked.spec.md"] },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("blocks skip-worktree Markdown changes before embedding", async () => {
    const temp = await createRepository("ragit-ingest-skip-worktree-");
    const fetchSpy = await configureOpenAi(temp);
    await runIngest(temp, { all: true });
    fetchSpy.mockClear();
    git(temp, ["update-index", "--skip-worktree", "docs/base.spec.md"]);
    await writeDoc(temp, "docs/base.spec.md", "Hidden Dirty", "Uncommitted secret must not bind to HEAD.");
    expect(git(temp, ["status", "--short", "--", "docs/base.spec.md"])).toBe("");

    await expect(runIngest(temp, { all: true })).rejects.toMatchObject({
      code: "INGEST_CANDIDATES_DIRTY",
      details: { dirtyCandidates: ["docs/base.spec.md"] },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("allows a clean skip-worktree Markdown candidate when its filtered content matches HEAD", async () => {
    const temp = await createRepository("ragit-ingest-clean-skip-worktree-");
    await runIngest(temp, { all: true });
    git(temp, ["update-index", "--skip-worktree", "docs/base.spec.md"]);

    const result = await runIngest(temp, { all: true });

    expect(result.dirtyCandidates).toEqual([]);
    expect(result.searchReady).toBe(true);
  });

  it("blocks a hidden tracked Markdown deletion before embedding", async () => {
    const temp = await createRepository("ragit-ingest-hidden-deletion-");
    const fetchSpy = await configureOpenAi(temp);
    await runIngest(temp, { all: true });
    fetchSpy.mockClear();
    git(temp, ["update-index", "--skip-worktree", "docs/base.spec.md"]);
    await rm(path.join(temp, "docs/base.spec.md"));
    expect(git(temp, ["status", "--short", "--", "docs/base.spec.md"])).toBe("");

    await expect(runIngest(temp, { all: true })).rejects.toMatchObject({
      code: "INGEST_CANDIDATES_DIRTY",
      details: { dirtyCandidates: ["docs/base.spec.md"] },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects root-level internal explicit document paths before embedding", async () => {
    const temp = await createRepository("ragit-ingest-internal-path-");
    const fetchSpy = await configureOpenAi(temp);
    await runIngest(temp, { all: true });
    fetchSpy.mockClear();
    const internalPaths = [
      ".git/injected.spec.md",
      ".ragit/injected.spec.md",
      "node_modules/injected.spec.md",
      "dist/injected.spec.md",
    ];
    for (const internalPath of internalPaths) {
      await writeDoc(temp, internalPath, "Injected");
      await expect(runIngest(temp, { paths: [internalPath] })).rejects.toThrow(/ingest\.path 값은 markdown 문서/);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects committed Markdown symlinks before embedding", async () => {
    const temp = await createRepository("ragit-ingest-symlink-");
    const outside = await mkdtemp(path.join(os.tmpdir(), "ragit-ingest-symlink-target-"));
    await writeDoc(outside, "outside.spec.md", "Outside Secret", "External content must never enter a snapshot.");
    await symlink(path.join(outside, "outside.spec.md"), path.join(temp, "docs", "linked.spec.md"));
    git(temp, ["add", "--", "docs/linked.spec.md"]);
    git(temp, ["commit", "-m", "add linked doc"]);
    const fetchSpy = await configureOpenAi(temp);

    await expect(runIngest(temp, { all: true })).rejects.toThrow(/regular file/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns a dirty dry-run summary for an ignored external symlink without embedding", async () => {
    const temp = await createRepository("ragit-ingest-dirty-symlink-");
    await writeFile(path.join(temp, ".gitignore"), "docs/ignored/\n", "utf8");
    git(temp, ["add", "--", ".gitignore"]);
    git(temp, ["commit", "-m", "ignore linked docs"]);
    const fetchSpy = await configureOpenAi(temp);
    await runIngest(temp, { all: true });
    fetchSpy.mockClear();
    const outside = await mkdtemp(path.join(os.tmpdir(), "ragit-ingest-dirty-symlink-target-"));
    await writeDoc(outside, "outside.spec.md", "Outside Dirty Secret");
    await mkdir(path.join(temp, "docs", "ignored"), { recursive: true });
    await symlink(path.join(outside, "outside.spec.md"), path.join(temp, "docs", "ignored", "linked.spec.md"));

    const result = await runIngest(temp, {
      paths: ["docs/ignored/linked.spec.md"],
      dryRun: true,
    });

    expect(result.wouldFail).toBe(true);
    expect(result.dirtyCandidates).toEqual(["docs/ignored/linked.spec.md"]);
    expect(result.processed).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports every dirty candidate in dry-run without mutating an uninitialized repository", async () => {
    const temp = await createRepository("ragit-ingest-dry-dirty-");
    await writeDoc(temp, "docs/deleted.spec.md", "Deleted");
    git(temp, ["add", "--", "docs/deleted.spec.md"]);
    git(temp, ["commit", "-m", "add deletable doc"]);
    await writeDoc(temp, "docs/base.spec.md", "Modified");
    await writeDoc(temp, "docs/untracked.spec.md", "Untracked");
    await rm(path.join(temp, "docs/deleted.spec.md"));
    const before = await snapshotTree(temp);

    const result = await runIngest(temp, { all: true, dryRun: true });

    expect(result.wouldFail).toBe(true);
    expect(result.dirtyCandidates).toEqual(["docs/base.spec.md", "docs/deleted.spec.md", "docs/untracked.spec.md"]);
    expect(await snapshotTree(temp)).toEqual(before);
    expect(before.some((entry) => entry.path.startsWith(".ragit/"))).toBe(false);
  });

  it("keeps a clean uninitialized dry-run completely side-effect free", async () => {
    const temp = await createRepository("ragit-ingest-dry-clean-");
    const before = await snapshotTree(temp);

    const result = await runIngest(temp, { all: true, dryRun: true });

    expect(result.wouldFail).toBe(false);
    expect(result.dirtyCandidates).toEqual([]);
    expect(result.searchReady).toBe(false);
    expect(await snapshotTree(temp)).toEqual(before);
    expect(before.some((entry) => entry.path.startsWith(".ragit/"))).toBe(false);
  });

  it("requires a concrete HEAD before initializing ingest state", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-ingest-unborn-"));
    git(temp, ["init", "-b", "main"]);

    await expect(runIngest(temp, { all: true })).rejects.toMatchObject({
      code: "SNAPSHOT_NOT_INDEXED",
      exitCode: 3,
      recovery: { command: "git status" },
    });
    expect((await readdir(temp)).includes(".ragit")).toBe(false);
  });

  it(
    "indexes only changed docs with --since",
    async () => {
      const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-test-"));
      git(temp, ["init"]);
      git(temp, ["config", "user.email", "ragit@example.com"]);
      git(temp, ["config", "user.name", "ragit-test"]);

      await mkdir(path.join(temp, "docs"), { recursive: true });
      await writeFile(
        path.join(temp, "docs", "plan.md"),
        `---
type: plan
---
# 실행계획
초기 계획`,
        "utf8",
      );
      git(temp, ["add", "."]);
      git(temp, ["commit", "-m", "init"]);
      const baseSha = git(temp, ["rev-parse", "HEAD"]);

      await runIngest(temp, { all: true });

      await writeFile(
        path.join(temp, "docs", "cache.spec.md"),
        `---
type: spec
architecture_view: lld
---
# 상세 명세
cache adapter`,
        "utf8",
      );
      await writeFile(
        path.join(temp, "docs", "runtime.pbd.md"),
        `---
type: pbd
architecture_view: hld
---
# PBD
phase and binding documents`,
        "utf8",
      );
      git(temp, ["add", "."]);
      git(temp, ["commit", "-m", "add spec and pbd"]);

      const summary = await runIngest(temp, { since: baseSha });
      expect(summary.processed).toBe(2);
      const manifest = await loadSnapshotManifest(temp, summary.commitSha);
      const types = new Set(manifest.docs.map((doc) => doc.docType));
      expect(types.has("plan")).toBe(true);
      expect(types.has("spec")).toBe(true);
      expect(types.has("pbd")).toBe(true);
      expect(manifest.docs.find((doc) => doc.path === "docs/runtime.pbd.md")?.docType).toBe("pbd");
    },
    15_000,
  );

  it(
    "skips blocked implicit docs, keeps include-based candidate resolution, and fails blocked explicit docs",
    async () => {
      const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-admission-ingest-"));
      git(temp, ["init"]);
      git(temp, ["config", "user.email", "ragit@example.com"]);
      git(temp, ["config", "user.name", "ragit-test"]);

      await mkdir(path.join(temp, "docs"), { recursive: true });
      await mkdir(path.join(temp, "notes"), { recursive: true });
      await mkdir(path.join(temp, "docs", "secrets"), { recursive: true });
      await writeFile(
        path.join(temp, "docs", "safe.spec.md"),
        `---
type: spec
---
# Safe
Only this document should be indexed.
`,
        "utf8",
      );
      await writeFile(
        path.join(temp, "docs", "secrets", "auth.md"),
        `---
type: spec
---
# Blocked
API_TOKEN=super-secret-value
PRIVATE_KEY=-----BEGIN PRIVATE KEY-----
`,
        "utf8",
      );
      await writeFile(
        path.join(temp, "notes", ".env.md"),
        `---
type: spec
---
# Outside include
Should not become an implicit ingest candidate.
`,
        "utf8",
      );
      git(temp, ["add", "."]);
      git(temp, ["commit", "-m", "seed admission fixtures"]);

      const implicit = await runIngest(temp, { all: true });
      expect(implicit.processed).toBe(1);
      expect(implicit.admission.blocked).toBe(1);
      expect(implicit.admission.items.some((item: (typeof implicit.admission.items)[number]) => item.sourceRef === "docs/secrets/auth.md")).toBe(true);
      expect(implicit.admission.items.some((item: (typeof implicit.admission.items)[number]) => item.sourceRef === "notes/.env.md")).toBe(false);

      const manifest = await loadSnapshotManifest(temp, implicit.commitSha);
      expect(manifest.docs.some((doc) => doc.path === "docs/safe.spec.md")).toBe(true);
      expect(manifest.docs.some((doc) => doc.path === "docs/secrets/auth.md")).toBe(false);
      expect(manifest.docs.some((doc) => doc.path === "notes/.env.md")).toBe(false);

      const explicitDryRun = await runIngest(temp, { paths: ["docs/secrets/auth.md"], dryRun: true });
      expect(explicitDryRun.admission.blocked).toBe(1);

      await expect(runIngest(temp, { paths: ["docs/secrets/auth.md"] })).rejects.toThrow(/explicit ingest 문서를 차단/);
    },
    15_000,
  );
});
