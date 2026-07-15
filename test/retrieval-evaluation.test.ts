import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  buildRetrievalBenchmarkReport,
  evaluateRetrievalRanking,
  expandRetrievalBenchmarkCases,
  findRetrievalBenchmarkThresholdViolations,
  nearestRankPercentile,
  parseRetrievalBenchmarkDataset,
  parseRetrievalBenchmarkThresholds,
} from "../src/core/retrieval-evaluation.js";

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
    expect(report.profile.developmentOnly).toBe(true);
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
});
