import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../src/core/config.js";
import {
  embedTexts,
  readEmbeddingCacheSummary,
  resolveEmbeddingCacheNamespaceId,
  resolveEmbeddingProfile,
} from "../src/core/embedding.js";

const tempDirs: string[] = [];

const makeTempDir = async (prefix: string): Promise<string> => {
  const temp = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(temp);
  return temp;
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0, tempDirs.length).map((target) => rm(target, { recursive: true, force: true })));
});

describe("embedding cache contract", () => {
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
