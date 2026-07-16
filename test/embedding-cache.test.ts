import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/core/config.js";
import {
  EmbeddingCacheMissError,
  embedTexts,
  readEmbeddingCacheSummary,
  resolveEmbeddingCacheNamespaceId,
  resolveEmbeddingProfile,
} from "../src/core/embedding.js";

const tempDirs: string[] = [];
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const makeTempDir = async (prefix: string): Promise<string> => {
  const temp = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(temp);
  return temp;
};

afterEach(async () => {
  vi.restoreAllMocks();
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_OPENAI_API_KEY === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = ORIGINAL_OPENAI_API_KEY;
  await Promise.all(tempDirs.splice(0, tempDirs.length).map((target) => rm(target, { recursive: true, force: true })));
});

const snapshotTree = async (cwd: string, relative = ""): Promise<Record<string, string>> => {
  const result: Record<string, string> = {};
  const directory = path.join(cwd, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      Object.assign(result, await snapshotTree(cwd, child));
    } else {
      result[child] = await readFile(path.join(cwd, child), "utf8");
    }
  }
  return result;
};

const createOpenAiProfile = () => {
  const config = defaultConfig();
  config.embedding.provider = "openai";
  return resolveEmbeddingProfile(config);
};

const installOpenAiFetch = (dimensions: number) => {
  process.env.OPENAI_API_KEY = "test-key";
  const fetchSpy = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { input: string[] | string };
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    return new Response(
      JSON.stringify({
        data: inputs.map((_text, index) => ({ index, embedding: Array(dimensions).fill((index + 1) / 10) })),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  globalThis.fetch = fetchSpy as typeof fetch;
  return fetchSpy;
};

describe("embedding cache contract", () => {
  it("fails a denied remote cache miss before provider execution or cache creation", async () => {
    const temp = await makeTempDir("ragit-embedding-cache-denied-");
    const profile = createOpenAiProfile();
    const fetchSpy = installOpenAiFetch(profile.dimensions);

    await expect(
      embedTexts(["uncached"], profile, {
        cwd: temp,
        cacheMode: "readonly",
        providerOnCacheMiss: "deny",
      }),
    ).rejects.toMatchObject({
      name: "EmbeddingCacheMissError",
      provider: "openai",
      model: "text-embedding-3-small",
      missingCount: 1,
    } satisfies Partial<EmbeddingCacheMissError>);

    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(access(path.join(temp, ".ragit"))).rejects.toThrow();
  });

  it("fails a partially cached remote batch atomically without changing cache bytes", async () => {
    const temp = await makeTempDir("ragit-embedding-cache-partial-");
    const profile = createOpenAiProfile();
    const fetchSpy = installOpenAiFetch(profile.dimensions);
    await embedTexts(["cached"], profile, { cwd: temp });
    const before = await snapshotTree(temp);
    fetchSpy.mockClear();

    await expect(
      embedTexts(["cached", "uncached"], profile, {
        cwd: temp,
        cacheMode: "readonly",
        providerOnCacheMiss: "deny",
      }),
    ).rejects.toMatchObject({
      name: "EmbeddingCacheMissError",
      provider: "openai",
      missingCount: 1,
    } satisfies Partial<EmbeddingCacheMissError>);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await snapshotTree(temp)).toEqual(before);
  });

  it("allows a local provider miss in readonly mode without creating a cache", async () => {
    const temp = await makeTempDir("ragit-embedding-cache-local-readonly-");
    const profile = resolveEmbeddingProfile(defaultConfig());

    const vectors = await embedTexts(["local cache miss"], profile, {
      cwd: temp,
      cacheMode: "readonly",
      providerOnCacheMiss: "allow",
    });

    expect(vectors[0]).toHaveLength(profile.dimensions);
    await expect(access(path.join(temp, ".ragit"))).rejects.toThrow();
  });

  it("changes the cache namespace when the provider profile changes", () => {
    const openAiSmallConfig = defaultConfig();
    openAiSmallConfig.embedding.provider = "openai";
    const openAiLargeConfig = defaultConfig();
    openAiLargeConfig.embedding.provider = "openai";
    openAiLargeConfig.embedding.model = "text-embedding-3-large";
    const ollamaConfig = defaultConfig();
    ollamaConfig.embedding.provider = "ollama";
    const customBaseUrlConfig = defaultConfig();
    customBaseUrlConfig.embedding.provider = "openai";
    customBaseUrlConfig.embedding.base_url = "https://example.invalid/custom";

    const openAiSmall = resolveEmbeddingProfile(openAiSmallConfig);
    const openAiLarge = resolveEmbeddingProfile(openAiLargeConfig);
    const ollama = resolveEmbeddingProfile(ollamaConfig);
    const customBaseUrl = resolveEmbeddingProfile(customBaseUrlConfig);

    expect(resolveEmbeddingCacheNamespaceId(openAiSmall)).not.toBe(resolveEmbeddingCacheNamespaceId(openAiLarge));
    expect(resolveEmbeddingCacheNamespaceId(openAiSmall)).not.toBe(resolveEmbeddingCacheNamespaceId(ollama));
    expect(resolveEmbeddingCacheNamespaceId(openAiSmall)).not.toBe(resolveEmbeddingCacheNamespaceId(customBaseUrl));
  });

  it("normalizes only newlines when computing cache entries", async () => {
    const temp = await makeTempDir("ragit-embedding-cache-normalize-");
    const profile = resolveEmbeddingProfile(defaultConfig());

    await embedTexts(["alpha\r\nbeta"], profile, { cwd: temp });
    let summary = await readEmbeddingCacheSummary(temp, profile);
    expect(summary.entryCount).toBe(1);

    await embedTexts(["alpha\nbeta"], profile, { cwd: temp });
    summary = await readEmbeddingCacheSummary(temp, profile);
    expect(summary.entryCount).toBe(1);

    await embedTexts(["alpha  beta"], profile, { cwd: temp });
    summary = await readEmbeddingCacheSummary(temp, profile);
    expect(summary.entryCount).toBe(2);
  });

  it("writes namespace metadata and entry files under the repo-local cache root", async () => {
    const temp = await makeTempDir("ragit-embedding-cache-files-");
    const profile = resolveEmbeddingProfile(defaultConfig());

    await embedTexts(["hello world", "topological memory"], profile, { cwd: temp });

    const namespaceId = resolveEmbeddingCacheNamespaceId(profile);
    const namespaceDir = path.join(temp, ".ragit", "cache", "embeddings", "v1", namespaceId);
    const manifest = JSON.parse(await readFile(path.join(namespaceDir, "namespace.json"), "utf8")) as {
      namespaceId: string;
      entryCount: number;
      provider: string;
      version: string;
      dimensions: number;
    };
    const entries = await readdir(path.join(namespaceDir, "entries"));

    expect(manifest.namespaceId).toBe(namespaceId);
    expect(manifest.provider).toBe(profile.provider);
    expect(manifest.version).toBe(profile.version);
    expect(manifest.dimensions).toBe(profile.dimensions);
    expect(manifest.entryCount).toBe(2);
    expect(entries).toHaveLength(2);
    expect(entries.every((name) => name.endsWith(".json"))).toBe(true);
  });

  it("treats cache vectors with non-numeric values as misses", async () => {
    const temp = await makeTempDir("ragit-embedding-cache-invalid-");
    const profile = resolveEmbeddingProfile(defaultConfig());
    const [initial] = await embedTexts(["cached value"], profile, { cwd: temp });
    const namespaceId = resolveEmbeddingCacheNamespaceId(profile);
    const entriesDir = path.join(temp, ".ragit", "cache", "embeddings", "v1", namespaceId, "entries");
    const [entryName] = await readdir(entriesDir);
    const entryPath = path.join(entriesDir, entryName!);
    const entry = JSON.parse(await readFile(entryPath, "utf8")) as { embedding: unknown[] };
    entry.embedding = ["not-a-number", ...initial!.slice(1)];
    await writeFile(entryPath, `${JSON.stringify(entry)}\n`, "utf8");

    await expect(embedTexts(["cached value"], profile, { cwd: temp, cacheMode: "readonly" })).resolves.toEqual([initial]);
  });
});
