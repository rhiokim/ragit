import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../src/core/config.js";
import { embedText, EmbeddingProviderError, resolveEmbeddingConfiguredState, resolveEmbeddingProfile } from "../src/core/embedding.js";

const ORIGINAL_ENV = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL,
};

afterEach(() => {
  if (ORIGINAL_ENV.OPENAI_API_KEY === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = ORIGINAL_ENV.OPENAI_API_KEY;
  if (ORIGINAL_ENV.OPENAI_BASE_URL === undefined) delete process.env.OPENAI_BASE_URL;
  else process.env.OPENAI_BASE_URL = ORIGINAL_ENV.OPENAI_BASE_URL;
  if (ORIGINAL_ENV.OLLAMA_BASE_URL === undefined) delete process.env.OLLAMA_BASE_URL;
  else process.env.OLLAMA_BASE_URL = ORIGINAL_ENV.OLLAMA_BASE_URL;
});

describe("embedding profile resolution", () => {
  it("keeps local-placeholder defaults as the effective profile", () => {
    const profile = resolveEmbeddingProfile(defaultConfig());
    expect(profile.provider).toBe("local-placeholder");
    expect(profile.model).toBe("placeholder-v1");
    expect(profile.dimensions).toBe(64);
    expect(profile.version).toBe("v1");
    expect(profile.baseUrl).toBeNull();
    expect(profile.ignoredLegacyFields).toEqual([]);
  });

  it("prefers configured base_url and ignores legacy dimensions/version for openai", () => {
    process.env.OPENAI_BASE_URL = "http://env.example";
    const config = defaultConfig();
    config.embedding.provider = "openai";
    config.embedding.model = "text-embedding-3-large";
    config.embedding.base_url = "http://config.example";
    config.embedding.dimensions = 999;
    config.embedding.version = "legacy";

    const configured = resolveEmbeddingConfiguredState(config);
    const profile = resolveEmbeddingProfile(config);

    expect(configured.baseUrl).toBe("http://config.example");
    expect(profile.provider).toBe("openai");
    expect(profile.model).toBe("text-embedding-3-large");
    expect(profile.dimensions).toBe(3072);
    expect(profile.version).toBe("openai-text-embedding-3-large-3072");
    expect(profile.ignoredLegacyFields).toEqual(["dimensions", "version"]);
  });

  it("uses ollama defaults when only the provider changes", () => {
    const config = defaultConfig();
    config.embedding.provider = "ollama";
    delete config.embedding.model;

    const profile = resolveEmbeddingProfile(config);

    expect(profile.provider).toBe("ollama");
    expect(profile.model).toBe("nomic-embed-text");
    expect(profile.baseUrl).toBe("http://127.0.0.1:11434");
    expect(profile.dimensions).toBe(768);
    expect(profile.version).toBe("ollama-nomic-embed-text-768");
  });

  it("raises a normalized credential error when openai key is missing", async () => {
    delete process.env.OPENAI_API_KEY;
    const config = defaultConfig();
    config.embedding.provider = "openai";
    const profile = resolveEmbeddingProfile(config);

    await expect(embedText("hello world", profile)).rejects.toMatchObject({
      name: "EmbeddingProviderError",
      code: "CREDENTIAL_MISSING",
      provider: "openai",
      retryable: false,
    } satisfies Partial<EmbeddingProviderError>);
  });
});
