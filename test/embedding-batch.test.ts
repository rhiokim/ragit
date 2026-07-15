import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/core/config.js";
import {
  embedText,
  embedTexts,
  resolveEmbeddingExecutionPolicy,
  resolveEmbeddingProfile,
  splitEmbeddingBatches,
} from "../src/core/embedding.js";

const ORIGINAL_ENV = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
};

const ORIGINAL_FETCH = globalThis.fetch;

const createOpenAiProfile = () => {
  const config = defaultConfig();
  config.embedding.provider = "openai";
  return resolveEmbeddingProfile(config);
};

const createOllamaProfile = () => {
  const config = defaultConfig();
  config.embedding.provider = "ollama";
  return resolveEmbeddingProfile(config);
};

const parseInputs = (init?: RequestInit): string[] => {
  const body = typeof init?.body === "string" ? init.body : "";
  const parsed = JSON.parse(body) as { input: string[] | string };
  return Array.isArray(parsed.input) ? parsed.input : [parsed.input];
};

const vectorForText = (text: string, dimensions: number): number[] =>
  Array.from({ length: dimensions }, (_, index) => ((text.charCodeAt(index % text.length) ?? 0) + index) / 1024);

const successResponse = (inputs: string[], dimensions: number): Response =>
  new Response(
    JSON.stringify({
      data: inputs.map((text, index) => ({
        index,
        embedding: vectorForText(text, dimensions),
      })),
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );

const providerResponse = (body: unknown): Response =>
  ({
    ok: true,
    json: async () => body,
  }) as Response;

const providerBody = (provider: "openai" | "ollama", vectors: unknown[]): unknown =>
  provider === "openai"
    ? { data: vectors.map((embedding, index) => ({ index, embedding })) }
    : { embeddings: vectors };

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
});

describe("embedding batching and retry", () => {
  it("splits batches by the provider item and byte limits", () => {
    const profile = createOpenAiProfile();
    const policy = resolveEmbeddingExecutionPolicy(profile);

    expect(policy.batch.maxItems).toBe(96);
    expect(policy.batch.maxBytes).toBe(1024 * 1024);

    const countSplit = splitEmbeddingBatches(
      Array.from({ length: 97 }, (_, index) => `doc-${index}`),
      policy.batch,
    );
    expect(countSplit).toHaveLength(2);
    expect(countSplit[0]).toHaveLength(96);
    expect(countSplit[1]).toHaveLength(1);

    const byteSplit = splitEmbeddingBatches(
      ["a".repeat(800_000), "b".repeat(400_000)],
      policy.batch,
    );
    expect(byteSplit).toHaveLength(2);
    expect(byteSplit[0]).toHaveLength(1);
    expect(byteSplit[1]).toHaveLength(1);
  });

  it.each([429, 500])("retries transient HTTP %i provider failures with the shared facade", async (status) => {
    process.env.OPENAI_API_KEY = "test-key";
    const profile = createOpenAiProfile();
    let calls = 0;
    globalThis.fetch = vi.fn(async (_input, init) => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ error: "rate limited" }), {
          status,
          statusText: status === 429 ? "Too Many Requests" : "Internal Server Error",
          headers: { "retry-after": "0" },
        });
      }
      return successResponse(parseInputs(init), profile.dimensions);
    }) as typeof fetch;

    const vectors = await embedTexts(["alpha", "beta"], profile);

    expect(calls).toBe(2);
    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toHaveLength(profile.dimensions);
    expect(vectors[1]).toHaveLength(profile.dimensions);
  }, 10_000);

  it("does not shorten Retry-After with jitter", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const profile = createOpenAiProfile();
    let calls = 0;
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    globalThis.fetch = vi.fn(async (_input, init) => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ error: "rate limited" }), {
          status: 429,
          statusText: "Too Many Requests",
          headers: { "retry-after": "1" },
        });
      }
      return successResponse(parseInputs(init), profile.dimensions);
    }) as typeof fetch;

    const result = embedText("alpha", profile);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toHaveLength(profile.dimensions);
    expect(calls).toBe(2);
  });

  it("does not retry non-retryable provider failures", async () => {
    const apiKey = "openai-key-must-not-leak";
    process.env.OPENAI_API_KEY = apiKey;
    const profile = createOpenAiProfile();
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: "bad request" }), {
        status: 400,
        statusText: `Bad Request ${apiKey}`,
      });
    }) as typeof fetch;

    let error: unknown;
    try {
      await embedTexts(["alpha"], profile);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      code: "PROVIDER_UNREACHABLE",
      retryable: false,
    });
    expect(calls).toBe(1);
    expect((error as Error).message).not.toContain(apiKey);
  });

  it("restores OpenAI input order from response indexes", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const profile = createOpenAiProfile();
    globalThis.fetch = vi.fn(async (_input, init) => {
      const inputs = parseInputs(init);
      return providerResponse({
        data: inputs
          .map((text, index) => ({ index, embedding: vectorForText(text, profile.dimensions) }))
          .reverse(),
      });
    }) as typeof fetch;

    await expect(embedTexts(["alpha", "beta"], profile)).resolves.toEqual([
      vectorForText("alpha", profile.dimensions),
      vectorForText("beta", profile.dimensions),
    ]);
  });

  it.each([
    ["missing", (dimensions: number) => [{ index: 0, embedding: vectorForText("alpha", dimensions) }, { embedding: vectorForText("beta", dimensions) }]],
    ["duplicate", (dimensions: number) => [{ index: 0, embedding: vectorForText("alpha", dimensions) }, { index: 0, embedding: vectorForText("beta", dimensions) }]],
    ["fractional", (dimensions: number) => [{ index: 0, embedding: vectorForText("alpha", dimensions) }, { index: 0.5, embedding: vectorForText("beta", dimensions) }]],
    ["negative", (dimensions: number) => [{ index: 0, embedding: vectorForText("alpha", dimensions) }, { index: -1, embedding: vectorForText("beta", dimensions) }]],
    ["out-of-range", (dimensions: number) => [{ index: 0, embedding: vectorForText("alpha", dimensions) }, { index: 2, embedding: vectorForText("beta", dimensions) }]],
  ])("rejects OpenAI %s response indexes", async (_kind, entries) => {
    process.env.OPENAI_API_KEY = "test-key";
    const profile = createOpenAiProfile();
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      return providerResponse({ data: entries(profile.dimensions) });
    }) as typeof fetch;

    await expect(embedTexts(["alpha", "beta"], profile)).rejects.toMatchObject({
      code: "RESPONSE_INVALID",
      retryable: false,
    });
    expect(calls).toBe(1);
  });

  for (const provider of ["openai", "ollama"] as const) {
    it.each([1, 3])(`rejects ${provider} batches with %i vectors for two inputs`, async (count) => {
      if (provider === "openai") process.env.OPENAI_API_KEY = "test-key";
      const profile = provider === "openai" ? createOpenAiProfile() : createOllamaProfile();
      globalThis.fetch = vi.fn(async () =>
        providerResponse(
          providerBody(
            provider,
            Array.from({ length: count }, (_, index) => vectorForText(`vector-${index}`, profile.dimensions)),
          ),
        )) as typeof fetch;

      await expect(embedTexts(["alpha", "beta"], profile)).rejects.toMatchObject({
        code: "RESPONSE_INVALID",
        retryable: false,
      });
    });

    it.each(["string", null, true, Number.NaN, Number.POSITIVE_INFINITY])(
      `rejects ${provider} non-finite or non-number vector values`,
      async (invalidValue) => {
        if (provider === "openai") process.env.OPENAI_API_KEY = "test-key";
        const profile = provider === "openai" ? createOpenAiProfile() : createOllamaProfile();
        const vector = [invalidValue, ...vectorForText("alpha", profile.dimensions).slice(1)];
        globalThis.fetch = vi.fn(async () => providerResponse(providerBody(provider, [vector]))) as typeof fetch;

        await expect(embedTexts(["alpha"], profile)).rejects.toMatchObject({
          code: "RESPONSE_INVALID",
          retryable: false,
        });
      },
    );
  }

  it("preserves Ollama response order", async () => {
    const profile = createOllamaProfile();
    globalThis.fetch = vi.fn(async (_input, init) => {
      const inputs = parseInputs(init);
      return providerResponse({
        embeddings: inputs.map((text) => vectorForText(text, profile.dimensions)),
      });
    }) as typeof fetch;

    await expect(embedTexts(["alpha", "beta"], profile)).resolves.toEqual([
      vectorForText("alpha", profile.dimensions),
      vectorForText("beta", profile.dimensions),
    ]);
  });

  it("keeps wrong provider vector dimensions as DIMENSION_MISMATCH", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const profile = createOpenAiProfile();
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      return providerResponse({
        data: [{ index: 0, embedding: ["not-a-number", ...new Array(profile.dimensions - 2).fill(0)] }],
      });
    }) as typeof fetch;

    await expect(embedText("alpha", profile)).rejects.toMatchObject({
      code: "DIMENSION_MISMATCH",
      retryable: false,
    });
    expect(calls).toBe(1);
  });

  it("never replaces a missing provider result with a zero vector", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const profile = createOpenAiProfile();
    globalThis.fetch = vi.fn(async () => providerResponse({ data: [] })) as typeof fetch;

    await expect(embedText("alpha", profile)).rejects.toMatchObject({
      code: "RESPONSE_INVALID",
      retryable: false,
    });
  });

  it("deduplicates identical in-flight requests before issuing a provider call", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const profile = createOpenAiProfile();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    globalThis.fetch = vi.fn(async (_input, init) => {
      calls += 1;
      await gate;
      return successResponse(parseInputs(init), profile.dimensions);
    }) as typeof fetch;

    const first = embedText("same request", profile);
    const second = embedText("same request", profile);
    release();
    const [left, right] = await Promise.all([first, second]);

    expect(calls).toBe(1);
    expect(left).toEqual(right);
  });
});
