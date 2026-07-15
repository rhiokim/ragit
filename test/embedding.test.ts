import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/core/config.js";
import { embedText, EmbeddingProviderError, resolveEmbeddingConfiguredState, resolveEmbeddingProfile } from "../src/core/embedding.js";

const ORIGINAL_ENV = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL,
  UNRELATED_EMBEDDING_SENTINEL: process.env.UNRELATED_EMBEDDING_SENTINEL,
};

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (ORIGINAL_FETCH === undefined) {
    // @ts-expect-error node fetch may be undefined in some runtimes
    delete globalThis.fetch;
  } else {
    globalThis.fetch = ORIGINAL_FETCH;
  }
  if (ORIGINAL_ENV.OPENAI_API_KEY === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = ORIGINAL_ENV.OPENAI_API_KEY;
  if (ORIGINAL_ENV.OPENAI_BASE_URL === undefined) delete process.env.OPENAI_BASE_URL;
  else process.env.OPENAI_BASE_URL = ORIGINAL_ENV.OPENAI_BASE_URL;
  if (ORIGINAL_ENV.OLLAMA_BASE_URL === undefined) delete process.env.OLLAMA_BASE_URL;
  else process.env.OLLAMA_BASE_URL = ORIGINAL_ENV.OLLAMA_BASE_URL;
  if (ORIGINAL_ENV.UNRELATED_EMBEDDING_SENTINEL === undefined) delete process.env.UNRELATED_EMBEDDING_SENTINEL;
  else process.env.UNRELATED_EMBEDDING_SENTINEL = ORIGINAL_ENV.UNRELATED_EMBEDDING_SENTINEL;
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
    process.env.OPENAI_BASE_URL = "http://env.example///";
    const config = defaultConfig();
    config.embedding.provider = "openai";
    config.embedding.model = "text-embedding-3-large";
    config.embedding.base_url = " https://config.example/compatible/// ";
    config.embedding.dimensions = 999;
    config.embedding.version = "legacy";

    const configured = resolveEmbeddingConfiguredState(config);
    const profile = resolveEmbeddingProfile(config);

    expect(configured.baseUrl).toBe("https://config.example/compatible");
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

  it("normalizes environment provider roots", () => {
    process.env.OLLAMA_BASE_URL = " http://env.example/ollama/// ";
    const config = defaultConfig();
    config.embedding.provider = "ollama";

    expect(resolveEmbeddingConfiguredState(config).baseUrl).toBe("http://env.example/ollama");
    expect(resolveEmbeddingProfile(config).baseUrl).toBe("http://env.example/ollama");
  });

  it.each([
    "https://user:secret@example.invalid/root",
    "https://example.invalid/root?token=secret",
    "https://example.invalid/root#secret",
    "https://example.invalid/root?",
    "https://example.invalid/root#",
    "/relative/root",
    "https://",
    "ftp://example.invalid/root",
  ])("rejects invalid provider roots without echoing them", (baseUrl) => {
    const config = defaultConfig();
    config.embedding.provider = "openai";
    config.embedding.base_url = baseUrl;

    let error: unknown;
    try {
      resolveEmbeddingConfiguredState(config);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(EmbeddingProviderError);
    expect((error as Error).message).not.toContain(baseUrl);
    expect(() => resolveEmbeddingProfile(config)).toThrow("embedding provider base URL configuration is invalid.");
  });

  it("does not validate unused provider roots for local-placeholder", () => {
    process.env.OPENAI_BASE_URL = "https://user:secret@example.invalid/root";
    process.env.OLLAMA_BASE_URL = "ftp://example.invalid/root";
    const config = defaultConfig();
    config.embedding.base_url = "https://user:secret@example.invalid/root";

    expect(resolveEmbeddingConfiguredState(config).baseUrl).toBeNull();
    expect(resolveEmbeddingProfile(config).baseUrl).toBeNull();
  });

  it("raises a normalized credential error when openai key is missing", async () => {
    delete process.env.OPENAI_API_KEY;
    process.env.UNRELATED_EMBEDDING_SENTINEL = "unrelated-secret-sentinel";
    const config = defaultConfig();
    config.embedding.provider = "openai";
    const profile = resolveEmbeddingProfile(config);

    try {
      await embedText("hello world", profile);
      throw new Error("expected credential failure");
    } catch (error) {
      expect(error).toMatchObject({
        name: "EmbeddingProviderError",
        code: "CREDENTIAL_MISSING",
        provider: "openai",
        retryable: false,
      } satisfies Partial<EmbeddingProviderError>);
      expect((error as Error).message).not.toContain("unrelated-secret-sentinel");
    }
  });

  it("aborts a hanging provider fetch and preserves TIMEOUT", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const config = defaultConfig();
    config.embedding.provider = "openai";
    config.embedding.timeout_ms = 1;
    const profile = resolveEmbeddingProfile(config);
    let aborts = 0;
    globalThis.fetch = vi.fn((_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener(
          "abort",
          () => {
            aborts += 1;
            reject(new DOMException("aborted", "AbortError"));
          },
          { once: true },
        );
      })) as typeof fetch;
    vi.useFakeTimers();

    const result = expect(embedText("hello world", profile)).rejects.toMatchObject({
      code: "TIMEOUT",
      retryable: true,
    });
    await vi.runAllTimersAsync();

    await result;
    expect(aborts).toBeGreaterThan(0);
  });

  it("keeps ordinary fetch failures distinct from TIMEOUT", async () => {
    const apiKey = "openai-key-must-not-leak";
    process.env.OPENAI_API_KEY = apiKey;
    const config = defaultConfig();
    config.embedding.provider = "openai";
    const profile = resolveEmbeddingProfile(config);
    globalThis.fetch = vi.fn(async () => {
      throw new Error(`network failure ${apiKey}`);
    }) as typeof fetch;

    let error: unknown;
    try {
      await embedText("hello world", profile);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      code: "PROVIDER_UNREACHABLE",
      retryable: true,
    });
    expect((error as Error).message).not.toContain(apiKey);
  });
});
