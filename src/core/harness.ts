import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertAllowedKeys } from "./cliInput.js";
import { appendLedgerEvent } from "./event-ledger.js";
import {
  AdmissionSummary,
  ArtifactRecord,
  HarnessCaseCheckResult,
  HarnessCaseResult,
  HarnessCheckResult,
  HarnessCommandExecutor,
  HarnessArtifactKind,
  HarnessExpectedRules,
  HarnessRecordedExecutor,
  HarnessRunInput,
  HarnessRunRecord,
  HarnessRunResult,
  RedactionSummary,
  SearchPolicy,
} from "./types.js";
import { ensureRagitStructure, resolveRagitPaths } from "./project.js";
import { getHeadSha } from "./git.js";
import { loadArtifactRecord, persistArtifactRecord } from "./artifacts.js";
import { RAGIT_VERSION } from "./version.js";
import { createDoc, reconcileDocs } from "./doc-authority.js";
import { loadConfig } from "./config.js";
import { toRepoPath } from "./identity.js";
import { maskSecrets } from "./mask.js";
import {
  assertKnowledgeWriteSecurity,
  appendAdmissionRecord,
  applyAdmissionText,
  attachRedactionSummary,
  createAdmissionSummary,
  evaluateAdmissionStructuredValue,
  mergeAdmissionSummaries,
  persistQuarantineSummary,
  sanitizeStructuredValue,
} from "./security.js";

export interface HarnessCaptureResourceInput {
  kind: HarnessArtifactKind;
  title: string;
  summary?: string;
  input?: Record<string, unknown>;
  expected?: Record<string, unknown>;
  oracleRefs?: string[];
  evidenceRefs?: string[];
  resourceRefs?: string[];
}

export interface HarnessCaptureInput {
  goal: string;
  episodeId?: string;
  sourceSessionId?: string | null;
  artifactRefs?: string[];
  resources: HarnessCaptureResourceInput[];
}

export interface HarnessCaptureResult {
  artifactIds: string[];
  suiteId: string;
  dryRun: boolean;
  admission: AdmissionSummary;
  warnings: string[];
}

export interface HarnessPromoteInput {
  artifactRefs: string[];
}

export interface HarnessPromoteResult {
  createdFiles: string[];
  plannedFiles: string[];
  ingested: boolean;
  dryRun: boolean;
  admission: AdmissionSummary;
  warnings: string[];
}

export interface HarnessPackResult {
  suiteId: string;
  goal: string | null;
  resources: Array<Pick<ArtifactRecord, "artifactId" | "kind" | "title" | "summary" | "status">>;
  redactionSummary?: RedactionSummary;
}

export interface HarnessVerifyResult {
  suiteId: string;
  checks: HarnessCheckResult[];
  hasFailure: boolean;
}

const sha1 = (...parts: string[]): string => createHash("sha1").update(parts.join(":")).digest("hex");
const normalizeWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim();
const compactText = (text: string, max = 220): string => {
  const normalized = normalizeWhitespace(text);
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max)}...`;
};
const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const MAX_OUTPUT_CAPTURE = 16_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const createGoalId = (goal: string): string => `goal_${sha1(goal).slice(0, 12)}`;
const createArtifactId = (kind: HarnessArtifactKind, goal: string, title: string): string =>
  `art_harness_${kind}_${sha1(kind, goal, title).slice(0, 16)}`;
const createRunId = (suiteId: string, startedAt: string, caseIds: string[]): string =>
  `run_${startedAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}_${sha1(suiteId, startedAt, ...caseIds).slice(0, 8)}`;
const asString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} 값은 비어 있지 않은 문자열이어야 합니다.`);
  return value.trim();
};
const asOptionalString = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
};
const asStringArray = (value: unknown, label: string): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} 값은 string[] 이어야 합니다.`);
  return value.map((entry, index) => asString(entry, `${label}[${index}]`));
};
const asOptionalPositiveInteger = (value: unknown, label: string): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} 값은 양의 정수여야 합니다.`);
  }
  return value;
};

export const normalizeHarnessCaptureInput = (value: unknown): HarnessCaptureInput => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("harness capture 입력은 JSON 객체여야 합니다.");
  }
  const raw = value as Record<string, unknown>;
  assertAllowedKeys(raw, ["goal", "episodeId", "sourceSessionId", "artifactRefs", "resources"], "harness capture");
  if (!Array.isArray(raw.resources)) {
    throw new Error("harness capture.resources 값은 배열이어야 합니다.");
  }
  return {
    goal: asString(raw.goal, "harness capture.goal"),
    episodeId: asOptionalString(raw.episodeId),
    sourceSessionId: raw.sourceSessionId === null ? null : asOptionalString(raw.sourceSessionId),
    artifactRefs: raw.artifactRefs === undefined ? [] : asStringArray(raw.artifactRefs, "harness capture.artifactRefs"),
    resources: raw.resources.map((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`harness capture.resources[${index}] 값은 객체여야 합니다.`);
      }
      const record = entry as Record<string, unknown>;
      assertAllowedKeys(record, ["kind", "title", "summary", "input", "expected", "oracleRefs", "evidenceRefs", "resourceRefs"], `harness capture.resources[${index}]`);
      const kind = asString(record.kind, `harness capture.resources[${index}].kind`) as HarnessArtifactKind;
      if (!["case", "oracle", "failure", "fixture", "golden", "checker", "rubric", "promptTemplate", "trace", "envAssumption", "suite"].includes(kind)) {
        throw new Error(`지원하지 않는 harness resource kind 입니다: ${kind}`);
      }
      return {
        kind,
        title: asString(record.title, `harness capture.resources[${index}].title`),
        summary: asOptionalString(record.summary),
        input: record.input && typeof record.input === "object" && !Array.isArray(record.input) ? (record.input as Record<string, unknown>) : undefined,
        expected: record.expected && typeof record.expected === "object" && !Array.isArray(record.expected) ? (record.expected as Record<string, unknown>) : undefined,
        oracleRefs: asStringArray(record.oracleRefs, `harness capture.resources[${index}].oracleRefs`),
        evidenceRefs: asStringArray(record.evidenceRefs, `harness capture.resources[${index}].evidenceRefs`),
        resourceRefs: asStringArray(record.resourceRefs, `harness capture.resources[${index}].resourceRefs`),
      };
    }),
  };
};

export const normalizeHarnessPromoteInput = (value: unknown): HarnessPromoteInput => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("harness promote 입력은 JSON 객체여야 합니다.");
  }
  const raw = value as Record<string, unknown>;
  assertAllowedKeys(raw, ["artifactRefs"], "harness promote");
  return {
    artifactRefs: asStringArray(raw.artifactRefs, "harness promote.artifactRefs"),
  };
};

export const normalizeHarnessRunInput = (value: unknown): HarnessRunInput => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("harness run 입력은 JSON 객체여야 합니다.");
  }
  const raw = value as Record<string, unknown>;
  assertAllowedKeys(raw, ["suiteRef", "executor", "cases", "concurrency"], "harness run");
  if (!isObjectRecord(raw.executor)) {
    throw new Error("harness run.executor 값은 객체여야 합니다.");
  }
  const executor = raw.executor;
  assertAllowedKeys(executor, ["kind", "argv", "cwd", "env", "timeoutMs"], "harness run.executor");
  const kind = asString(executor.kind, "harness run.executor.kind");
  if (kind !== "command") {
    throw new Error(`지원하지 않는 harness executor.kind 입니다: ${kind}`);
  }
  if (!Array.isArray(executor.argv) || executor.argv.length === 0) {
    throw new Error("harness run.executor.argv 값은 비어 있지 않은 string[] 이어야 합니다.");
  }
  const env = executor.env;
  if (env !== undefined && !isObjectRecord(env)) {
    throw new Error("harness run.executor.env 값은 문자열 맵이어야 합니다.");
  }
  const normalizedEnv: Record<string, string> = {};
  if (env) {
    for (const [key, entry] of Object.entries(env)) {
      if (typeof entry !== "string") {
        throw new Error(`harness run.executor.env.${key} 값은 문자열이어야 합니다.`);
      }
      normalizedEnv[key] = entry;
    }
  }
  const concurrency = asOptionalPositiveInteger(raw.concurrency, "harness run.concurrency");
  if (concurrency !== undefined && concurrency !== 1) {
    throw new Error("harness run v1은 concurrency=1만 지원합니다.");
  }
  const timeoutMs = asOptionalPositiveInteger(executor.timeoutMs, "harness run.executor.timeoutMs");
  return {
    suiteRef: asString(raw.suiteRef, "harness run.suiteRef"),
    executor: {
      kind: "command",
      argv: executor.argv.map((entry, index) => asString(entry, `harness run.executor.argv[${index}]`)),
      cwd: asOptionalString(executor.cwd),
      env: normalizedEnv,
      timeoutMs,
    },
    cases: raw.cases === undefined ? [] : asStringArray(raw.cases, "harness run.cases"),
    concurrency,
  };
};

const safeHeadSha = async (cwd: string): Promise<string | null> => {
  try {
    return await getHeadSha(cwd);
  } catch {
    return null;
  }
};

const harnessRunPath = (cwd: string, runId: string): string => path.join(resolveRagitPaths(cwd).harnessRunsDir, `${runId}.json`);

const createHarnessFailureArtifactId = (runId: string, caseId: string): string =>
  `art_harness_failure_${sha1(runId, caseId).slice(0, 16)}`;

const resolveExecutorCwd = (cwd: string, rawCwd?: string): string => {
  const relative = rawCwd?.trim() || ".";
  if (path.isAbsolute(relative)) {
    throw new Error("harness run.executor.cwd 값은 저장소 기준 상대 경로여야 합니다.");
  }
  const resolved = path.resolve(cwd, relative);
  const relativeToRoot = path.relative(cwd, resolved);
  if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
    throw new Error("harness run.executor.cwd 값은 저장소 밖으로 벗어날 수 없습니다.");
  }
  return relativeToRoot.length > 0 ? relativeToRoot.replaceAll(path.sep, "/") : ".";
};

const resolveHarnessExecutor = (cwd: string, input: HarnessRunInput["executor"]): HarnessCommandExecutor => ({
  kind: "command",
  argv: [...input.argv],
  cwd: resolveExecutorCwd(cwd, input.cwd),
  env: { ...(input.env ?? {}) },
  timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
});

const toRecordedExecutor = (executor: HarnessCommandExecutor): HarnessRecordedExecutor => ({
  kind: executor.kind,
  argv: [...executor.argv],
  cwd: executor.cwd,
  envKeys: Object.keys(executor.env).sort(),
  timeoutMs: executor.timeoutMs,
});

const normalizeHarnessExpectedRules = (value: unknown, label: string): HarnessExpectedRules => {
  if (value === undefined) return {};
  if (!isObjectRecord(value)) {
    throw new Error(`${label}.expected 값은 객체여야 합니다.`);
  }
  assertAllowedKeys(value, ["exitCode", "mustInclude", "mustNotInclude", "stderrMustInclude", "stderrMustNotInclude", "jsonSubset"], `${label}.expected`);
  if (value.exitCode !== undefined && (typeof value.exitCode !== "number" || !Number.isInteger(value.exitCode))) {
    throw new Error(`${label}.expected.exitCode 값은 정수여야 합니다.`);
  }
  if (value.jsonSubset !== undefined && !isObjectRecord(value.jsonSubset)) {
    throw new Error(`${label}.expected.jsonSubset 값은 객체여야 합니다.`);
  }
  return {
    exitCode: value.exitCode as number | undefined,
    mustInclude: value.mustInclude === undefined ? [] : asStringArray(value.mustInclude, `${label}.expected.mustInclude`),
    mustNotInclude: value.mustNotInclude === undefined ? [] : asStringArray(value.mustNotInclude, `${label}.expected.mustNotInclude`),
    stderrMustInclude:
      value.stderrMustInclude === undefined ? [] : asStringArray(value.stderrMustInclude, `${label}.expected.stderrMustInclude`),
    stderrMustNotInclude:
      value.stderrMustNotInclude === undefined ? [] : asStringArray(value.stderrMustNotInclude, `${label}.expected.stderrMustNotInclude`),
    jsonSubset: value.jsonSubset as Record<string, unknown> | undefined,
  };
};

const hasHarnessRules = (rules: HarnessExpectedRules): boolean =>
  rules.exitCode !== undefined ||
  Boolean(rules.mustInclude?.length) ||
  Boolean(rules.mustNotInclude?.length) ||
  Boolean(rules.stderrMustInclude?.length) ||
  Boolean(rules.stderrMustNotInclude?.length) ||
  Boolean(rules.jsonSubset && Object.keys(rules.jsonSubset).length > 0);

const stableStringify = (value: unknown): string => JSON.stringify(value, null, 2);

const hashIfPresent = (value: string | null): string | null => (value ? sha1(value) : null);

const toMaskedExcerpt = (value: string, secretMasking: boolean): string | null => {
  if (!value) return null;
  const masked = secretMasking ? maskSecrets(value).text : value;
  return compactText(masked.slice(0, MAX_OUTPUT_CAPTURE), 320);
};

const tryParseJson = (value: string): unknown | undefined => {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
};

const matchesJsonSubset = (actual: unknown, expected: unknown): boolean => {
  if (expected === null || typeof expected !== "object") {
    return Object.is(actual, expected);
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length < expected.length) return false;
    return expected.every((entry, index) => matchesJsonSubset(actual[index], entry));
  }
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
  return Object.entries(expected as Record<string, unknown>).every(([key, entry]) =>
    matchesJsonSubset((actual as Record<string, unknown>)[key], entry),
  );
};

interface HarnessRuleSource {
  artifactId: string;
  kind: HarnessArtifactKind | "case";
  title: string;
  rules: HarnessExpectedRules;
}

interface HarnessResolvedCase {
  caseArtifact: ArtifactRecord;
  supportArtifacts: ArtifactRecord[];
  ruleSources: HarnessRuleSource[];
  executorPayload: Record<string, unknown>;
}

interface HarnessExecutionResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  runtimeError: string | null;
  structuredOutput?: unknown;
}

const toHarnessResourcePayload = (artifact: ArtifactRecord): Record<string, unknown> => ({
  artifactId: artifact.artifactId,
  kind: artifact.kind,
  title: artifact.title,
  summary: artifact.summary,
  input: isObjectRecord(artifact.payload?.input) ? artifact.payload?.input : undefined,
  expected: isObjectRecord(artifact.payload?.expected) ? artifact.payload?.expected : undefined,
});

const resolveReferencedArtifact = async (
  cwd: string,
  cache: Map<string, ArtifactRecord>,
  artifactId: string,
  label: string,
): Promise<ArtifactRecord> => {
  const artifact = cache.get(artifactId) ?? (await loadArtifactRecord(cwd, artifactId));
  if (!artifact) {
    throw new Error(`${label} artifact를 찾을 수 없습니다: ${artifactId}`);
  }
  cache.set(artifactId, artifact);
  return artifact;
};

const resolveHarnessCase = async (
  cwd: string,
  suite: ArtifactRecord,
  resourceCache: Map<string, ArtifactRecord>,
  caseArtifact: ArtifactRecord,
): Promise<HarnessResolvedCase> => {
  const oracleRefs = Array.isArray(caseArtifact.payload?.oracleRefs) ? (caseArtifact.payload.oracleRefs as string[]) : [];
  const resourceRefs = Array.isArray(caseArtifact.payload?.resourceRefs) ? (caseArtifact.payload.resourceRefs as string[]) : [];
  const supportArtifacts: ArtifactRecord[] = [];
  for (const resourceRef of [...oracleRefs, ...resourceRefs]) {
    supportArtifacts.push(await resolveReferencedArtifact(cwd, resourceCache, resourceRef, `case ${caseArtifact.artifactId}`));
  }

  const ruleSources: HarnessRuleSource[] = [];
  const caseRules = normalizeHarnessExpectedRules(caseArtifact.payload?.expected, `case ${caseArtifact.artifactId}`);
  if (hasHarnessRules(caseRules)) {
    ruleSources.push({
      artifactId: caseArtifact.artifactId,
      kind: "case",
      title: caseArtifact.title,
      rules: caseRules,
    });
  }

  for (const artifact of supportArtifacts) {
    if (!["oracle", "checker", "rubric", "golden"].includes(artifact.kind)) continue;
    const artifactKind = artifact.kind as Extract<HarnessArtifactKind, "oracle" | "checker" | "rubric" | "golden">;
    const rules = normalizeHarnessExpectedRules(artifact.payload?.expected, `harness resource ${artifact.artifactId}`);
    if (!hasHarnessRules(rules)) {
      throw new Error(`${artifact.artifactId} (${artifact.kind}) 는 deterministic expected rules가 있어야 harness run에 사용할 수 있습니다.`);
    }
    ruleSources.push({
      artifactId: artifact.artifactId,
      kind: artifactKind,
      title: artifact.title,
      rules,
    });
  }

  if (ruleSources.length === 0) {
    throw new Error(`case ${caseArtifact.artifactId} 에 실행 가능한 deterministic rule source가 없습니다.`);
  }

  const groupedResources = {
    oracles: supportArtifacts.filter((artifact) => artifact.kind === "oracle").map(toHarnessResourcePayload),
    checkers: supportArtifacts.filter((artifact) => artifact.kind === "checker").map(toHarnessResourcePayload),
    rubrics: supportArtifacts.filter((artifact) => artifact.kind === "rubric").map(toHarnessResourcePayload),
    fixtures: supportArtifacts.filter((artifact) => artifact.kind === "fixture").map(toHarnessResourcePayload),
    goldens: supportArtifacts.filter((artifact) => artifact.kind === "golden").map(toHarnessResourcePayload),
    traces: supportArtifacts.filter((artifact) => artifact.kind === "trace").map(toHarnessResourcePayload),
    envAssumptions: supportArtifacts.filter((artifact) => artifact.kind === "envAssumption").map(toHarnessResourcePayload),
  };

  return {
    caseArtifact,
    supportArtifacts,
    ruleSources,
    executorPayload: {
      version: 1,
      suite: {
        artifactId: suite.artifactId,
        title: suite.title,
        goal: typeof suite.payload?.goal === "string" ? suite.payload.goal : null,
      },
      case: {
        artifactId: caseArtifact.artifactId,
        title: caseArtifact.title,
        summary: caseArtifact.summary,
        input: isObjectRecord(caseArtifact.payload?.input) ? caseArtifact.payload.input : {},
        expected: isObjectRecord(caseArtifact.payload?.expected) ? caseArtifact.payload.expected : undefined,
        evidenceRefs: Array.isArray(caseArtifact.payload?.evidenceRefs) ? caseArtifact.payload.evidenceRefs : [],
      },
      resources: groupedResources,
    },
  };
};

const executeHarnessCommand = async (
  cwd: string,
  executor: HarnessCommandExecutor,
  payload: Record<string, unknown>,
): Promise<HarnessExecutionResult> =>
  await new Promise((resolve) => {
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let runtimeError: string | null = null;
    let timedOut = false;
    const child = spawn(executor.argv[0], executor.argv.slice(1), {
      cwd: path.resolve(cwd, executor.cwd),
      env: { ...process.env, ...executor.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 250).unref();
    }, executor.timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      runtimeError = error.message;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const finalStdout = stdout;
      const finalStderr = runtimeError ? `${stderr}\n${runtimeError}`.trim() : stderr;
      resolve({
        exitCode: code,
        stdout: finalStdout,
        stderr: finalStderr,
        durationMs: Date.now() - startedAt,
        timedOut,
        runtimeError,
        structuredOutput: tryParseJson(finalStdout),
      });
    });
    child.stdin.end(`${stableStringify(payload)}\n`);
  });

const createRuleCheck = (
  source: HarnessRuleSource,
  name: string,
  ok: boolean,
  detail: string,
): HarnessCaseCheckResult => ({
  name,
  ok,
  detail,
  sourceArtifactId: source.artifactId,
  sourceKind: source.kind,
});

const evaluateRuleSource = (
  source: HarnessRuleSource,
  execution: HarnessExecutionResult,
): HarnessCaseCheckResult[] => {
  const checks: HarnessCaseCheckResult[] = [];
  const stdout = execution.stdout;
  const stderr = execution.stderr;
  if (source.rules.exitCode !== undefined) {
    checks.push(
      createRuleCheck(
        source,
        `${source.kind}.${source.artifactId}.exitCode`,
        execution.exitCode === source.rules.exitCode,
        `expected=${source.rules.exitCode}, actual=${execution.exitCode ?? "null"}`,
      ),
    );
  }
  for (const item of source.rules.mustInclude ?? []) {
    checks.push(
      createRuleCheck(
        source,
        `${source.kind}.${source.artifactId}.mustInclude`,
        stdout.includes(item),
        stdout.includes(item) ? item : `missing=${item}`,
      ),
    );
  }
  for (const item of source.rules.mustNotInclude ?? []) {
    checks.push(
      createRuleCheck(
        source,
        `${source.kind}.${source.artifactId}.mustNotInclude`,
        !stdout.includes(item),
        stdout.includes(item) ? `present=${item}` : item,
      ),
    );
  }
  for (const item of source.rules.stderrMustInclude ?? []) {
    checks.push(
      createRuleCheck(
        source,
        `${source.kind}.${source.artifactId}.stderrMustInclude`,
        stderr.includes(item),
        stderr.includes(item) ? item : `missing=${item}`,
      ),
    );
  }
  for (const item of source.rules.stderrMustNotInclude ?? []) {
    checks.push(
      createRuleCheck(
        source,
        `${source.kind}.${source.artifactId}.stderrMustNotInclude`,
        !stderr.includes(item),
        stderr.includes(item) ? `present=${item}` : item,
      ),
    );
  }
  if (source.rules.jsonSubset) {
    const ok = execution.structuredOutput !== undefined && matchesJsonSubset(execution.structuredOutput, source.rules.jsonSubset);
    checks.push(
      createRuleCheck(
        source,
        `${source.kind}.${source.artifactId}.jsonSubset`,
        ok,
        ok ? "matched" : "stdout JSON did not satisfy jsonSubset",
      ),
    );
  }
  return checks;
};

const createFailureArtifact = (
  runId: string,
  suite: ArtifactRecord,
  caseResult: HarnessCaseResult,
  caseArtifact: ArtifactRecord,
  runPath: string,
  headSha: string | null,
): ArtifactRecord => {
  const createdAt = new Date().toISOString();
  const artifactId = createHarnessFailureArtifactId(runId, caseArtifact.artifactId);
  const stdoutEvidence = caseResult.stdoutExcerpt
    ? [
        {
          evidenceId: `evid_${sha1(artifactId, "stdout").slice(0, 12)}`,
          excerpt: caseResult.stdoutExcerpt,
        },
      ]
    : [];
  const stderrEvidence = caseResult.stderrExcerpt
    ? [
        {
          evidenceId: `evid_${sha1(artifactId, "stderr").slice(0, 12)}`,
          excerpt: caseResult.stderrExcerpt,
        },
      ]
    : [];
  const evidenceRefs = [...stdoutEvidence, ...stderrEvidence];
  return {
    artifactId,
    artifactScope: "harness",
    kind: "failure",
    tier: "candidate",
    status: "captured",
    title: `Harness failure: ${caseArtifact.title}`,
    summary: compactText(
      `${caseArtifact.title} failed during harness run ${runId}. status=${caseResult.status}, exitCode=${caseResult.exitCode ?? "null"}`,
      180,
    ),
    text: [
      `# Harness failure: ${caseArtifact.title}`,
      "",
      `- run_id: ${runId}`,
      `- suite_id: ${suite.artifactId}`,
      `- case_id: ${caseArtifact.artifactId}`,
      `- status: ${caseResult.status}`,
      `- exit_code: ${caseResult.exitCode ?? "null"}`,
      `- timed_out: ${caseResult.timedOut}`,
      "",
      "## Failed checks",
      ...caseResult.checkResults.filter((check) => !check.ok).map((check) => `- ${check.name}: ${check.detail}`),
      ...(caseResult.stdoutExcerpt ? ["", "## stdout", "```text", caseResult.stdoutExcerpt, "```"] : []),
      ...(caseResult.stderrExcerpt ? ["", "## stderr", "```text", caseResult.stderrExcerpt, "```"] : []),
    ].join("\n"),
    goalId: suite.goalId,
    episodeId: suite.episodeId,
    sourceSessionId: suite.sourceSessionId,
    sourceHeadSha: headSha,
    captureHeadSha: headSha,
    boundHeadSha: headSha,
    bindingStatus: headSha ? "bound" : "pending",
    authority: "assistant_inferred",
    confidence: 0.86,
    searchPolicy: "evidence",
    relatedPaths: [runPath],
    tags: ["failure", "harness", caseArtifact.artifactId],
    supersedes: [],
    evidenceRefs,
    provenance: {
      actor: "assistant",
      producer: "ragit",
      producerVersion: RAGIT_VERSION,
      operation: "harness.run",
      inputRefs: [suite.artifactId, caseArtifact.artifactId],
      outputRefs: [artifactId],
      evidenceRefs: evidenceRefs.map((entry) => entry.evidenceId),
      contentHash: sha1(runId, caseArtifact.artifactId, caseResult.stdoutHash ?? "none", caseResult.stderrHash ?? "none"),
    },
    createdAt,
    updatedAt: createdAt,
    payload: {
      runId,
      suiteId: suite.artifactId,
      caseId: caseArtifact.artifactId,
      status: caseResult.status,
      exitCode: caseResult.exitCode,
      timedOut: caseResult.timedOut,
      checkResults: caseResult.checkResults,
      stdoutHash: caseResult.stdoutHash,
      stderrHash: caseResult.stderrHash,
    },
  };
};

const writeHarnessRunRecord = async (cwd: string, runId: string, record: HarnessRunRecord, dryRun: boolean): Promise<string> => {
  const target = harnessRunPath(cwd, runId);
  if (!dryRun) {
    const sanitized = sanitizeStructuredValue(record, "harness.run");
    await writeFile(target, `${JSON.stringify(sanitized.value, null, 2)}\n`, "utf8");
  }
  return toRepoPath(cwd, target);
};

const searchPolicyForKind = (kind: HarnessArtifactKind): SearchPolicy =>
  kind === "trace" || kind === "failure" || kind === "fixture" || kind === "golden" ? "evidence" : "harness";

const renderHarnessText = (resource: HarnessCaptureResourceInput): string => {
  const fragments = [
    `# ${resource.title}`,
    "",
    resource.summary ?? `${resource.kind} resource`,
  ];
  if (resource.input) {
    fragments.push("", "## Input", "```json", JSON.stringify(resource.input, null, 2), "```");
  }
  if (resource.expected) {
    fragments.push("", "## Expected", "```json", JSON.stringify(resource.expected, null, 2), "```");
  }
  return fragments.join("\n");
};

const appendHarnessAdmissionEvent = async (
  cwd: string,
  commandPath: "harness capture" | "harness promote" | "harness run",
  admission: AdmissionSummary,
  recordedAt: string,
  sourceHeadSha: string | null,
  sourceSessionId: string | null,
  relatedPaths: string[],
  surface: "harness.capture" | "harness.promote" | "harness.run",
): Promise<void> => {
  if (admission.items.length === 0) return;
  const sourceRefs = Array.from(new Set(admission.items.map((item) => item.sourceRef)));
  await appendLedgerEvent(cwd, {
    eventType: "security.admission",
    recordedAt,
    goalId: null,
    episodeId: null,
    sessionId: sourceSessionId,
    sourceHeadSha,
    summary: `Admission control flagged ${admission.blocked} blocked and ${admission.quarantined} quarantined ${commandPath} input(s)`,
    relatedPaths,
    metadata: {
      commandPath,
      mode: admission.mode,
      surface,
      decisionCounts: {
        allowed: admission.allowed,
        quarantined: admission.quarantined,
        blocked: admission.blocked,
      },
      sourceRefs,
      contentHashes: admission.items.map((item) => `${item.operation}:${item.sourceRef}`),
      reasonCodes: Array.from(new Set(admission.items.flatMap((item) => item.reasonCodes))),
    },
    provenance: {
      actor: "assistant",
      producer: "ragit",
      producerVersion: RAGIT_VERSION,
      operation: "security.admission",
      inputRefs: sourceRefs,
      outputRefs: relatedPaths,
      evidenceRefs: [],
      contentHash: `${sourceHeadSha ?? "none"}:${admission.blocked}:${admission.quarantined}:${sourceRefs.join(",")}`,
    },
  });
};

const docTargetForKind = (artifact: ArtifactRecord): { docType: "spec" | "plan" | "glossary" | "pbd"; path: string } => {
  const titleSlug = artifact.title
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || artifact.artifactId;
  if (artifact.kind === "suite" || artifact.kind === "envAssumption") {
    return { docType: "plan", path: `docs/harness/plans/${titleSlug}.md` };
  }
  if (artifact.kind === "checker" || artifact.kind === "rubric" || artifact.kind === "case" || artifact.kind === "oracle" || artifact.kind === "trace") {
    return { docType: "spec", path: `docs/harness/specs/${titleSlug}.md` };
  }
  if (artifact.kind === "promptTemplate") {
    return { docType: "pbd", path: `docs/harness/pbds/${titleSlug}.md` };
  }
  if (artifact.kind === "fixture" || artifact.kind === "golden" || artifact.kind === "failure") {
    return { docType: "pbd", path: `docs/harness/pbds/${titleSlug}.md` };
  }
  return { docType: "glossary", path: `docs/harness/glossary/${titleSlug}.md` };
};

const renderHarnessDoc = (artifact: ArtifactRecord): string => {
  const target = docTargetForKind(artifact);
  if (target.docType === "plan") {
    return `---
type: plan
source_artifact: "${artifact.artifactId}"
---
# Plan: ${artifact.title}

## Milestones
- ${artifact.summary}

## Work Breakdown
- Review linked harness resources
- Use suite references as canonical handoff
`;
  }
  if (target.docType === "glossary") {
    return `---
type: glossary
source_artifact: "${artifact.artifactId}"
---
# Glossary: ${artifact.title}

## Terms
- **${artifact.title}**: ${artifact.summary}
`;
  }
  if (target.docType === "spec") {
    return `---
type: spec
source_artifact: "${artifact.artifactId}"
---
# SPEC: ${artifact.title}

## Scope
${artifact.summary}

## Functional Requirements
- Keep the harness resource stable and reviewable.

## Interfaces and Contracts
- Source artifact: ${artifact.artifactId}

## State and Flow
- Status: ${artifact.status}

## Acceptance Criteria
- This harness resource can be loaded by harness pack/verify.
`;
  }
  return `---
type: pbd
source_artifact: "${artifact.artifactId}"
---
# PBD: ${artifact.title}

## Implementation Scope
${artifact.summary}

## Phase Topology
## [B1] Capture
- Source artifact: ${artifact.artifactId}

## Binding Map
- Harness resource is promoted into durable docs/harness.

## Interaction Paths
- Used by harness pack and harness verify.

## Failure and Drift Points
- Resource drift from original session evidence.

## Observability Notes
- Review promotion events and ingest output.
`;
};

export const captureHarness = async (cwd: string, input: HarnessCaptureInput, dryRun = false): Promise<HarnessCaptureResult> => {
  await ensureRagitStructure(cwd);
  const config = await loadConfig(cwd);
  assertKnowledgeWriteSecurity(config, "harness.capture", dryRun);
  const createdAt = new Date().toISOString();
  const admittedGoal = evaluateAdmissionStructuredValue(
    { goal: input.goal },
    "harness.capture",
    `harness.capture:${input.goal}`,
    "harness.capture",
    config.security.admission_mode,
  );
  const sanitizedGoal = sanitizeStructuredValue(admittedGoal.value, "harness.capture", "goal");
  const goal = sanitizedGoal.value.goal;
  const admission = mergeAdmissionSummaries(createAdmissionSummary(config.security.admission_mode), admittedGoal.admission);
  const goalId = createGoalId(input.goal);
  const headSha = await safeHeadSha(cwd);
  const artifactIds: string[] = [];
  const createdResources: ArtifactRecord[] = [];
  for (const resource of input.resources) {
    const admittedResource = evaluateAdmissionStructuredValue(
      resource,
      "harness.capture",
      `harness.capture:${resource.kind}:${resource.title}`,
      "harness.capture",
      config.security.admission_mode,
    );
    const mergedAdmission = mergeAdmissionSummaries(admission, admittedResource.admission);
    admission.allowed = mergedAdmission.allowed;
    admission.quarantined = mergedAdmission.quarantined;
    admission.blocked = mergedAdmission.blocked;
    admission.items = mergedAdmission.items;
    const sanitizedResource = sanitizeStructuredValue(admittedResource.value, "harness.capture");
    const nextResource = sanitizedResource.value as HarnessCaptureResourceInput;
    const artifactId = createArtifactId(resource.kind, input.goal, resource.title);
    const record: ArtifactRecord = {
      artifactId,
      artifactScope: "harness",
      kind: nextResource.kind,
      tier: "candidate",
      status: "captured",
      title: nextResource.title,
      summary: nextResource.summary ?? compactText(renderHarnessText(nextResource), 180),
      text: renderHarnessText(nextResource),
      goalId,
      episodeId: input.episodeId ?? null,
      sourceSessionId: input.sourceSessionId ?? null,
      sourceHeadSha: headSha,
      captureHeadSha: headSha,
      boundHeadSha: headSha,
      bindingStatus: headSha ? "bound" : "pending",
      authority: "assistant_inferred",
      confidence: 0.8,
      searchPolicy: searchPolicyForKind(nextResource.kind),
      relatedPaths: [],
      tags: [nextResource.kind, "harness"],
      supersedes: [],
      evidenceRefs: [],
      provenance: {
        actor: "assistant",
        producer: "ragit",
        producerVersion: RAGIT_VERSION,
        operation: "harness.capture",
        inputRefs: [...(input.artifactRefs ?? [])],
        outputRefs: [artifactId],
        evidenceRefs: nextResource.evidenceRefs ?? [],
        contentHash: sha1(artifactId, createdAt),
      },
      createdAt,
      updatedAt: createdAt,
      payload: {
        goal,
        input: nextResource.input,
        expected: nextResource.expected,
        oracleRefs: nextResource.oracleRefs ?? [],
        evidenceRefs: nextResource.evidenceRefs ?? [],
        resourceRefs: nextResource.resourceRefs ?? [],
      },
    };
    if (!dryRun) {
      await persistArtifactRecord(cwd, record, false);
    }
    createdResources.push(record);
    artifactIds.push(artifactId);
  }

  let suite = createdResources.find((resource) => resource.kind === "suite");
  if (!suite) {
    const suiteId = createArtifactId("suite", input.goal, `${input.goal} suite`);
    suite = {
      artifactId: suiteId,
      artifactScope: "harness",
      kind: "suite",
      tier: "candidate",
      status: "captured",
      title: `${goal} suite`,
      summary: `Harness suite for ${goal}`,
      text: `# ${goal} suite\n\n${createdResources.map((resource) => `- ${resource.kind}: ${resource.title}`).join("\n")}`,
      goalId,
      episodeId: input.episodeId ?? null,
      sourceSessionId: input.sourceSessionId ?? null,
      sourceHeadSha: headSha,
      captureHeadSha: headSha,
      boundHeadSha: headSha,
      bindingStatus: headSha ? "bound" : "pending",
      authority: "assistant_inferred",
      confidence: 0.82,
      searchPolicy: "harness",
      relatedPaths: [],
      tags: ["suite", "harness"],
      supersedes: [],
      evidenceRefs: [],
      provenance: {
        actor: "assistant",
        producer: "ragit",
        producerVersion: RAGIT_VERSION,
        operation: "harness.capture",
        inputRefs: [...(input.artifactRefs ?? [])],
        outputRefs: [suiteId],
        evidenceRefs: [],
        contentHash: sha1(suiteId, createdAt),
      },
      createdAt,
      updatedAt: createdAt,
      payload: {
        goal,
        resourceRefs: createdResources.map((resource) => resource.artifactId),
      },
    };
    if (!dryRun) {
      await persistArtifactRecord(cwd, suite, false);
    }
    artifactIds.push(suite.artifactId);
  }

  if (!dryRun) {
    await appendAdmissionRecord(cwd, admission, createdAt);
    await appendHarnessAdmissionEvent(
      cwd,
      "harness capture",
      admission,
      createdAt,
      headSha,
      input.sourceSessionId ?? null,
      [],
      "harness.capture",
    );
  }
  if (!dryRun && artifactIds.length > 0) {
    await appendLedgerEvent(cwd, {
      eventType: "harness.capture",
      recordedAt: createdAt,
      goalId,
      episodeId: input.episodeId ?? null,
      sessionId: input.sourceSessionId ?? null,
      sourceHeadSha: headSha,
      summary: `Captured ${artifactIds.length} harness artifact${artifactIds.length === 1 ? "" : "s"}`,
      artifactIds,
      provenance: {
        actor: "assistant",
        producer: "ragit",
        producerVersion: RAGIT_VERSION,
        operation: "harness.capture",
        inputRefs: [...(input.artifactRefs ?? [])],
        outputRefs: artifactIds,
        evidenceRefs: [],
        contentHash: sha1(goalId, createdAt, ...artifactIds),
      },
    });
  }

  return {
    artifactIds,
    suiteId: suite.artifactId,
    dryRun,
    admission,
    warnings: createdResources.length === 0 ? ["생성된 harness resource가 없습니다."] : [],
  };
};

export const promoteHarness = async (cwd: string, input: HarnessPromoteInput, dryRun = false): Promise<HarnessPromoteResult> => {
  await ensureRagitStructure(cwd);
  const config = await loadConfig(cwd);
  assertKnowledgeWriteSecurity(config, "harness.promote", dryRun);
  const plannedFiles: string[] = [];
  const createdFiles: string[] = [];
  const warnings: string[] = [];
  const admission = createAdmissionSummary(config.security.admission_mode);
  const promotedAt = new Date().toISOString();
  const prepared: Array<{
    artifact: ArtifactRecord;
    target: ReturnType<typeof docTargetForKind>;
    content: string;
  }> = [];
  for (const artifactId of input.artifactRefs) {
    const artifact = await loadArtifactRecord(cwd, artifactId);
    if (!artifact) {
      warnings.push(`artifact를 찾을 수 없습니다: ${artifactId}`);
      continue;
    }
    if (artifact.artifactScope !== "harness") {
      warnings.push(`harness artifact가 아닙니다: ${artifactId}`);
      continue;
    }
    if (artifact.status !== "reviewed") {
      warnings.push(`reviewed 상태만 promote할 수 있습니다: ${artifactId}`);
      continue;
    }
    const target = docTargetForKind(artifact);
    const admittedDoc = evaluateAdmissionStructuredValue(
      { content: renderHarnessDoc(artifact) },
      "harness.promote",
      `harness.promote:${artifact.artifactId}`,
      "harness.promote",
      config.security.admission_mode,
    );
    const mergedAdmission = mergeAdmissionSummaries(admission, admittedDoc.admission);
    admission.allowed = mergedAdmission.allowed;
    admission.quarantined = mergedAdmission.quarantined;
    admission.blocked = mergedAdmission.blocked;
    admission.items = mergedAdmission.items;
    if (config.security.admission_mode === "enforce" && admittedDoc.admission.blocked > 0) {
      throw new Error(`admission control이 harness promote 문서를 차단했습니다: ${artifact.artifactId}`);
    }
    const sanitizedDoc = sanitizeStructuredValue(admittedDoc.value, "harness.promote");
    prepared.push({
      artifact,
      target,
      content: sanitizedDoc.value.content,
    });
  }

  for (const item of prepared) {
    const doc = await createDoc(
      cwd,
      {
        docType: item.target.docType,
        title: item.artifact.title,
        path: item.target.path,
        content: item.content,
      },
      dryRun,
    );
    plannedFiles.push(doc.path);
    if (!dryRun) {
      createdFiles.push(doc.path);
      const sanitizedDoc = sanitizeStructuredValue({ content: item.content }, "harness.promote");
      await persistQuarantineSummary(cwd, config, {
        surface: "harness.promote",
        sourceRef: doc.path,
        summary: sanitizedDoc.summary,
        previewBySource: sanitizedDoc.previewBySource,
        operation: "harness.promote",
        recordedAt: promotedAt,
      });
      await persistArtifactRecord(
        cwd,
        {
          ...item.artifact,
          status: "promoted",
          tier: "durable",
          authority: "promoted_durable",
          updatedAt: promotedAt,
        },
        false,
      );
    }
  }

  if (!dryRun) {
    await appendAdmissionRecord(cwd, admission, promotedAt);
    await appendHarnessAdmissionEvent(
      cwd,
      "harness promote",
      admission,
      promotedAt,
      await safeHeadSha(cwd),
      null,
      plannedFiles,
      "harness.promote",
    );
  }

  if (!dryRun && createdFiles.length > 0) {
    await reconcileDocs(cwd, { dryRun: false, ensureStructure: false });
  }
  const ingested = false;
  if (!dryRun && createdFiles.length > 0) {
    warnings.push(
      "생성된 harness promotion 문서를 commit한 뒤 첫 snapshot은 ragit ingest --all, 이후에는 지원되는 증분 ingest 명령을 실행하세요.",
    );
  }
  if (!dryRun && createdFiles.length > 0) {
    await appendLedgerEvent(cwd, {
      eventType: "harness.promote",
      summary: `Promoted ${createdFiles.length} harness document${createdFiles.length === 1 ? "" : "s"}`,
      artifactIds: input.artifactRefs,
      relatedPaths: createdFiles,
      provenance: {
        actor: "assistant",
        producer: "ragit",
        producerVersion: RAGIT_VERSION,
        operation: "harness.promote",
        inputRefs: input.artifactRefs,
        outputRefs: createdFiles,
        evidenceRefs: [],
        contentHash: sha1(...input.artifactRefs, ...createdFiles),
      },
    });
  }
  return {
    createdFiles,
    plannedFiles,
    ingested,
    dryRun,
    admission,
    warnings,
  };
};

const loadSuiteArtifact = async (cwd: string, suiteRef: string): Promise<ArtifactRecord> => {
  if (suiteRef.endsWith(".json") || suiteRef.includes("/")) {
    const content = await readFile(path.resolve(cwd, suiteRef), "utf8");
    return JSON.parse(content) as ArtifactRecord;
  }
  const artifact = await loadArtifactRecord(cwd, suiteRef);
  if (!artifact) {
    throw new Error(`suite를 찾을 수 없습니다: ${suiteRef}`);
  }
  return artifact;
};

export const packHarness = async (cwd: string, suiteRef: string): Promise<HarnessPackResult> => {
  await ensureRagitStructure(cwd);
  const suite = await loadSuiteArtifact(cwd, suiteRef);
  const resourceRefs = Array.isArray(suite.payload?.resourceRefs) ? (suite.payload?.resourceRefs as string[]) : [];
  const resources: Array<Pick<ArtifactRecord, "artifactId" | "kind" | "title" | "summary" | "status">> = [];
  for (const resourceRef of resourceRefs) {
    const artifact = await loadArtifactRecord(cwd, resourceRef);
    if (!artifact) continue;
    resources.push({
      artifactId: artifact.artifactId,
      kind: artifact.kind,
      title: artifact.title,
      summary: artifact.summary,
      status: artifact.status,
    });
  }
  const sanitized = sanitizeStructuredValue(
    {
      suiteId: suite.artifactId,
      goal: typeof suite.payload?.goal === "string" ? (suite.payload.goal as string) : suite.goalId,
      resources,
    },
    "harness.pack",
  );
  return attachRedactionSummary(sanitized.value, sanitized.summary);
};

export const verifyHarness = async (cwd: string, suiteRef: string): Promise<HarnessVerifyResult> => {
  await ensureRagitStructure(cwd);
  const suite = await loadSuiteArtifact(cwd, suiteRef);
  const checks: HarnessVerifyResult["checks"] = [];
  const resourceRefs = Array.isArray(suite.payload?.resourceRefs) ? (suite.payload?.resourceRefs as string[]) : [];
  checks.push({
    name: "suite.resources",
    ok: resourceRefs.length > 0,
    detail: `resourceRefs=${resourceRefs.length}`,
  });
  for (const resourceRef of resourceRefs) {
    const artifact = await loadArtifactRecord(cwd, resourceRef);
    checks.push({
      name: `suite.resource.${resourceRef}`,
      ok: Boolean(artifact),
      detail: artifact ? artifact.kind : "missing",
    });
    if (!artifact || artifact.kind !== "case") continue;
    const oracleRefs = Array.isArray(artifact.payload?.oracleRefs) ? (artifact.payload?.oracleRefs as string[]) : [];
    const evidenceRefs = Array.isArray(artifact.payload?.evidenceRefs) ? (artifact.payload?.evidenceRefs as string[]) : [];
    checks.push({
      name: `case.oracle.${artifact.artifactId}`,
      ok: oracleRefs.length > 0,
      detail: `oracleRefs=${oracleRefs.length}`,
    });
    checks.push({
      name: `case.evidence.${artifact.artifactId}`,
      ok: evidenceRefs.length > 0,
      detail: `evidenceRefs=${evidenceRefs.length}`,
    });
  }
  return {
    suiteId: suite.artifactId,
    checks,
    hasFailure: checks.some((check) => !check.ok),
  };
};

export const runHarness = async (cwd: string, input: HarnessRunInput, dryRun = false): Promise<HarnessRunResult> => {
  await ensureRagitStructure(cwd);
  const config = await loadConfig(cwd);
  assertKnowledgeWriteSecurity(config, "harness.run", dryRun);
  const suite = await loadSuiteArtifact(cwd, input.suiteRef);
  if (suite.kind !== "suite") {
    throw new Error(`suite artifact가 아닙니다: ${suite.artifactId}`);
  }

  const executor = resolveHarnessExecutor(cwd, input.executor);
  const preflight = await verifyHarness(cwd, input.suiteRef);
  const warnings: string[] = [];
  if (preflight.hasFailure) {
    const warning = `harness verify failed for suite ${suite.artifactId}`;
    if (!dryRun) {
      throw new Error(`${warning}. --dry-run 으로 먼저 계획을 검토하십시오.`);
    }
    warnings.push(warning);
  }

  const resourceRefs = Array.isArray(suite.payload?.resourceRefs) ? (suite.payload.resourceRefs as string[]) : [];
  const resourceCache = new Map<string, ArtifactRecord>();
  const suiteResources: ArtifactRecord[] = [];
  for (const resourceRef of resourceRefs) {
    const artifact = await resolveReferencedArtifact(cwd, resourceCache, resourceRef, `suite ${suite.artifactId}`);
    suiteResources.push(artifact);
  }
  const suiteCases = suiteResources.filter((artifact) => artifact.kind === "case");
  if (suiteCases.length === 0) {
    throw new Error(`suite ${suite.artifactId} 에 실행할 case가 없습니다.`);
  }

  const requestedCases = new Set((input.cases ?? []).filter(Boolean));
  const selectedCases = requestedCases.size > 0 ? suiteCases.filter((artifact) => requestedCases.has(artifact.artifactId)) : suiteCases;
  if (selectedCases.length === 0) {
    throw new Error("선택된 case가 없습니다.");
  }
  for (const caseId of requestedCases) {
    if (!selectedCases.some((artifact) => artifact.artifactId === caseId)) {
      throw new Error(`suite ${suite.artifactId} 에 없는 case 입니다: ${caseId}`);
    }
  }

  const resolvedCases: HarnessResolvedCase[] = [];
  for (const caseArtifact of selectedCases) {
    resolvedCases.push(await resolveHarnessCase(cwd, suite, resourceCache, caseArtifact));
  }

  const startedAt = new Date().toISOString();
  const runId = createRunId(suite.artifactId, startedAt, resolvedCases.map((item) => item.caseArtifact.artifactId));
  const runPath = toRepoPath(cwd, harnessRunPath(cwd, runId));
  const caseResults: HarnessCaseResult[] = [];
  const admission = createAdmissionSummary(config.security.admission_mode);

  for (const resolved of resolvedCases) {
    if (dryRun) {
      caseResults.push({
        caseId: resolved.caseArtifact.artifactId,
        title: resolved.caseArtifact.title,
        status: "skipped",
        exitCode: null,
        durationMs: 0,
        timedOut: false,
        stdoutExcerpt: null,
        stderrExcerpt: null,
        stdoutHash: null,
        stderrHash: null,
        checkResults: [],
        failureArtifactIds: [],
      });
      continue;
    }

    const execution = await executeHarnessCommand(cwd, executor, resolved.executorPayload);
    const stdoutAdmission = applyAdmissionText(
      execution.stdout,
      "harness.run",
      `${runPath}#${resolved.caseArtifact.artifactId}.stdout`,
      "harness.run",
      config.security.admission_mode,
    );
    const stderrAdmission = applyAdmissionText(
      execution.stderr,
      "harness.run",
      `${runPath}#${resolved.caseArtifact.artifactId}.stderr`,
      "harness.run",
      config.security.admission_mode,
    );
    const structuredAdmission =
      execution.structuredOutput === undefined
        ? null
        : evaluateAdmissionStructuredValue(
            execution.structuredOutput,
            "harness.run",
            `${runPath}#${resolved.caseArtifact.artifactId}.structuredOutput`,
            "harness.run",
            config.security.admission_mode,
            "structuredOutput",
          );
    const mergedAdmission = mergeAdmissionSummaries(
      admission,
      stdoutAdmission.admission,
      stderrAdmission.admission,
      structuredAdmission?.admission ?? createAdmissionSummary(config.security.admission_mode),
    );
    admission.allowed = mergedAdmission.allowed;
    admission.quarantined = mergedAdmission.quarantined;
    admission.blocked = mergedAdmission.blocked;
    admission.items = mergedAdmission.items;
    const checkResults: HarnessCaseCheckResult[] = [];
    const hasExplicitExitCode = resolved.ruleSources.some((source) => source.rules.exitCode !== undefined);
    if (execution.runtimeError) {
      checkResults.push({
        name: `runtime.${resolved.caseArtifact.artifactId}.spawn`,
        ok: false,
        detail: execution.runtimeError,
        sourceArtifactId: resolved.caseArtifact.artifactId,
        sourceKind: "case",
      });
    }
    if (execution.timedOut) {
      checkResults.push({
        name: `runtime.${resolved.caseArtifact.artifactId}.timeout`,
        ok: false,
        detail: `timeoutMs=${executor.timeoutMs}`,
        sourceArtifactId: resolved.caseArtifact.artifactId,
        sourceKind: "case",
      });
    }
    for (const source of resolved.ruleSources) {
      checkResults.push(...evaluateRuleSource(source, execution));
    }
    if (!hasExplicitExitCode) {
      checkResults.push({
        name: `runtime.${resolved.caseArtifact.artifactId}.defaultExitCode`,
        ok: execution.exitCode === 0,
        detail: `expected=0, actual=${execution.exitCode ?? "null"}`,
        sourceArtifactId: resolved.caseArtifact.artifactId,
        sourceKind: "case",
      });
    }
    const status =
      execution.runtimeError || execution.timedOut
        ? "errored"
        : checkResults.every((check) => check.ok)
          ? "passed"
          : "failed";
    caseResults.push({
      caseId: resolved.caseArtifact.artifactId,
      title: resolved.caseArtifact.title,
      status,
      exitCode: execution.exitCode,
      durationMs: execution.durationMs,
      timedOut: execution.timedOut,
      stdoutExcerpt:
        config.security.admission_mode === "enforce" && stdoutAdmission.evaluation.action === "block"
          ? null
          : toMaskedExcerpt(stdoutAdmission.text, false),
      stderrExcerpt:
        config.security.admission_mode === "enforce" && stderrAdmission.evaluation.action === "block"
          ? null
          : toMaskedExcerpt(stderrAdmission.text, false),
      stdoutHash: hashIfPresent(execution.stdout || null),
      stderrHash: hashIfPresent(execution.stderr || null),
      structuredOutputSummary:
        structuredAdmission === null
          ? undefined
          : config.security.admission_mode === "enforce" && structuredAdmission.admission.blocked > 0
            ? undefined
            : sanitizeStructuredValue(structuredAdmission.value, "harness.run", "structuredOutput").value,
      checkResults,
      failureArtifactIds: [],
    });
  }

  const headSha = await safeHeadSha(cwd);
  const failureArtifactIds: string[] = [];
  if (!dryRun) {
    for (const caseResult of caseResults) {
      if (caseResult.status !== "failed" && caseResult.status !== "errored") continue;
      const resolvedCase = resolvedCases.find((entry) => entry.caseArtifact.artifactId === caseResult.caseId);
      if (!resolvedCase) continue;
      const failureArtifact = createFailureArtifact(runId, suite, caseResult, resolvedCase.caseArtifact, runPath, headSha);
      await persistArtifactRecord(cwd, failureArtifact, false);
      caseResult.failureArtifactIds.push(failureArtifact.artifactId);
      failureArtifactIds.push(failureArtifact.artifactId);
    }
  }

  const summary = caseResults.reduce<HarnessRunResult["summary"]>(
    (acc, result) => {
      acc.total += 1;
      if (result.status === "passed") acc.passed += 1;
      if (result.status === "failed") acc.failed += 1;
      if (result.status === "errored") acc.errored += 1;
      if (result.status === "skipped") acc.skipped += 1;
      return acc;
    },
    { total: 0, passed: 0, failed: 0, errored: 0, skipped: 0 },
  );

  const finishedAt = new Date().toISOString();
  const hasFailure = preflight.hasFailure || summary.failed > 0 || summary.errored > 0;
  const runRecord: HarnessRunRecord = {
    version: 1,
    runId,
    suiteId: suite.artifactId,
    goalId: suite.goalId,
    episodeId: suite.episodeId,
    sourceSessionId: suite.sourceSessionId,
    sourceHeadSha: headSha,
    executor: toRecordedExecutor(executor),
    selectedCaseIds: resolvedCases.map((item) => item.caseArtifact.artifactId),
    summary,
    caseResults,
    startedAt,
    finishedAt,
    dryRun,
    warnings,
    provenance: {
      actor: "assistant",
      producer: "ragit",
      producerVersion: RAGIT_VERSION,
      operation: "harness.run",
      inputRefs: [suite.artifactId, ...resolvedCases.map((item) => item.caseArtifact.artifactId)],
      outputRefs: [runPath, ...failureArtifactIds],
      evidenceRefs: failureArtifactIds,
      contentHash: sha1(runId, suite.artifactId, ...failureArtifactIds, JSON.stringify(summary)),
    },
  };

  await writeHarnessRunRecord(cwd, runId, runRecord, dryRun);
  if (!dryRun) {
    await appendAdmissionRecord(cwd, admission, finishedAt);
    await appendHarnessAdmissionEvent(
      cwd,
      "harness run",
      admission,
      finishedAt,
      headSha,
      suite.sourceSessionId,
      [runPath],
      "harness.run",
    );
    const sanitizedRunRecord = sanitizeStructuredValue(runRecord, "harness.run");
    await persistQuarantineSummary(cwd, config, {
      surface: "harness.run",
      sourceRef: runPath,
      summary: sanitizedRunRecord.summary,
      previewBySource: sanitizedRunRecord.previewBySource,
      operation: "harness.run",
      recordedAt: finishedAt,
    });
  }
  if (!dryRun) {
    await appendLedgerEvent(cwd, {
      eventType: "harness.run",
      recordedAt: finishedAt,
      goalId: suite.goalId,
      episodeId: suite.episodeId,
      sessionId: suite.sourceSessionId,
      sourceHeadSha: headSha,
      summary: `Executed harness suite ${suite.artifactId}: ${summary.passed} passed, ${summary.failed} failed, ${summary.errored} errored`,
      artifactIds: [suite.artifactId, ...failureArtifactIds],
      relatedPaths: [runPath],
      metadata: {
        runId,
        suiteId: suite.artifactId,
        executorKind: executor.kind,
        counts: summary,
      },
      provenance: runRecord.provenance,
    });
  }

  return {
    runId,
    suiteId: suite.artifactId,
    runPath,
    preflight,
    dryRun,
    hasFailure,
    summary,
    caseResults,
    admission,
    warnings,
  };
};
