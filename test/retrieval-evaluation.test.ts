import { execFileSync } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as benchmarkRunner from "../scripts/benchmark-retrieval.js";
import {
  assertRetrievalBenchmarkDatasetPaths,
  parseRetrievalBenchmarkArgs,
} from "../scripts/benchmark-retrieval.js";
import {
  buildRetrievalBenchmarkReport,
  evaluateRetrievalRanking,
  expandRetrievalBenchmarkCases,
  findRetrievalBenchmarkThresholdViolations,
  nearestRankPercentile,
  parseRetrievalBenchmarkDataset,
  parseRetrievalBenchmarkThresholds,
  type RetrievalBenchmarkDataset,
  type RetrievalBenchmarkProfile,
} from "../src/core/retrieval-evaluation.js";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_OPENAI_API_KEY = process.env.OPENAI_API_KEY;

afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL_FETCH === undefined) {
    // @ts-expect-error node fetch may be undefined in some runtimes
    delete globalThis.fetch;
  } else {
    globalThis.fetch = ORIGINAL_FETCH;
  }
  if (ORIGINAL_OPENAI_API_KEY === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = ORIGINAL_OPENAI_API_KEY;
});

const variants = {
  en: "How does this topic work?",
  ko: "이 주제는 어떻게 동작하나요?",
  "mixed-noisy": "topic 어떻게 works pls",
};

const repository = (id: string, topicCount = 12) => ({
  id,
  description: `${id} fixture repository`,
  documents: Array.from({ length: 12 }, (_, index) => ({
    path: `docs/topic-${index + 1}.md`,
    content: `# Topic ${index + 1}\n\nEnglish and 한국어 guidance for ${id}.`,
  })),
  topics: Array.from({ length: topicCount }, (_, index) => ({
    id: `topic-${index + 1}`,
    queries: { ...variants },
    judgments: [{ path: `docs/topic-${(index % 12) + 1}.md`, gain: 3 }],
  })),
});

const validDataset = () => ({
  schemaVersion: 1,
  datasetId: "retrieval-test-v1",
  repositories: [repository("zeta"), repository("alpha"), repository("beta")],
});

describe("retrieval evaluation dataset", () => {
  it("validates a dataset and expands cases in stable repository/topic/variant order", () => {
    const dataset = parseRetrievalBenchmarkDataset(validDataset());
    const cases = expandRetrievalBenchmarkCases(dataset);

    expect(cases).toHaveLength(108);
    expect(cases.slice(0, 4).map((benchmarkCase) => benchmarkCase.caseId)).toEqual([
      "alpha/topic-1/en",
      "alpha/topic-1/ko",
      "alpha/topic-1/mixed-noisy",
      "alpha/topic-10/en",
    ]);
  });

  it("keeps the committed bilingual corpus at 108 valid cases", async () => {
    const raw = await readFile(new URL("../benchmarks/retrieval/v1/dataset.json", import.meta.url), "utf8");
    const dataset = parseRetrievalBenchmarkDataset(JSON.parse(raw));
    const cases = expandRetrievalBenchmarkCases(dataset);
    const byVariant = Object.fromEntries(["en", "ko", "mixed-noisy"].map((variant) => [
      variant,
      cases.filter((benchmarkCase) => benchmarkCase.variant === variant).length,
    ]));

    expect(dataset.repositories).toHaveLength(3);
    expect(dataset.repositories.every((repositoryValue) => repositoryValue.documents.length === 12)).toBe(true);
    expect(dataset.repositories.every((repositoryValue) => repositoryValue.topics.length === 12)).toBe(true);
    expect(dataset.repositories.every((repositoryValue) =>
      repositoryValue.documents.every((document) => document.content.startsWith("---\ntype: spec\n---\n# ")),
    )).toBe(true);
    expect(cases).toHaveLength(108);
    expect(byVariant).toEqual({ en: 36, ko: 36, "mixed-noisy": 36 });
  });

  it.each([
    ["duplicate repository ids", (value: ReturnType<typeof validDataset>) => { value.repositories[2]!.id = "alpha"; }],
    ["duplicate document paths", (value: ReturnType<typeof validDataset>) => { value.repositories[0]!.documents[1]!.path = "docs/topic-1.md"; }],
    ["missing query variants", (value: ReturnType<typeof validDataset>) => { delete (value.repositories[0]!.topics[0]!.queries as Partial<typeof variants>).ko; }],
    ["invalid gains", (value: ReturnType<typeof validDataset>) => { value.repositories[0]!.topics[0]!.judgments[0]!.gain = 4; }],
    ["missing judged paths", (value: ReturnType<typeof validDataset>) => { value.repositories[0]!.topics[0]!.judgments[0]!.path = "docs/missing.md"; }],
  ])("rejects %s", (_label, mutate) => {
    const value = validDataset();
    mutate(value);
    expect(() => parseRetrievalBenchmarkDataset(value)).toThrow();
  });

  it("rejects insufficient repositories and fewer than 100 expanded cases", () => {
    const tooFewRepositories = validDataset();
    tooFewRepositories.repositories.pop();
    expect(() => parseRetrievalBenchmarkDataset(tooFewRepositories)).toThrow();

    const tooFewCases = validDataset();
    for (const repositoryValue of tooFewCases.repositories) repositoryValue.topics.pop();
    expect(() => parseRetrievalBenchmarkDataset(tooFewCases)).toThrow();
  });
});

describe("retrieval evaluation metrics", () => {
  it("deduplicates ranked paths and calculates graded metrics", () => {
    const judgments = [
      { path: "docs/a.md", gain: 3 as const },
      { path: "docs/b.md", gain: 1 as const },
    ];
    const metrics = evaluateRetrievalRanking(
      judgments,
      ["docs/noise.md", "docs/a.md", "docs/a.md", "docs/b.md"],
      3,
    );
    const expectedDcg = 7 / Math.log2(3) + 1 / Math.log2(4);
    const expectedIdeal = 7 + 1 / Math.log2(3);

    expect(metrics.recall).toBe(1);
    expect(metrics.mrr).toBe(0.5);
    expect(metrics.ndcg).toBeCloseTo(expectedDcg / expectedIdeal, 12);
  });

  it("handles zero and partial hits and uses nearest-rank latency percentiles", () => {
    const judgments = [
      { path: "docs/a.md", gain: 3 as const },
      { path: "docs/b.md", gain: 1 as const },
    ];
    expect(evaluateRetrievalRanking(judgments, ["docs/noise.md"], 10)).toEqual({ recall: 0, mrr: 0, ndcg: 0 });
    expect(evaluateRetrievalRanking(judgments, ["docs/b.md"], 10).recall).toBe(0.5);
    expect(nearestRankPercentile([1, 2, 3, 4, 100], 0.5)).toBe(3);
    expect(nearestRankPercentile([1, 2, 3, 4, 100], 0.95)).toBe(100);
    expect(() => nearestRankPercentile([], 0.5)).toThrow();
  });
});

describe("retrieval evaluation reports and thresholds", () => {
  it("builds stable slices, paired noise, and ordered threshold violations", () => {
    const dataset = parseRetrievalBenchmarkDataset(validDataset());
    const cases = expandRetrievalBenchmarkCases(dataset);
    const report = buildRetrievalBenchmarkReport({
      dataset,
      observations: cases.map((benchmarkCase, index) => ({
        case: benchmarkCase,
        rankedPaths: [benchmarkCase.judgments[0]!.path],
        latencyMs: index + 1,
      })),
      profile: {
        provider: "local-placeholder",
        model: "deterministic",
        dimensions: 8,
        version: "v1",
        developmentOnly: true,
      },
      generatedAt: "2026-07-15T00:00:00.000Z",
    });
    const thresholds = parseRetrievalBenchmarkThresholds({
      schemaVersion: 1,
      datasetId: dataset.datasetId,
      profile: "local-placeholder/deterministic/v1",
      minimum: { recallAt5: 1, mrrAt10: 1, ndcgAt10: 1 },
      maximum: { relativeNoiseDrop: 0, p95LatencyMs: 103 },
    });

    expect(report.counts).toEqual({ repositories: 3, topics: 36, cases: 108, byVariant: { en: 36, ko: 36, "mixed-noisy": 36 } });
    expect(report.profile).toEqual({
      provider: "local-placeholder",
      model: "deterministic",
      dimensions: 8,
      version: "v1",
      developmentOnly: true,
    });
    expect(Object.keys(report.profile)).toEqual(["provider", "model", "dimensions", "version", "developmentOnly"]);
    expect(Object.hasOwn(report.profile, "endpointClass")).toBe(false);
    expect(report.byRepository.map((slice) => slice.id)).toEqual(["alpha", "beta", "zeta"]);
    expect(report.noise).toEqual({ pairs: 36, cleanMeanNdcgAt10: 1, noisyMeanNdcgAt10: 1, absoluteDrop: 0, relativeDrop: 0 });
    expect(report.aggregate.latency).toEqual({ p50Ms: 54, p95Ms: 103, maxMs: 108 });
    expect(findRetrievalBenchmarkThresholdViolations(report, thresholds)).toEqual([]);

    const poorReport = buildRetrievalBenchmarkReport({
      dataset,
      observations: cases.map((benchmarkCase) => ({
        case: benchmarkCase,
        rankedPaths: benchmarkCase.variant === "mixed-noisy" ? [] : [benchmarkCase.judgments[0]!.path],
        latencyMs: 100,
      })),
      profile: report.profile,
      generatedAt: "2026-07-15T00:00:00.000Z",
    });
    const strictThresholds = parseRetrievalBenchmarkThresholds({
      schemaVersion: 1,
      datasetId: dataset.datasetId,
      profile: "local-placeholder/deterministic/v1",
      minimum: { recallAt5: 0.9, mrrAt10: 0.9, ndcgAt10: 0.9 },
      maximum: { relativeNoiseDrop: 0.1, p95LatencyMs: 50 },
    });
    expect(findRetrievalBenchmarkThresholdViolations(poorReport, strictThresholds)).toEqual([
      "minimum.recallAt5",
      "minimum.mrrAt10",
      "minimum.ndcgAt10",
      "maximum.relativeNoiseDrop",
      "maximum.p95LatencyMs",
    ]);
    expect(findRetrievalBenchmarkThresholdViolations(report, { ...thresholds, datasetId: "other", profile: "other" })).toEqual([
      "datasetId",
      "profile",
    ]);
  });

  it("rejects duplicate or incomplete observations and invalid threshold bounds", () => {
    const dataset = parseRetrievalBenchmarkDataset(validDataset());
    const cases = expandRetrievalBenchmarkCases(dataset);
    const input = {
      dataset,
      observations: cases.map((benchmarkCase) => ({ case: benchmarkCase, rankedPaths: [], latencyMs: 1 })),
      profile: { provider: "local-placeholder", model: "deterministic", dimensions: 8, version: "v1", developmentOnly: true },
      generatedAt: "2026-07-15T00:00:00.000Z",
    };
    expect(() => buildRetrievalBenchmarkReport({ ...input, observations: input.observations.slice(1) })).toThrow();
    expect(() => buildRetrievalBenchmarkReport({ ...input, observations: [...input.observations, input.observations[0]!] })).toThrow();
    expect(() => parseRetrievalBenchmarkThresholds({
      schemaVersion: 1,
      datasetId: dataset.datasetId,
      profile: "local-placeholder/deterministic/v1",
      minimum: { recallAt5: 1.1, mrrAt10: 0, ndcgAt10: 0 },
      maximum: { relativeNoiseDrop: 0, p95LatencyMs: 0 },
    })).toThrow();
  });

  it("projects only allowlisted explicit endpoint classes into reports", () => {
    const dataset = parseRetrievalBenchmarkDataset(validDataset());
    const observations = expandRetrievalBenchmarkCases(dataset).map((benchmarkCase) => ({
      case: benchmarkCase,
      rankedPaths: [benchmarkCase.judgments[0]!.path],
      latencyMs: 1,
    }));
    const report = buildRetrievalBenchmarkReport({
      dataset,
      observations,
      profile: {
        provider: "openai",
        model: "text-embedding-3-small",
        dimensions: 1536,
        version: "openai-text-embedding-3-small-1536",
        developmentOnly: false,
        endpointClass: "openai-public",
        baseUrl: "https://api.openai.com",
        apiKey: "must-not-serialize",
        extra: "must-not-serialize",
      } as RetrievalBenchmarkProfile & { baseUrl: string; apiKey: string; extra: string },
      generatedAt: "2026-07-15T00:00:00.000Z",
    });

    expect(report.profile).toEqual({
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1536,
      version: "openai-text-embedding-3-small-1536",
      developmentOnly: false,
      endpointClass: "openai-public",
    });
    expect(Object.hasOwn(report.profile, "baseUrl")).toBe(false);
    expect(Object.hasOwn(report.profile, "apiKey")).toBe(false);
    expect(() => buildRetrievalBenchmarkReport({
      dataset,
      observations,
      profile: {
        provider: "openai",
        model: "text-embedding-3-small",
        dimensions: 1536,
        version: "openai-text-embedding-3-small-1536",
        developmentOnly: false,
      },
      generatedAt: "2026-07-15T00:00:00.000Z",
    })).toThrow("benchmark profile is invalid");
    expect(() => buildRetrievalBenchmarkReport({
      dataset,
      observations,
      profile: {
        provider: "openai",
        model: "text-embedding-3-small",
        dimensions: 1536,
        version: "openai-text-embedding-3-small-1536",
        developmentOnly: false,
        endpointClass: "invalid",
      } as RetrievalBenchmarkProfile,
      generatedAt: "2026-07-15T00:00:00.000Z",
    })).toThrow("benchmark profile is invalid");
    expect(() => buildRetrievalBenchmarkReport({
      dataset,
      observations,
      profile: {
        provider: "local-placeholder",
        model: "deterministic",
        dimensions: 8,
        version: "v1",
        developmentOnly: true,
        endpointClass: "custom",
      },
      generatedAt: "2026-07-15T00:00:00.000Z",
    })).toThrow("benchmark profile is invalid");
  });
});

describe("retrieval benchmark runner arguments", () => {
  it("parses only supported arguments without importing runner side effects", () => {
    expect(parseRetrievalBenchmarkArgs([])).toEqual({
      datasetPath: path.resolve("benchmarks/retrieval/v1/dataset.json"),
      thresholdsPath: path.resolve("benchmarks/retrieval/v1/thresholds.json"),
      outputPath: null,
      verify: false,
    });
    expect(parseRetrievalBenchmarkArgs([
      "--verify",
      "--dataset", "custom-dataset.json",
      "--thresholds", "custom-thresholds.json",
      "--output", "reports/result.json",
    ])).toEqual({
      datasetPath: path.resolve("custom-dataset.json"),
      thresholdsPath: path.resolve("custom-thresholds.json"),
      outputPath: path.resolve("reports/result.json"),
      verify: true,
    });
  });

  it.each(["--dataset", "--thresholds", "--output", "--api-key", "--embedding-api-key", "--unknown"])("rejects invalid argument %s", (argument) => {
    expect(() => parseRetrievalBenchmarkArgs([argument])).toThrow();
  });

  it.each([
    "openai/text-embedding-3-small",
    "openai/text-embedding-3-large",
    "ollama/nomic-embed-text",
    "ollama/mxbai-embed-large",
  ])("accepts explicit embedding profile %s", (embeddingProfile) => {
    expect(parseRetrievalBenchmarkArgs(["--embedding-profile", embeddingProfile])).toMatchObject({ embeddingProfile });
  });

  it.each([
    "openai/text-embedding-3-small-v2",
    "openai/placeholder-v1",
    "ollama/nomic-embed-text:latest",
    "local-placeholder/placeholder-v1",
  ])("rejects unsupported embedding profile %s", (embeddingProfile) => {
    expect(() => parseRetrievalBenchmarkArgs(["--embedding-profile", embeddingProfile])).toThrow();
  });

  it("requires an explicit profile for embedding overrides and a positive safe integer timeout", () => {
    expect(() => parseRetrievalBenchmarkArgs(["--embedding-base-url", "https://example.invalid"])).toThrow();
    expect(() => parseRetrievalBenchmarkArgs(["--embedding-timeout-ms", "1000"])).toThrow();
    expect(() => parseRetrievalBenchmarkArgs([
      "--embedding-profile", "openai/text-embedding-3-small",
      "--embedding-timeout-ms", "1.5",
    ])).toThrow();
    expect(() => parseRetrievalBenchmarkArgs([
      "--embedding-profile", "openai/text-embedding-3-small",
      "--embedding-timeout-ms", "0",
    ])).toThrow();
    expect(() => parseRetrievalBenchmarkArgs([
      "--embedding-profile", "openai/text-embedding-3-small",
      "--embedding-timeout-ms", "-1",
    ])).toThrow();
    expect(() => parseRetrievalBenchmarkArgs([
      "--embedding-profile", "openai/text-embedding-3-small",
      "--embedding-timeout-ms", String(Number.MAX_SAFE_INTEGER + 1),
    ])).toThrow();
    expect(parseRetrievalBenchmarkArgs([
      "--embedding-profile", "openai/text-embedding-3-small",
      "--embedding-base-url", "https://gateway.example/compatible",
      "--embedding-timeout-ms", "1000",
    ])).toMatchObject({
      embeddingProfile: "openai/text-embedding-3-small",
      embeddingBaseUrl: "https://gateway.example/compatible",
      embeddingTimeoutMs: 1000,
    });
  });

  it("classifies explicit report endpoints without exposing their roots", () => {
    type EndpointClassifier = (input: { provider: "openai" | "ollama"; baseUrl: string | null }) => string;
    const classifier = (benchmarkRunner as unknown as { classifyRetrievalBenchmarkEndpoint?: EndpointClassifier })
      .classifyRetrievalBenchmarkEndpoint;

    expect(classifier).toBeTypeOf("function");
    if (!classifier) return;
    expect(classifier({ provider: "openai", baseUrl: "https://api.openai.com" })).toBe("openai-public");
    expect(classifier({ provider: "ollama", baseUrl: "http://localhost:11434" })).toBe("ollama-local");
    expect(classifier({ provider: "ollama", baseUrl: "http://127.0.0.1:11434" })).toBe("ollama-local");
    expect(classifier({ provider: "ollama", baseUrl: "http://[::1]:11434" })).toBe("ollama-local");
    expect(classifier({ provider: "openai", baseUrl: "https://gateway.example/compatible" })).toBe("custom");
  });

  it("commits the selected embedding config before fixture initialization with a mocked provider", async () => {
    type Materializer = (
      dataset: RetrievalBenchmarkDataset,
      repositoryId: string,
      args: ReturnType<typeof parseRetrievalBenchmarkArgs>,
    ) => Promise<{ cwd: string; profile: RetrievalBenchmarkProfile }>;
    const materialize = (benchmarkRunner as unknown as { materializeRetrievalBenchmarkRepository?: Materializer })
      .materializeRetrievalBenchmarkRepository;

    expect(materialize).toBeTypeOf("function");
    if (!materialize) return;
    const dataset = parseRetrievalBenchmarkDataset(JSON.parse(await readFile(new URL("../benchmarks/retrieval/v1/dataset.json", import.meta.url), "utf8")));
    process.env.OPENAI_API_KEY = "benchmark-test-key";
    globalThis.fetch = vi.fn(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] | string };
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      return new Response(JSON.stringify({
        data: inputs.map((_text, index) => ({ index, embedding: new Array(1536).fill(0) })),
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    let cwd: string | undefined;
    try {
      const materialized = await materialize(dataset, dataset.repositories[0]!.id, parseRetrievalBenchmarkArgs([
        "--embedding-profile", "openai/text-embedding-3-small",
        "--embedding-base-url", "https://gateway.example/compatible",
        "--embedding-timeout-ms", "1234",
      ]));
      cwd = materialized.cwd;
      const initCommit = execFileSync("git", ["rev-list", "--all", "--grep=^initialize ragit$", "-n", "1"], { cwd, encoding: "utf8" }).trim();
      const committedConfig = execFileSync("git", ["show", `${initCommit}:.ragit/config.toml`], { cwd, encoding: "utf8" });

      expect(committedConfig).toContain('provider = "openai"');
      expect(committedConfig).toContain('model = "text-embedding-3-small"');
      expect(committedConfig).toContain('base_url = "https://gateway.example/compatible"');
      expect(committedConfig).toContain("timeout_ms = 1234");
      expect(materialized.profile).toEqual({
        provider: "openai",
        model: "text-embedding-3-small",
        dimensions: 1536,
        version: "openai-text-embedding-3-small-1536",
        developmentOnly: false,
        endpointClass: "custom",
      });
    } finally {
      if (cwd) await rm(cwd, { recursive: true, force: true });
    }
  }, 30_000);

  it("parses both fixed provider threshold files and package scripts", async () => {
    const expected = [
      ["thresholds-openai-text-embedding-3-small.json", "openai/text-embedding-3-small/openai-text-embedding-3-small-1536", 2000],
      ["thresholds-ollama-nomic-embed-text.json", "ollama/nomic-embed-text/ollama-nomic-embed-text-768", 1000],
    ] as const;
    for (const [fileName, profile, p95LatencyMs] of expected) {
      const raw = await readFile(new URL(`../benchmarks/retrieval/v1/${fileName}`, import.meta.url), "utf8");
      expect(parseRetrievalBenchmarkThresholds(JSON.parse(raw))).toEqual({
        schemaVersion: 1,
        datasetId: "ragit-retrieval-v1",
        profile,
        minimum: { recallAt5: 0.654166, mrrAt10: 0.515446, ndcgAt10: 0.569941 },
        maximum: { relativeNoiseDrop: 0.05, p95LatencyMs },
      });
    }
    const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
    expect(packageJson.scripts["benchmark:retrieval:openai:verify"]).toBe(
      "tsx scripts/benchmark-retrieval.ts --verify --embedding-profile openai/text-embedding-3-small --thresholds benchmarks/retrieval/v1/thresholds-openai-text-embedding-3-small.json",
    );
    expect(packageJson.scripts["benchmark:retrieval:ollama:verify"]).toBe(
      "tsx scripts/benchmark-retrieval.ts --verify --embedding-profile ollama/nomic-embed-text --thresholds benchmarks/retrieval/v1/thresholds-ollama-nomic-embed-text.json",
    );
  });

  it("rejects paths that could escape a materialized fixture repository", () => {
    const value = validDataset();
    value.repositories[0]!.documents[0]!.path = "../escape.md";
    value.repositories[0]!.topics[0]!.judgments[0]!.path = "../escape.md";
    expect(() => assertRetrievalBenchmarkDatasetPaths(parseRetrievalBenchmarkDataset(value))).toThrow("repository-relative");
  });
});
