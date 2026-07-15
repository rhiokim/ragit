export type RetrievalBenchmarkVariant = "en" | "ko" | "mixed-noisy";

export interface RetrievalBenchmarkDocument {
  path: string;
  content: string;
}

export interface RetrievalBenchmarkJudgment {
  path: string;
  gain: 1 | 2 | 3;
}

export interface RetrievalBenchmarkTopic {
  id: string;
  queries: Record<RetrievalBenchmarkVariant, string>;
  judgments: RetrievalBenchmarkJudgment[];
}

export interface RetrievalBenchmarkRepository {
  id: string;
  description: string;
  documents: RetrievalBenchmarkDocument[];
  topics: RetrievalBenchmarkTopic[];
}

export interface RetrievalBenchmarkDataset {
  schemaVersion: 1;
  datasetId: string;
  repositories: RetrievalBenchmarkRepository[];
}

export interface ExpandedRetrievalBenchmarkCase {
  caseId: string;
  repositoryId: string;
  topicId: string;
  variant: RetrievalBenchmarkVariant;
  query: string;
  judgments: RetrievalBenchmarkJudgment[];
}

export interface RetrievalRankingMetrics {
  recall: number;
  mrr: number;
  ndcg: number;
}

export interface RetrievalCaseMetrics {
  recallAt1: number;
  recallAt5: number;
  recallAt10: number;
  mrrAt10: number;
  ndcgAt10: number;
}

export interface RetrievalBenchmarkObservation {
  case: ExpandedRetrievalBenchmarkCase;
  rankedPaths: string[];
  latencyMs: number;
}

export interface RetrievalBenchmarkProfile {
  provider: string;
  model: string;
  dimensions: number;
  version: string;
  developmentOnly: boolean;
}

export interface RetrievalBenchmarkReportInput {
  dataset: RetrievalBenchmarkDataset;
  observations: RetrievalBenchmarkObservation[];
  profile: RetrievalBenchmarkProfile;
  generatedAt: string;
}

export interface RetrievalMetricSummary extends RetrievalCaseMetrics {}

export interface RetrievalLatencySummary {
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

export interface RetrievalBenchmarkReportSlice {
  id: string;
  cases: number;
  metrics: RetrievalMetricSummary;
  latency: RetrievalLatencySummary;
}

export interface RetrievalBenchmarkCaseResult {
  caseId: string;
  repositoryId: string;
  topicId: string;
  variant: RetrievalBenchmarkVariant;
  query: string;
  rankedPaths: string[];
  latencyMs: number;
  metrics: RetrievalCaseMetrics;
}

export interface RetrievalNoiseSummary {
  pairs: number;
  cleanMeanNdcgAt10: number;
  noisyMeanNdcgAt10: number;
  absoluteDrop: number;
  relativeDrop: number;
}

export interface RetrievalBenchmarkReport {
  schemaVersion: 1;
  datasetId: string;
  generatedAt: string;
  profile: RetrievalBenchmarkProfile;
  counts: {
    repositories: number;
    topics: number;
    cases: number;
    byVariant: Record<RetrievalBenchmarkVariant, number>;
  };
  aggregate: {
    metrics: RetrievalMetricSummary;
    latency: RetrievalLatencySummary;
  };
  byRepository: RetrievalBenchmarkReportSlice[];
  byVariant: RetrievalBenchmarkReportSlice[];
  noise: RetrievalNoiseSummary;
  cases: RetrievalBenchmarkCaseResult[];
}

export interface RetrievalBenchmarkThresholds {
  schemaVersion: 1;
  datasetId: string;
  profile: string;
  minimum: {
    recallAt5: number;
    mrrAt10: number;
    ndcgAt10: number;
  };
  maximum: {
    relativeNoiseDrop: number;
    p95LatencyMs: number;
  };
}

const variantOrder: RetrievalBenchmarkVariant[] = ["en", "ko", "mixed-noisy"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonBlankString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const requiredRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
};

const requiredArray = (value: unknown, label: string): unknown[] => {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
};

const requiredString = (value: unknown, label: string): string => {
  if (!isNonBlankString(value)) throw new Error(`${label} must be a non-blank string`);
  return value;
};

const requiredGain = (value: unknown, label: string): 1 | 2 | 3 => {
  if (value !== 1 && value !== 2 && value !== 3) throw new Error(`${label} must be 1, 2, or 3`);
  return value;
};

const comparison = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

export const retrievalBenchmarkProfileId = (profile: Pick<RetrievalBenchmarkProfile, "provider" | "model" | "version">): string =>
  `${profile.provider}/${profile.model}/${profile.version}`;

export const parseRetrievalBenchmarkDataset = (value: unknown): RetrievalBenchmarkDataset => {
  const root = requiredRecord(value, "dataset");
  if (root.schemaVersion !== 1) throw new Error("dataset.schemaVersion must be 1");
  const datasetId = requiredString(root.datasetId, "dataset.datasetId");
  const rawRepositories = requiredArray(root.repositories, "dataset.repositories");
  if (rawRepositories.length < 3) throw new Error("dataset must include at least three repositories");

  const repositoryIds = new Set<string>();
  const repositories = rawRepositories.map((rawRepository, repositoryIndex) => {
    const repository = requiredRecord(rawRepository, `repositories[${repositoryIndex}]`);
    const id = requiredString(repository.id, `repositories[${repositoryIndex}].id`);
    if (repositoryIds.has(id)) throw new Error(`duplicate repository id: ${id}`);
    repositoryIds.add(id);
    const description = requiredString(repository.description, `repositories[${repositoryIndex}].description`);
    const rawDocuments = requiredArray(repository.documents, `repositories[${repositoryIndex}].documents`);
    const rawTopics = requiredArray(repository.topics, `repositories[${repositoryIndex}].topics`);
    if (rawDocuments.length < 12) throw new Error(`repository ${id} must include at least twelve documents`);
    if (rawTopics.length < 12) throw new Error(`repository ${id} must include at least twelve topics`);

    const documentPaths = new Set<string>();
    const documents = rawDocuments.map((rawDocument, documentIndex) => {
      const document = requiredRecord(rawDocument, `repository ${id} documents[${documentIndex}]`);
      const path = requiredString(document.path, `repository ${id} documents[${documentIndex}].path`);
      if (documentPaths.has(path)) throw new Error(`duplicate document path in ${id}: ${path}`);
      documentPaths.add(path);
      return { path, content: requiredString(document.content, `repository ${id} documents[${documentIndex}].content`) };
    });

    const topicIds = new Set<string>();
    const topics = rawTopics.map((rawTopic, topicIndex) => {
      const topic = requiredRecord(rawTopic, `repository ${id} topics[${topicIndex}]`);
      const topicId = requiredString(topic.id, `repository ${id} topics[${topicIndex}].id`);
      if (topicIds.has(topicId)) throw new Error(`duplicate topic id in ${id}: ${topicId}`);
      topicIds.add(topicId);
      const queriesRecord = requiredRecord(topic.queries, `repository ${id} topic ${topicId}.queries`);
      const queryKeys = Object.keys(queriesRecord).sort(comparison);
      if (queryKeys.length !== variantOrder.length || variantOrder.some((variant) => !queryKeys.includes(variant))) {
        throw new Error(`repository ${id} topic ${topicId} must include exactly en, ko, and mixed-noisy queries`);
      }
      const queries = Object.fromEntries(
        variantOrder.map((variant) => [variant, requiredString(queriesRecord[variant], `repository ${id} topic ${topicId}.queries.${variant}`)]),
      ) as Record<RetrievalBenchmarkVariant, string>;
      const rawJudgments = requiredArray(topic.judgments, `repository ${id} topic ${topicId}.judgments`);
      if (rawJudgments.length === 0) throw new Error(`repository ${id} topic ${topicId} must include a judgment`);
      const judgedPaths = new Set<string>();
      const judgments = rawJudgments.map((rawJudgment, judgmentIndex) => {
        const judgment = requiredRecord(rawJudgment, `repository ${id} topic ${topicId} judgments[${judgmentIndex}]`);
        const path = requiredString(judgment.path, `repository ${id} topic ${topicId} judgments[${judgmentIndex}].path`);
        if (!documentPaths.has(path)) throw new Error(`judged path does not exist in ${id}: ${path}`);
        if (judgedPaths.has(path)) throw new Error(`duplicate judgment path in ${id}/${topicId}: ${path}`);
        judgedPaths.add(path);
        return { path, gain: requiredGain(judgment.gain, `repository ${id} topic ${topicId} judgments[${judgmentIndex}].gain`) };
      });
      return { id: topicId, queries, judgments };
    });
    return { id, description, documents, topics };
  });

  const dataset: RetrievalBenchmarkDataset = { schemaVersion: 1, datasetId, repositories };
  if (expandRetrievalBenchmarkCases(dataset).length < 100) {
    throw new Error("dataset must expand to at least 100 cases");
  }
  return dataset;
};

export const expandRetrievalBenchmarkCases = (dataset: RetrievalBenchmarkDataset): ExpandedRetrievalBenchmarkCase[] =>
  dataset.repositories
    .flatMap((repository) => repository.topics.flatMap((topic) => variantOrder.map((variant) => ({
      caseId: `${repository.id}/${topic.id}/${variant}`,
      repositoryId: repository.id,
      topicId: topic.id,
      variant,
      query: topic.queries[variant],
      judgments: topic.judgments.map((judgment) => ({ ...judgment })),
    }))))
    .sort((left, right) =>
      comparison(left.repositoryId, right.repositoryId) ||
      comparison(left.topicId, right.topicId) ||
      variantOrder.indexOf(left.variant) - variantOrder.indexOf(right.variant));

const uniquePaths = (paths: string[]): string[] => {
  const seen = new Set<string>();
  return paths.filter((path) => {
    if (!isNonBlankString(path) || seen.has(path)) return false;
    seen.add(path);
    return true;
  });
};

export const evaluateRetrievalRanking = (
  judgments: RetrievalBenchmarkJudgment[],
  rankedPaths: string[],
  k: number,
): RetrievalRankingMetrics => {
  if (!Number.isInteger(k) || k < 1) throw new Error("k must be a positive integer");
  const gains = new Map<string, number>();
  for (const judgment of judgments) {
    if (gains.has(judgment.path)) throw new Error(`duplicate judgment path: ${judgment.path}`);
    gains.set(judgment.path, judgment.gain);
  }
  const ranked = uniquePaths(rankedPaths).slice(0, k);
  const relevant = Array.from(gains.keys());
  const retrievedRelevant = ranked.filter((path) => gains.has(path));
  const firstRelevantRank = ranked.findIndex((path) => gains.has(path));
  const dcg = ranked.reduce((total, path, index) => {
    const gain = gains.get(path) ?? 0;
    return total + ((2 ** gain) - 1) / Math.log2(index + 2);
  }, 0);
  const ideal = Array.from(gains.values())
    .sort((left, right) => right - left)
    .slice(0, k)
    .reduce((total, gain, index) => total + ((2 ** gain) - 1) / Math.log2(index + 2), 0);
  return {
    recall: relevant.length === 0 ? 0 : retrievedRelevant.length / relevant.length,
    mrr: firstRelevantRank === -1 ? 0 : 1 / (firstRelevantRank + 1),
    ndcg: ideal === 0 ? 0 : dcg / ideal,
  };
};

export const nearestRankPercentile = (values: number[], percentile: number): number => {
  if (values.length === 0) throw new Error("percentile requires at least one value");
  if (!Number.isFinite(percentile) || percentile <= 0 || percentile > 1) throw new Error("percentile must be within (0, 1]");
  if (values.some((value) => !Number.isFinite(value))) throw new Error("percentile values must be finite");
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * percentile) - 1]!;
};

const average = (values: number[]): number => {
  if (values.length === 0) throw new Error("average requires at least one value");
  return values.reduce((total, value) => total + value, 0) / values.length;
};

const caseMetrics = (judgments: RetrievalBenchmarkJudgment[], rankedPaths: string[]): RetrievalCaseMetrics => {
  const at1 = evaluateRetrievalRanking(judgments, rankedPaths, 1);
  const at5 = evaluateRetrievalRanking(judgments, rankedPaths, 5);
  const at10 = evaluateRetrievalRanking(judgments, rankedPaths, 10);
  return {
    recallAt1: at1.recall,
    recallAt5: at5.recall,
    recallAt10: at10.recall,
    mrrAt10: at10.mrr,
    ndcgAt10: at10.ndcg,
  };
};

const summarizeCases = (cases: RetrievalBenchmarkCaseResult[], id: string): RetrievalBenchmarkReportSlice => ({
  id,
  cases: cases.length,
  metrics: {
    recallAt1: average(cases.map((result) => result.metrics.recallAt1)),
    recallAt5: average(cases.map((result) => result.metrics.recallAt5)),
    recallAt10: average(cases.map((result) => result.metrics.recallAt10)),
    mrrAt10: average(cases.map((result) => result.metrics.mrrAt10)),
    ndcgAt10: average(cases.map((result) => result.metrics.ndcgAt10)),
  },
  latency: {
    p50Ms: nearestRankPercentile(cases.map((result) => result.latencyMs), 0.5),
    p95Ms: nearestRankPercentile(cases.map((result) => result.latencyMs), 0.95),
    maxMs: Math.max(...cases.map((result) => result.latencyMs)),
  },
});

const validateProfile = (profile: RetrievalBenchmarkProfile): RetrievalBenchmarkProfile => {
  if (!isNonBlankString(profile.provider) || !isNonBlankString(profile.model) || !isNonBlankString(profile.version) ||
    !Number.isInteger(profile.dimensions) || profile.dimensions <= 0 || typeof profile.developmentOnly !== "boolean") {
    throw new Error("benchmark profile is invalid");
  }
  return { ...profile };
};

const validateGeneratedAt = (generatedAt: string): void => {
  if (!isNonBlankString(generatedAt) || new Date(generatedAt).toISOString() !== generatedAt) {
    throw new Error("generatedAt must be a canonical ISO-8601 UTC timestamp");
  }
};

export const buildRetrievalBenchmarkReport = (input: RetrievalBenchmarkReportInput): RetrievalBenchmarkReport => {
  validateGeneratedAt(input.generatedAt);
  const profile = validateProfile(input.profile);
  const cases = expandRetrievalBenchmarkCases(input.dataset);
  const expectedByCaseId = new Map(cases.map((benchmarkCase) => [benchmarkCase.caseId, benchmarkCase]));
  const observations = new Map<string, RetrievalBenchmarkObservation>();
  for (const observation of input.observations) {
    const expected = expectedByCaseId.get(observation.case.caseId);
    if (!expected || expected.repositoryId !== observation.case.repositoryId || expected.topicId !== observation.case.topicId || expected.variant !== observation.case.variant) {
      throw new Error(`unknown benchmark observation: ${observation.case.caseId}`);
    }
    if (observations.has(expected.caseId)) throw new Error(`duplicate benchmark observation: ${expected.caseId}`);
    if (!Number.isFinite(observation.latencyMs) || observation.latencyMs < 0) throw new Error(`invalid latency for ${expected.caseId}`);
    if (observation.rankedPaths.some((path) => !isNonBlankString(path))) throw new Error(`invalid ranked path for ${expected.caseId}`);
    observations.set(expected.caseId, observation);
  }
  if (observations.size !== cases.length) throw new Error("observations must include every expanded benchmark case exactly once");

  const results = cases.map((benchmarkCase) => {
    const observation = observations.get(benchmarkCase.caseId)!;
    return {
      caseId: benchmarkCase.caseId,
      repositoryId: benchmarkCase.repositoryId,
      topicId: benchmarkCase.topicId,
      variant: benchmarkCase.variant,
      query: benchmarkCase.query,
      rankedPaths: uniquePaths(observation.rankedPaths),
      latencyMs: observation.latencyMs,
      metrics: caseMetrics(benchmarkCase.judgments, observation.rankedPaths),
    };
  });
  const aggregate = summarizeCases(results, "aggregate");
  const byRepository = Array.from(new Set(results.map((result) => result.repositoryId)))
    .sort(comparison)
    .map((id) => summarizeCases(results.filter((result) => result.repositoryId === id), id));
  const byVariant = variantOrder.map((variant) => summarizeCases(results.filter((result) => result.variant === variant), variant));
  const noisyPairs = Array.from(new Set(results.map((result) => `${result.repositoryId}/${result.topicId}`)))
    .sort(comparison)
    .map((pair) => {
      const [repositoryId, topicId] = pair.split("/");
      const paired = results.filter((result) => result.repositoryId === repositoryId && result.topicId === topicId);
      const en = paired.find((result) => result.variant === "en");
      const ko = paired.find((result) => result.variant === "ko");
      const noisy = paired.find((result) => result.variant === "mixed-noisy");
      if (!en || !ko || !noisy) throw new Error(`incomplete noise pair: ${pair}`);
      return { clean: (en.metrics.ndcgAt10 + ko.metrics.ndcgAt10) / 2, noisy: noisy.metrics.ndcgAt10 };
    });
  const cleanMeanNdcgAt10 = average(noisyPairs.map((pair) => pair.clean));
  const noisyMeanNdcgAt10 = average(noisyPairs.map((pair) => pair.noisy));
  const absoluteDrop = Math.max(0, cleanMeanNdcgAt10 - noisyMeanNdcgAt10);
  const relativeDrop = cleanMeanNdcgAt10 === 0 ? 0 : absoluteDrop / cleanMeanNdcgAt10;

  return {
    schemaVersion: 1,
    datasetId: input.dataset.datasetId,
    generatedAt: input.generatedAt,
    profile,
    counts: {
      repositories: input.dataset.repositories.length,
      topics: input.dataset.repositories.reduce((total, repository) => total + repository.topics.length, 0),
      cases: results.length,
      byVariant: Object.fromEntries(variantOrder.map((variant) => [variant, results.filter((result) => result.variant === variant).length])) as Record<RetrievalBenchmarkVariant, number>,
    },
    aggregate: { metrics: aggregate.metrics, latency: aggregate.latency },
    byRepository,
    byVariant,
    noise: {
      pairs: noisyPairs.length,
      cleanMeanNdcgAt10,
      noisyMeanNdcgAt10,
      absoluteDrop,
      relativeDrop,
    },
    cases: results,
  };
};

const finiteUnitInterval = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be a finite number within [0, 1]`);
  }
  return value;
};

export const parseRetrievalBenchmarkThresholds = (value: unknown): RetrievalBenchmarkThresholds => {
  const root = requiredRecord(value, "thresholds");
  if (root.schemaVersion !== 1) throw new Error("thresholds.schemaVersion must be 1");
  const minimum = requiredRecord(root.minimum, "thresholds.minimum");
  const maximum = requiredRecord(root.maximum, "thresholds.maximum");
  const p95LatencyMs = maximum.p95LatencyMs;
  if (typeof p95LatencyMs !== "number" || !Number.isFinite(p95LatencyMs) || p95LatencyMs <= 0) {
    throw new Error("thresholds.maximum.p95LatencyMs must be a positive finite number");
  }
  return {
    schemaVersion: 1,
    datasetId: requiredString(root.datasetId, "thresholds.datasetId"),
    profile: requiredString(root.profile, "thresholds.profile"),
    minimum: {
      recallAt5: finiteUnitInterval(minimum.recallAt5, "thresholds.minimum.recallAt5"),
      mrrAt10: finiteUnitInterval(minimum.mrrAt10, "thresholds.minimum.mrrAt10"),
      ndcgAt10: finiteUnitInterval(minimum.ndcgAt10, "thresholds.minimum.ndcgAt10"),
    },
    maximum: {
      relativeNoiseDrop: finiteUnitInterval(maximum.relativeNoiseDrop, "thresholds.maximum.relativeNoiseDrop"),
      p95LatencyMs,
    },
  };
};

export const findRetrievalBenchmarkThresholdViolations = (
  report: RetrievalBenchmarkReport,
  thresholds: RetrievalBenchmarkThresholds,
): string[] => {
  const violations: string[] = [];
  if (report.datasetId !== thresholds.datasetId) violations.push("datasetId");
  if (retrievalBenchmarkProfileId(report.profile) !== thresholds.profile) violations.push("profile");
  if (report.aggregate.metrics.recallAt5 < thresholds.minimum.recallAt5) violations.push("minimum.recallAt5");
  if (report.aggregate.metrics.mrrAt10 < thresholds.minimum.mrrAt10) violations.push("minimum.mrrAt10");
  if (report.aggregate.metrics.ndcgAt10 < thresholds.minimum.ndcgAt10) violations.push("minimum.ndcgAt10");
  if (report.noise.relativeDrop > thresholds.maximum.relativeNoiseDrop) violations.push("maximum.relativeNoiseDrop");
  if (report.aggregate.latency.p95Ms > thresholds.maximum.p95LatencyMs) violations.push("maximum.p95LatencyMs");
  return violations;
};
