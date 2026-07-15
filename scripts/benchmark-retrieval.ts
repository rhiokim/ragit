import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { runInit } from "../src/commands/init.js";
import { loadConfig } from "../src/core/config.js";
import { resolveEmbeddingProfile } from "../src/core/embedding.js";
import { getHeadSha } from "../src/core/git.js";
import { runIngest } from "../src/core/ingest.js";
import { loadSnapshotManifest } from "../src/core/manifest.js";
import { searchKnowledge } from "../src/core/retrieval.js";
import {
  buildRetrievalBenchmarkReport,
  expandRetrievalBenchmarkCases,
  findRetrievalBenchmarkThresholdViolations,
  parseRetrievalBenchmarkDataset,
  parseRetrievalBenchmarkThresholds,
  retrievalBenchmarkProfileId,
  type RetrievalBenchmarkDataset,
  type RetrievalBenchmarkObservation,
  type RetrievalBenchmarkProfile,
  type RetrievalBenchmarkReport,
} from "../src/core/retrieval-evaluation.js";

const DEFAULT_DATASET_PATH = path.resolve("benchmarks/retrieval/v1/dataset.json");
const DEFAULT_THRESHOLDS_PATH = path.resolve("benchmarks/retrieval/v1/thresholds.json");

export interface RetrievalBenchmarkArgs {
  datasetPath: string;
  thresholdsPath: string;
  outputPath: string | null;
  verify: boolean;
}

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const codePointCompare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

const normalizeRepositoryPath = (value: string): string => value.replaceAll("\\", "/").replace(/^\.\//, "");

const assertSafeFixturePath = (value: string): void => {
  const normalized = normalizeRepositoryPath(value);
  if (value !== normalized || path.posix.isAbsolute(value) || path.win32.isAbsolute(value) ||
    normalized.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`benchmark fixture path must be repository-relative: ${value}`);
  }
};

const reportProgress = (message: string): void => {
  process.stderr.write(`[ragit benchmark] ${message}\n`);
};

const loadDataset = async (datasetPath: string): Promise<RetrievalBenchmarkDataset> =>
  parseRetrievalBenchmarkDataset(JSON.parse(await readFile(datasetPath, "utf8")));

export const assertRetrievalBenchmarkDatasetPaths = (dataset: RetrievalBenchmarkDataset): void => {
  for (const repository of dataset.repositories) {
    for (const document of repository.documents) assertSafeFixturePath(document.path);
    for (const topic of repository.topics) {
      for (const judgment of topic.judgments) assertSafeFixturePath(judgment.path);
    }
  }
};

const materializeRepository = async (
  dataset: RetrievalBenchmarkDataset,
  repositoryId: string,
): Promise<{ cwd: string; headSha: string; profile: RetrievalBenchmarkProfile }> => {
  const repository = dataset.repositories.find((candidate) => candidate.id === repositoryId);
  if (!repository) throw new Error(`unknown benchmark repository: ${repositoryId}`);
  const cwd = await mkdtemp(path.join(os.tmpdir(), "ragit-retrieval-"));
  try {
    git(cwd, ["init", "-b", "main"]);
    git(cwd, ["config", "user.email", "ragit@example.com"]);
    git(cwd, ["config", "user.name", "ragit-retrieval-benchmark"]);
    for (const document of repository.documents) {
      assertSafeFixturePath(document.path);
      const target = path.join(cwd, document.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, document.content, "utf8");
    }
    const documentPaths = repository.documents.map((document) => normalizeRepositoryPath(document.path)).sort(codePointCompare);
    git(cwd, ["add", "--", ...documentPaths]);
    git(cwd, ["commit", "-m", "seed retrieval benchmark"]);
    await runInit(cwd, { nonInteractive: true, quiet: true });
    git(cwd, ["add", "-A"]);
    git(cwd, ["commit", "-m", "initialize ragit"]);
    await runIngest(cwd, { all: true, scope: "durable" });

    const headSha = await getHeadSha(cwd);
    const manifest = await loadSnapshotManifest(cwd, headSha);
    const manifestPaths = new Set(manifest.docs.map((document) => normalizeRepositoryPath(document.path)));
    const missingPaths = documentPaths.filter((documentPath) => !manifestPaths.has(documentPath));
    if (missingPaths.length > 0) {
      throw new Error(`benchmark fixture documents were skipped for ${repository.id}: ${missingPaths.join(", ")}`);
    }
    const resolvedProfile = resolveEmbeddingProfile(await loadConfig(cwd));
    return {
      cwd,
      headSha,
      profile: {
        provider: resolvedProfile.provider,
        model: resolvedProfile.model,
        dimensions: resolvedProfile.dimensions,
        version: resolvedProfile.version,
        developmentOnly: resolvedProfile.provider === "local-placeholder",
      },
    };
  } catch (error) {
    await rm(cwd, { recursive: true, force: true });
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`benchmark repository setup failed for ${repository.id}: ${message}`, { cause: error });
  }
};

const runRepositoryCases = async (
  dataset: RetrievalBenchmarkDataset,
  repositoryId: string,
): Promise<{ observations: RetrievalBenchmarkObservation[]; profile: RetrievalBenchmarkProfile }> => {
  const materialized = await materializeRepository(dataset, repositoryId);
  try {
    const cases = expandRetrievalBenchmarkCases(dataset).filter((benchmarkCase) => benchmarkCase.repositoryId === repositoryId);
    const observations: RetrievalBenchmarkObservation[] = [];
    for (const benchmarkCase of cases) {
      try {
        const startedAt = performance.now();
        const result = await searchKnowledge(materialized.cwd, benchmarkCase.query, { topK: 10, scope: "durable" });
        const latencyMs = performance.now() - startedAt;
        if (result.snapshotSha !== materialized.headSha) {
          throw new Error(`benchmark query selected a non-exact snapshot: ${result.snapshotSha}`);
        }
        observations.push({
          case: benchmarkCase,
          rankedPaths: result.hits.map((hit) => normalizeRepositoryPath(hit.path)),
          latencyMs,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`benchmark query failed for ${benchmarkCase.caseId}: ${message}`, { cause: error });
      }
    }
    return { observations, profile: materialized.profile };
  } finally {
    await rm(materialized.cwd, { recursive: true, force: true });
  }
};

export const parseRetrievalBenchmarkArgs = (argv: string[]): RetrievalBenchmarkArgs => {
  const args: RetrievalBenchmarkArgs = {
    datasetPath: DEFAULT_DATASET_PATH,
    thresholdsPath: DEFAULT_THRESHOLDS_PATH,
    outputPath: null,
    verify: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--verify") {
      args.verify = true;
      continue;
    }
    if (argument !== "--dataset" && argument !== "--thresholds" && argument !== "--output") {
      throw new Error(`unsupported benchmark argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a path`);
    const resolved = path.resolve(value);
    if (argument === "--dataset") args.datasetPath = resolved;
    if (argument === "--thresholds") args.thresholdsPath = resolved;
    if (argument === "--output") args.outputPath = resolved;
    index += 1;
  }
  return args;
};

export const runRetrievalBenchmark = async (args: RetrievalBenchmarkArgs): Promise<{
  report: RetrievalBenchmarkReport;
  violations: string[];
}> => {
  const dataset = await loadDataset(args.datasetPath);
  const thresholds = args.verify
    ? parseRetrievalBenchmarkThresholds(JSON.parse(await readFile(args.thresholdsPath, "utf8")))
    : null;
  assertRetrievalBenchmarkDatasetPaths(dataset);
  const observations: RetrievalBenchmarkObservation[] = [];
  let profile: RetrievalBenchmarkProfile | null = null;
  for (const repository of [...dataset.repositories].sort((left, right) => codePointCompare(left.id, right.id))) {
    reportProgress(`materializing ${repository.id}`);
    const result = await runRepositoryCases(dataset, repository.id);
    if (profile !== null && retrievalBenchmarkProfileId(profile) !== retrievalBenchmarkProfileId(result.profile)) {
      throw new Error(`benchmark embedding profile differs for ${repository.id}`);
    }
    if (profile !== null && profile.dimensions !== result.profile.dimensions) {
      throw new Error(`benchmark embedding dimensions differ for ${repository.id}`);
    }
    profile = result.profile;
    observations.push(...result.observations);
  }
  if (profile === null) throw new Error("benchmark dataset did not materialize a repository");
  const report = buildRetrievalBenchmarkReport({
    dataset,
    observations,
    profile,
    generatedAt: new Date().toISOString(),
  });
  if (thresholds === null) return { report, violations: [] };
  return { report, violations: findRetrievalBenchmarkThresholdViolations(report, thresholds) };
};

export const main = async (argv: string[]): Promise<void> => {
  const args = parseRetrievalBenchmarkArgs(argv);
  const { report, violations } = await runRetrievalBenchmark(args);
  const serialized = `${JSON.stringify(report)}\n`;
  if (args.outputPath !== null) {
    await mkdir(path.dirname(args.outputPath), { recursive: true });
    await writeFile(args.outputPath, serialized, "utf8");
  }
  process.stdout.write(serialized);
  if (violations.length > 0) {
    for (const violation of violations) reportProgress(`threshold violation: ${violation}`);
    process.exitCode = 1;
  }
};

const isEntrypoint = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  await main(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[ragit benchmark] ${message}\n`);
    process.exitCode = 1;
  });
}
