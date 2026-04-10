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
      data: inputs.map((text) => ({
        embedding: vectorForText(text, dimensions),
      })),
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );

afterEach(() => {
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

  it("retries transient provider failures with the shared facade", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const profile = createOpenAiProfile();
    let calls = 0;
    globalThis.fetch = vi.fn(async (_input, init) => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ error: "rate limited" }), {
          status: 429,
          statusText: "Too Many Requests",
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

  it("does not retry non-retryable provider failures", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const profile = createOpenAiProfile();
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: "bad request" }), {
        status: 400,
        statusText: "Bad Request",
      });
    }) as typeof fetch;

    await expect(embedTexts(["alpha"], profile)).rejects.toMatchObject({
      code: "PROVIDER_UNREACHABLE",
      retryable: false,
    });
    expect(calls).toBe(1);
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
