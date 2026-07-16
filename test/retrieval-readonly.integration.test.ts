import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig, loadConfig, writeConfig } from "../src/core/config.js";
import { packContext } from "../src/core/context.js";
import { embedText, EmbeddingCacheMissError, resolveEmbeddingProfile } from "../src/core/embedding.js";
import { runIngest } from "../src/core/ingest.js";
import { ensureRagitStructure } from "../src/core/project.js";
import { READ_ONLY_RETRIEVAL_POLICY, searchKnowledge } from "../src/core/retrieval.js";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const tempDirs: string[] = [];

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const snapshotTree = async (cwd: string, relative = ""): Promise<Record<string, string>> => {
  const result: Record<string, string> = {};
  const directory = path.join(cwd, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!relative && entry.name === ".git") continue;
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      Object.assign(result, await snapshotTree(cwd, child));
    } else {
      result[child] = createHash("sha256").update(await readFile(path.join(cwd, child))).digest("hex");
    }
  }
  return result;
};

const installOpenAiFetch = () => {
  process.env.OPENAI_API_KEY = "test-key";
  const fetchSpy = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { input: string[] | string };
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    return new Response(
      JSON.stringify({
        data: inputs.map((_text, index) => ({ index, embedding: Array(1536).fill((index + 1) / 10) })),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  globalThis.fetch = fetchSpy as typeof fetch;
  return fetchSpy;
};

const createIndexedRepository = async (
  prefix: string,
  provider: "local-placeholder" | "openai",
): Promise<string> => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(cwd);
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.email", "ragit@example.com"]);
  git(cwd, ["config", "user.name", "ragit-test"]);
  await mkdir(path.join(cwd, "docs"), { recursive: true });
  await writeFile(
    path.join(cwd, "docs", "readonly.spec.md"),
    "---\ntype: spec\narchitecture_view: lld\n---\n# Read-only Retrieval\nCached knowledge remains queryable without repository writes.\n",
    "utf8",
  );
  git(cwd, ["add", "--", "docs/readonly.spec.md"]);
  git(cwd, ["commit", "-m", "seed read-only retrieval doc"]);

  await ensureRagitStructure(cwd);
  const config = defaultConfig();
  config.embedding.provider = provider;
  if (provider === "openai") {
    delete config.embedding.dimensions;
    delete config.embedding.version;
  }
  await writeConfig(cwd, config);
  await runIngest(cwd, { all: true });
  return cwd;
};

afterEach(async () => {
  vi.restoreAllMocks();
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_OPENAI_API_KEY === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = ORIGINAL_OPENAI_API_KEY;
  await Promise.all(tempDirs.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

describe("read-only retrieval execution policy", () => {
  it("serves a cached OpenAI query without provider calls or repository byte changes", async () => {
    const fetchSpy = installOpenAiFetch();
    const cwd = await createIndexedRepository("ragit-retrieval-readonly-cached-", "openai");
    const profile = resolveEmbeddingProfile(await loadConfig(cwd));
    await embedText("cached retrieval question", profile, { cwd });
    fetchSpy.mockClear();
    const before = await snapshotTree(cwd);

    const result = await searchKnowledge(cwd, "cached retrieval question", {
      topK: 3,
      executionPolicy: READ_ONLY_RETRIEVAL_POLICY,
    });

    expect(result.hits).not.toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await snapshotTree(cwd)).toEqual(before);
  });

  it("rejects an uncached OpenAI query before provider execution and preserves bytes", async () => {
    const fetchSpy = installOpenAiFetch();
    const cwd = await createIndexedRepository("ragit-retrieval-readonly-miss-", "openai");
    fetchSpy.mockClear();
    const before = await snapshotTree(cwd);

    await expect(
      searchKnowledge(cwd, "uncached retrieval question", {
        executionPolicy: READ_ONLY_RETRIEVAL_POLICY,
      }),
    ).rejects.toBeInstanceOf(EmbeddingCacheMissError);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await snapshotTree(cwd)).toEqual(before);
  });

  it("rejects an uncached OpenAI context goal before provider execution and preserves bytes", async () => {
    const fetchSpy = installOpenAiFetch();
    const cwd = await createIndexedRepository("ragit-context-readonly-miss-", "openai");
    fetchSpy.mockClear();
    const before = await snapshotTree(cwd);

    await expect(
      packContext(cwd, "uncached context goal", {
        budget: 120,
        executionPolicy: READ_ONLY_RETRIEVAL_POLICY,
      }),
    ).rejects.toBeInstanceOf(EmbeddingCacheMissError);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await snapshotTree(cwd)).toEqual(before);
  });

  it("computes an uncached local query without cache writes", async () => {
    const cwd = await createIndexedRepository("ragit-retrieval-readonly-local-", "local-placeholder");
    const before = await snapshotTree(cwd);

    const result = await searchKnowledge(cwd, "uncached local retrieval question", {
      executionPolicy: READ_ONLY_RETRIEVAL_POLICY,
    });

    expect(result.hits).not.toHaveLength(0);
    expect(await snapshotTree(cwd)).toEqual(before);
  });

  it("keeps the default search path read-write", async () => {
    const fetchSpy = installOpenAiFetch();
    const cwd = await createIndexedRepository("ragit-retrieval-default-write-", "openai");
    fetchSpy.mockClear();
    const before = await snapshotTree(cwd);

    const result = await searchKnowledge(cwd, "default read-write retrieval question", {});

    expect(result.hits).not.toHaveLength(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(await snapshotTree(cwd)).not.toEqual(before);
  });
});
