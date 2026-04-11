import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { loadConfig } from "./config.js";
import { resolveEmbeddingProfile } from "./embedding.js";
import { latestSnapshotSha, loadSnapshotManifest } from "./manifest.js";
import { toRepoPath } from "./identity.js";
import { maskSecrets } from "./mask.js";
import { ensureRagitStructure, resolveRagitPaths } from "./project.js";
import { bootstrapCanonicalStore, closeCanonicalStore, readCanonicalStoreMeta } from "./store.js";
import {
  AdmissionAction,
  AdmissionItem,
  AdmissionMode,
  AdmissionReasonCode,
  AdmissionSummary,
  EmbeddingEgressClass,
  EmbeddingProfile,
  RagitConfig,
  RedactionSummary,
  SecurityAuditFinding,
  SecurityAuditResult,
  SecurityPurgeResult,
  SecurityPurgeTarget,
  SecuritySurface,
} from "./types.js";

type SanitizedTextResult = {
  text: string;
  summary: RedactionSummary;
  previewBySource: Record<string, string>;
};

type SanitizedValueResult<T> = {
  value: T;
  summary: RedactionSummary;
  previewBySource: Record<string, string>;
};

export interface SecurityState {
  lastAuditAt: string | null;
  legacyUnsafeState: boolean;
}

type AuditBuckets = {
  controlPlane: Set<string>;
  store: Set<string>;
  repoDocs: Set<string>;
};

interface AdmissionEvaluation {
  action: AdmissionAction;
  reasonCodes: AdmissionReasonCode[];
  maskedCount: number;
  sanitizedText: string;
  contentHash: string;
}

interface AdmissionStats {
  blocked: number;
  quarantined: number;
  lastAdmissionAt: string | null;
}

const LOCAL_OLLAMA_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const CONTROL_PLANE_PATTERNS = [
  "log/transcripts/**/*.jsonl",
  "log/events/**/*.jsonl",
  "log/harness-runs/**/*.json",
  "artifacts/**/*.json",
  "memory/**/*.json",
  "security/admission/**/*.jsonl",
];
const ADMISSION_SENTINEL = "[BLOCKED BY RAGIT ADMISSION CONTROL]";
const HIGH_RISK_PATH_PATTERNS = [
  /^\.env(?:\..+)?$/i,
  /(^|\/)\.env(?:\.[^/]+)?$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)kubeconfig$/i,
  /(^|\/)config\.json$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/i,
  /(^|\/).+\.(pem|key|p12|pfx)$/i,
  /(^|\/)(?:secrets?|credentials?|ssh|gcloud|aws)(\/|$)/i,
];
const PRIVATE_KEY_BLOCK_REGEX = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/m;
const HEADER_OR_COOKIE_DUMP_REGEX = /(^|\n)\s*(authorization|cookie|set-cookie|x-api-key)\s*:/i;
const ENV_DUMP_LINE_REGEX = /^[A-Z][A-Z0-9_]{1,63}=(?!\s*$).+/;

const normalizeWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim();
const compactText = (value: string, max = 120): string => {
  const normalized = normalizeWhitespace(value);
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max)}...`;
};
const sha1 = (...parts: string[]): string => createHash("sha1").update(parts.join(":")).digest("hex");
const uniqueSources = (sources: string[]): string[] => Array.from(new Set(sources.filter(Boolean)));
const normalizeRepoSourceRef = (sourceRef: string): string => sourceRef.replaceAll("\\", "/");
const admissionLogPath = (cwd: string, recordedAt: string): string =>
  path.join(resolveRagitPaths(cwd).admissionDir, `${recordedAt.slice(0, 10)}.jsonl`);
const isHighRiskPath = (sourceRef: string): boolean => {
  const normalized = normalizeRepoSourceRef(sourceRef);
  return HIGH_RISK_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
};
const countEnvDumpLines = (source: string): number =>
  source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => ENV_DUMP_LINE_REGEX.test(line)).length;
const appendAdmissionLine = async (target: string, payload: unknown): Promise<void> => {
  await mkdir(path.dirname(target), { recursive: true });
  await appendFile(target, `${JSON.stringify(payload)}\n`, "utf8");
};

const emptyRedactionSummary = (): RedactionSummary => ({
  applied: false,
  maskedCount: 0,
  sources: [],
});

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const buildFieldPath = (prefix: string, key: string): string => (prefix ? `${prefix}.${key}` : key);

const mergePreviewMaps = (...maps: Array<Record<string, string>>): Record<string, string> =>
  Object.assign({}, ...maps);

export const mergeRedactionSummaries = (...summaries: Array<RedactionSummary | null | undefined>): RedactionSummary => {
  const maskedCount = summaries.reduce((sum, summary) => sum + (summary?.maskedCount ?? 0), 0);
  const sources = uniqueSources(summaries.flatMap((summary) => summary?.sources ?? []));
  return {
    applied: maskedCount > 0,
    maskedCount,
    sources,
  };
};

export const createAdmissionSummary = (mode: AdmissionMode): AdmissionSummary => ({
  mode,
  allowed: 0,
  quarantined: 0,
  blocked: 0,
  items: [],
});

export const recordAdmissionDecision = (
  summary: AdmissionSummary,
  action: AdmissionAction,
  item?: AdmissionItem,
): AdmissionSummary => {
  if (action === "allow") {
    summary.allowed += 1;
    return summary;
  }
  if (action === "quarantine") {
    summary.quarantined += 1;
  } else if (action === "block") {
    summary.blocked += 1;
  }
  if (item) summary.items.push(item);
  return summary;
};

export const mergeAdmissionSummaries = (...summaries: Array<AdmissionSummary | null | undefined>): AdmissionSummary => {
  const mode = summaries.find((entry) => entry)?.mode ?? "report-only";
  const merged = createAdmissionSummary(mode);
  for (const summary of summaries) {
    if (!summary) continue;
    merged.allowed += summary.allowed;
    merged.quarantined += summary.quarantined;
    merged.blocked += summary.blocked;
    merged.items.push(...summary.items);
  }
  return merged;
};

const evaluateAdmissionDecision = (
  source: string,
  sourceRef: string,
): AdmissionEvaluation => {
  const normalizedSourceRef = normalizeRepoSourceRef(sourceRef);
  const masked = maskSecrets(source);
  const reasonCodes: AdmissionReasonCode[] = [];
  if (isHighRiskPath(normalizedSourceRef)) {
    reasonCodes.push("high_risk_path");
  }
  if (PRIVATE_KEY_BLOCK_REGEX.test(source)) {
    reasonCodes.push("private_key_block");
  }
  if (HEADER_OR_COOKIE_DUMP_REGEX.test(source)) {
    reasonCodes.push("header_or_cookie_dump");
    reasonCodes.push("credential_dump");
  }
  if (countEnvDumpLines(source) >= 3) {
    reasonCodes.push("env_dump");
    reasonCodes.push("credential_dump");
  }
  if (masked.maskedCount >= 3) {
    reasonCodes.push("multi_secret_payload");
  }
  if (masked.maskedCount > 0) {
    reasonCodes.push("secret_pattern");
  }
  const uniqueReasonCodes = Array.from(new Set(reasonCodes));
  const action: AdmissionAction =
    uniqueReasonCodes.some((code) =>
      code === "high_risk_path" ||
      code === "private_key_block" ||
      code === "credential_dump" ||
      code === "env_dump" ||
      code === "header_or_cookie_dump" ||
      code === "multi_secret_payload",
    )
      ? "block"
      : masked.maskedCount > 0
        ? "quarantine"
        : "allow";
  return {
    action,
    reasonCodes: uniqueReasonCodes,
    maskedCount: masked.maskedCount,
    sanitizedText: masked.text,
    contentHash: sha1(normalizedSourceRef, source),
  };
};

export const evaluateAdmissionText = (
  source: string,
  surface: SecuritySurface,
  sourceRef: string,
): AdmissionEvaluation & { surface: SecuritySurface; sourceRef: string } => ({
  ...evaluateAdmissionDecision(source, sourceRef),
  surface,
  sourceRef: normalizeRepoSourceRef(sourceRef),
});

export const applyAdmissionText = (
  source: string,
  surface: SecuritySurface,
  sourceRef: string,
  operation: string,
  mode: AdmissionMode,
): { text: string; admission: AdmissionSummary; evaluation: AdmissionEvaluation } => {
  const evaluation = evaluateAdmissionText(source, surface, sourceRef);
  const summary = createAdmissionSummary(mode);
  recordAdmissionDecision(
    summary,
    evaluation.action,
    evaluation.action === "allow"
      ? undefined
      : {
          sourceRef: evaluation.sourceRef,
          surface,
          action: evaluation.action,
          reasonCodes: evaluation.reasonCodes,
          operation,
        },
  );
  return {
    text: evaluation.action === "block" && mode === "enforce" ? ADMISSION_SENTINEL : evaluation.sanitizedText,
    admission: summary,
    evaluation,
  };
};

export const evaluateAdmissionStructuredValue = <T>(
  value: T,
  surface: SecuritySurface,
  sourceRef: string,
  operation: string,
  mode: AdmissionMode,
  rootPath = "",
): { value: T; admission: AdmissionSummary } => {
  if (typeof value === "string") {
    const effectiveSourceRef = rootPath ? `${normalizeRepoSourceRef(sourceRef)}#${rootPath}` : normalizeRepoSourceRef(sourceRef);
    const applied = applyAdmissionText(value, surface, effectiveSourceRef, operation, mode);
    return {
      value: applied.text as T,
      admission: applied.admission,
    };
  }
  if (Array.isArray(value)) {
    const items = value.map((entry, index) =>
      evaluateAdmissionStructuredValue(entry, surface, sourceRef, operation, mode, `${rootPath}[${index}]`),
    );
    return {
      value: items.map((entry) => entry.value) as T,
      admission: mergeAdmissionSummaries(...items.map((entry) => entry.admission)),
    };
  }
  if (isPlainObject(value)) {
    const output: Record<string, unknown> = {};
    const summaries: AdmissionSummary[] = [];
    for (const [key, entry] of Object.entries(value)) {
      const nextPath = buildFieldPath(rootPath, key);
      const resolved = evaluateAdmissionStructuredValue(entry, surface, sourceRef, operation, mode, nextPath);
      output[key] = resolved.value;
      summaries.push(resolved.admission);
    }
    return {
      value: output as T,
      admission: mergeAdmissionSummaries(...summaries),
    };
  }
  const summary = createAdmissionSummary(mode);
  recordAdmissionDecision(summary, "allow");
  return { value, admission: summary };
};

export const sanitizeKnowledgeText = (
  source: string,
  _surface: SecuritySurface,
  sourcePath = "value",
): SanitizedTextResult => {
  const masked = maskSecrets(source);
  if (masked.maskedCount === 0) {
    return {
      text: source,
      summary: emptyRedactionSummary(),
      previewBySource: {},
    };
  }
  return {
    text: masked.text,
    summary: {
      applied: true,
      maskedCount: masked.maskedCount,
      sources: [sourcePath],
    },
    previewBySource: {
      [sourcePath]: compactText(masked.text, 160),
    },
  };
};

export const sanitizeStructuredValue = <T>(
  value: T,
  surface: SecuritySurface,
  rootPath = "",
): SanitizedValueResult<T> => {
  if (typeof value === "string") {
    const sanitized = sanitizeKnowledgeText(value, surface, rootPath || "value");
    return {
      value: sanitized.text as T,
      summary: sanitized.summary,
      previewBySource: sanitized.previewBySource,
    };
  }
  if (Array.isArray(value)) {
    const items = value.map((entry, index) => sanitizeStructuredValue(entry, surface, `${rootPath}[${index}]`));
    return {
      value: items.map((entry) => entry.value) as T,
      summary: mergeRedactionSummaries(...items.map((entry) => entry.summary)),
      previewBySource: mergePreviewMaps(...items.map((entry) => entry.previewBySource)),
    };
  }
  if (isPlainObject(value)) {
    const output: Record<string, unknown> = {};
    const results: Array<SanitizedValueResult<unknown>> = [];
    for (const [key, entry] of Object.entries(value)) {
      const sanitized = sanitizeStructuredValue(entry, surface, buildFieldPath(rootPath, key));
      output[key] = sanitized.value;
      results.push(sanitized);
    }
    return {
      value: output as T,
      summary: mergeRedactionSummaries(...results.map((entry) => entry.summary)),
      previewBySource: mergePreviewMaps(...results.map((entry) => entry.previewBySource)),
    };
  }
  return {
    value,
    summary: emptyRedactionSummary(),
    previewBySource: {},
  };
};

export const attachRedactionSummary = <T extends object>(value: T, summary: RedactionSummary): T & { redactionSummary: RedactionSummary } => ({
  ...value,
  redactionSummary: summary,
});

export const assertKnowledgeWriteSecurity = (
  config: RagitConfig,
  operation: string,
  dryRun = false,
): void => {
  if (!config.security.secret_masking && !dryRun) {
    throw new Error(`${operation} apply는 security.secret_masking=true 일 때만 허용됩니다.`);
  }
};

export const classifyEmbeddingEgress = (profile: EmbeddingProfile): EmbeddingEgressClass => {
  if (profile.provider === "local-placeholder") return "local";
  if (profile.provider === "openai") return "remote";
  const candidate = profile.baseUrl ?? "http://127.0.0.1:11434";
  try {
    const hostname = new URL(candidate).hostname.toLowerCase();
    return LOCAL_OLLAMA_HOSTS.has(hostname) ? "local" : "remote";
  } catch {
    return "remote";
  }
};

export const canUseRemoteEmbedding = (
  config: RagitConfig,
  profile: EmbeddingProfile,
  payloadClass: "durable-doc" | "query" | "artifact" | "evidence" | "operational",
): boolean => {
  const egress = classifyEmbeddingEgress(profile);
  if (egress === "local") return true;
  if (config.security.remote_embedding_policy === "local-only") return false;
  return payloadClass === "durable-doc" || payloadClass === "query";
};

export const evaluateRepoDocCandidate = (
  repoPath: string,
  selectorMode: "implicit" | "explicit",
  content?: string,
): AdmissionEvaluation & { selectorMode: "implicit" | "explicit"; sourceRef: string; surface: "ingest.document" } => {
  const sourceRef = normalizeRepoSourceRef(repoPath);
  const evaluation = evaluateAdmissionDecision(content ?? "", sourceRef);
  if (evaluation.action === "allow" && isHighRiskPath(sourceRef)) {
    return {
      ...evaluation,
      action: "block",
      reasonCodes: Array.from(new Set([...evaluation.reasonCodes, "high_risk_path"])),
      selectorMode,
      sourceRef,
      surface: "ingest.document",
    };
  }
  return {
    ...evaluation,
    selectorMode,
    sourceRef,
    surface: "ingest.document",
  };
};

const readJsonIfExists = async <T>(target: string): Promise<T | null> => {
  try {
    const content = await readFile(target, "utf8");
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
};

const writeJson = async (target: string, payload: unknown): Promise<void> => {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
};

const listFiles = async (target: string): Promise<string[]> => {
  try {
    const entries = await readdir(target, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const absolute = path.join(target, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await listFiles(absolute)));
      } else if (entry.isFile()) {
        files.push(absolute);
      }
    }
    return files;
  } catch {
    return [];
  }
};

const controlPlaneFiles = async (cwd: string): Promise<string[]> => {
  const paths = resolveRagitPaths(cwd);
  const files = await fg(CONTROL_PLANE_PATTERNS, {
    cwd: paths.ragitDir,
    absolute: true,
    dot: true,
    onlyFiles: true,
  });
  return files.sort();
};

const repoDocumentFiles = async (cwd: string, config: RagitConfig): Promise<string[]> => {
  const files = await fg(config.ingest.include, {
    cwd,
    absolute: true,
    dot: false,
    onlyFiles: true,
    ignore: config.ingest.exclude,
  });
  return files.filter((file) => file.endsWith(".md") || file.endsWith(".mdx")).sort();
};

const quarantineLogPath = (cwd: string, recordedAt: string): string =>
  path.join(resolveRagitPaths(cwd).quarantineDir, `${recordedAt.slice(0, 10)}.jsonl`);

const appendQuarantineLine = async (target: string, payload: unknown): Promise<void> => {
  await mkdir(path.dirname(target), { recursive: true });
  await appendFile(target, `${JSON.stringify(payload)}\n`, "utf8");
};

export const persistQuarantineSummary = async (
  cwd: string,
  config: RagitConfig,
  params: {
    surface: SecuritySurface;
    sourceRef: string;
    summary: RedactionSummary;
    operation: string;
    previewBySource?: Record<string, string>;
    recordedAt?: string;
  },
): Promise<void> => {
  if (!config.security.quarantine_on_redaction || !params.summary.applied) return;
  const recordedAt = params.recordedAt ?? new Date().toISOString();
  const target = quarantineLogPath(cwd, recordedAt);
  const previews = params.previewBySource ?? {};
  for (const source of params.summary.sources) {
    const maskedPreview = previews[source] ?? "[REDACTED]";
    await appendQuarantineLine(target, {
      recordedAt,
      surface: params.surface,
      sourceRef: params.sourceRef,
      field: source,
      reasonCodes: ["secret_pattern"],
      maskedCount: params.summary.maskedCount,
      contentHash: sha1(params.sourceRef, source, params.operation, maskedPreview),
      maskedPreview,
      operation: params.operation,
    });
  }
};

export const countQuarantineEntries = async (cwd: string): Promise<number> => {
  await ensureRagitStructure(cwd);
  const files = await listFiles(resolveRagitPaths(cwd).quarantineDir);
  let count = 0;
  for (const file of files) {
    const content = await readFile(file, "utf8");
    count += content.split(/\r?\n/).filter((line) => line.trim()).length;
  }
  return count;
};

export const appendAdmissionRecord = async (
  cwd: string,
  summary: AdmissionSummary,
  recordedAt: string,
): Promise<void> => {
  if (summary.items.length === 0) return;
  const target = admissionLogPath(cwd, recordedAt);
  for (const item of summary.items) {
    await appendAdmissionLine(target, {
      recordedAt,
      operation: item.operation,
      surface: item.surface,
      sourceRef: item.sourceRef,
      action: item.action,
      reasonCodes: item.reasonCodes,
      maskedCount: 0,
      contentHash: sha1(item.operation, item.surface, item.sourceRef, item.reasonCodes.join(",")),
    });
  }
};

export const readAdmissionStats = async (cwd: string): Promise<AdmissionStats> => {
  await ensureRagitStructure(cwd);
  const files = await listFiles(resolveRagitPaths(cwd).admissionDir);
  let blocked = 0;
  let quarantined = 0;
  let lastAdmissionAt: string | null = null;
  for (const file of files) {
    const content = await readFile(file, "utf8");
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        const action = typeof parsed.action === "string" ? parsed.action : "";
        const recordedAt = typeof parsed.recordedAt === "string" ? parsed.recordedAt : null;
        if (action === "block") blocked += 1;
        if (action === "quarantine") quarantined += 1;
        if (recordedAt && (!lastAdmissionAt || recordedAt > lastAdmissionAt)) {
          lastAdmissionAt = recordedAt;
        }
      } catch {
        continue;
      }
    }
  }
  return {
    blocked,
    quarantined,
    lastAdmissionAt,
  };
};

export const readSecurityState = async (cwd: string): Promise<SecurityState | null> =>
  await readJsonIfExists<SecurityState>(resolveRagitPaths(cwd).securityStatePath);

const writeSecurityState = async (cwd: string, state: SecurityState): Promise<void> => {
  await writeJson(resolveRagitPaths(cwd).securityStatePath, state);
};

const addFinding = (
  findings: SecurityAuditFinding[],
  buckets: AuditBuckets,
  finding: SecurityAuditFinding,
): void => {
  findings.push(finding);
  if (finding.surface === "control-plane") buckets.controlPlane.add(finding.path);
  if (finding.surface === "store") buckets.store.add(finding.path);
  if (finding.surface === "repo-doc") buckets.repoDocs.add(finding.path);
};

const sanitizeJsonlContent = (content: string, surface: SecuritySurface): SanitizedTextResult => {
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const sanitizedLines: string[] = [];
  const results: SanitizedValueResult<unknown>[] = [];
  lines.forEach((line, index) => {
    try {
      const parsed = JSON.parse(line) as unknown;
      const sanitized = sanitizeStructuredValue(parsed, surface, `line[${index}]`);
      sanitizedLines.push(JSON.stringify(sanitized.value));
      results.push(sanitized);
    } catch {
      const sanitized = sanitizeKnowledgeText(line, surface, `line[${index}]`);
      sanitizedLines.push(sanitized.text);
      results.push({
        value: sanitized.text,
        summary: sanitized.summary,
        previewBySource: sanitized.previewBySource,
      });
    }
  });
  return {
    text: `${sanitizedLines.join("\n")}${sanitizedLines.length > 0 ? "\n" : ""}`,
    summary: mergeRedactionSummaries(...results.map((entry) => entry.summary)),
    previewBySource: mergePreviewMaps(...results.map((entry) => entry.previewBySource)),
  };
};

const sanitizeJsonContent = (content: string, surface: SecuritySurface): SanitizedTextResult => {
  const parsed = JSON.parse(content) as unknown;
  const sanitized = sanitizeStructuredValue(parsed, surface);
  return {
    text: `${JSON.stringify(sanitized.value, null, 2)}\n`,
    summary: sanitized.summary,
    previewBySource: sanitized.previewBySource,
  };
};

const sanitizeFileContent = async (file: string, surface: SecuritySurface): Promise<SanitizedTextResult | null> => {
  try {
    const content = await readFile(file, "utf8");
    if (file.endsWith(".jsonl")) return sanitizeJsonlContent(content, surface);
    if (file.endsWith(".json")) return sanitizeJsonContent(content, surface);
    return sanitizeKnowledgeText(content, surface, "content");
  } catch {
    return null;
  }
};

const auditControlPlane = async (
  cwd: string,
  findings: SecurityAuditFinding[],
  buckets: AuditBuckets,
): Promise<void> => {
  const files = await controlPlaneFiles(cwd);
  for (const file of files) {
    const sanitized = await sanitizeFileContent(file, "audit");
    if (!sanitized?.summary.applied) continue;
    addFinding(findings, buckets, {
      findingId: `finding_${sha1("control-plane", file).slice(0, 12)}`,
      severity: "warn",
      surface: "control-plane",
      path: toRepoPath(cwd, file),
      field: sanitized.summary.sources[0] ?? null,
      reason: "raw-looking sensitive content is still present in control-plane state",
      suggestedAction: "ragit security purge --target control-plane",
    });
  }
};

const auditStore = async (
  cwd: string,
  findings: SecurityAuditFinding[],
  buckets: AuditBuckets,
): Promise<void> => {
  const latest = await latestSnapshotSha(cwd);
  const meta = await readCanonicalStoreMeta(cwd);
  if (!latest || !meta) return;
  const manifest = await loadSnapshotManifest(cwd, latest);
  const chunkIds = manifest.chunks.map((chunk) => chunk.id);
  if (chunkIds.length === 0) return;
  const store = await bootstrapCanonicalStore(cwd, meta.embeddingContract, true);
  try {
    const fetched = store.chunks.fetchSync(chunkIds);
    const flaggedByPath = new Set<string>();
    for (const entry of Object.values(fetched)) {
      const text = typeof entry.fields.text === "string" ? entry.fields.text : "";
      const repoPath = typeof entry.fields.path === "string" ? entry.fields.path : "unknown";
      const summary = sanitizeKnowledgeText(text, "audit", repoPath).summary;
      if (summary.applied) flaggedByPath.add(repoPath);
    }
    for (const repoPath of Array.from(flaggedByPath).sort()) {
      addFinding(findings, buckets, {
        findingId: `finding_${sha1("store", repoPath).slice(0, 12)}`,
        severity: "critical",
        surface: "store",
        path: repoPath,
        field: "chunk.text",
        reason: "searchable store still contains raw-looking sensitive content",
        suggestedAction: "ragit security purge --target store",
      });
    }
  } finally {
    closeCanonicalStore(store);
  }
};

const auditRepoDocs = async (
  cwd: string,
  config: RagitConfig,
  findings: SecurityAuditFinding[],
  buckets: AuditBuckets,
): Promise<void> => {
  const files = await repoDocumentFiles(cwd, config);
  for (const file of files) {
    const content = await readFile(file, "utf8");
    const repoPath = toRepoPath(cwd, file);
    const admission = evaluateRepoDocCandidate(repoPath, "implicit", content);
    if (admission.action === "allow") continue;
    addFinding(findings, buckets, {
      findingId: `finding_${sha1("repo-doc", file, admission.action).slice(0, 12)}`,
      severity: admission.action === "block" ? "critical" : "warn",
      surface: "repo-doc",
      path: repoPath,
      field: "content",
      reason:
        admission.action === "block"
          ? "repo-tracked document would be blocked by admission control"
          : "repo-tracked document contains secret-like content",
      suggestedAction: "remove or mask the secret in the document, then run ragit ingest",
    });
  }
};

const buildAuditSummary = (
  findings: SecurityAuditFinding[],
  buckets: AuditBuckets,
  quarantineEntries: number,
  admission: AdmissionStats,
): SecurityAuditResult["summary"] => ({
  critical: findings.filter((finding) => finding.severity === "critical").length,
  warn: findings.filter((finding) => finding.severity === "warn").length,
  info: findings.filter((finding) => finding.severity === "info").length,
  quarantineEntries,
  admissionBlocked: admission.blocked,
  admissionQuarantined: admission.quarantined,
  legacyControlPlaneFiles: buckets.controlPlane.size,
  legacyStoreFindings: buckets.store.size,
  repoDocsFlagged: buckets.repoDocs.size,
});

export const runSecurityAudit = async (cwd: string): Promise<SecurityAuditResult> => {
  await ensureRagitStructure(cwd);
  const config = await loadConfig(cwd);
  const embeddingProfile = resolveEmbeddingProfile(config);
  const egressClass = classifyEmbeddingEgress(embeddingProfile);
  const buckets: AuditBuckets = {
    controlPlane: new Set<string>(),
    store: new Set<string>(),
    repoDocs: new Set<string>(),
  };
  const findings: SecurityAuditFinding[] = [];

  await auditControlPlane(cwd, findings, buckets);
  await auditStore(cwd, findings, buckets);
  await auditRepoDocs(cwd, config, findings, buckets);

  if (egressClass === "remote" && config.security.remote_embedding_policy === "local-only") {
    addFinding(findings, buckets, {
      findingId: `finding_${sha1("remote-egress", embeddingProfile.provider, embeddingProfile.baseUrl ?? "none").slice(0, 12)}`,
      severity: "critical",
      surface: "audit",
      path: ".ragit/config.toml",
      field: "security.remote_embedding_policy",
      reason: "remote embedding provider is configured while policy requires local-only",
      suggestedAction: "switch to a local embedding provider or relax the remote embedding policy",
    });
  }

  const [quarantineEntries, admission] = await Promise.all([countQuarantineEntries(cwd), readAdmissionStats(cwd)]);
  const summary = buildAuditSummary(findings, buckets, quarantineEntries, admission);
  const result: SecurityAuditResult = {
    summary,
    providerEgress: {
      provider: embeddingProfile.provider,
      class: egressClass,
      policy: config.security.remote_embedding_policy,
      artifactRemoteEmbeddingAllowed: canUseRemoteEmbedding(config, embeddingProfile, "artifact"),
    },
    findings,
  };

  await writeSecurityState(cwd, {
    lastAuditAt: new Date().toISOString(),
    legacyUnsafeState: summary.critical > 0 || summary.warn > 0,
  });
  return result;
};

const sanitizeAndRewriteFile = async (file: string, surface: SecuritySurface, dryRun: boolean): Promise<boolean> => {
  const current = await readFile(file, "utf8");
  const sanitized = file.endsWith(".jsonl")
    ? sanitizeJsonlContent(current, surface)
    : file.endsWith(".json")
      ? sanitizeJsonContent(current, surface)
      : sanitizeKnowledgeText(current, surface, "content");
  if (sanitized.text === current) return false;
  if (!dryRun) {
    await writeFile(file, sanitized.text, "utf8");
  }
  return true;
};

const purgeControlPlane = async (
  cwd: string,
  dryRun: boolean,
  result: SecurityPurgeResult,
): Promise<void> => {
  const files = await controlPlaneFiles(cwd);
  result.planned.push(...files.map((file) => toRepoPath(cwd, file)));
  for (const file of files) {
    const changed = await sanitizeAndRewriteFile(file, "purge", dryRun);
    if (changed) result.rewritten.push(toRepoPath(cwd, file));
  }
};

const purgeStore = async (cwd: string, dryRun: boolean, result: SecurityPurgeResult): Promise<void> => {
  const paths = resolveRagitPaths(cwd);
  const manifestFiles = (await readdir(paths.manifestDir)).filter((name) => name.endsWith(".json")).map((name) => path.join(paths.manifestDir, name));
  const targets = [
    paths.storeDir,
    path.join(paths.ragitDir, "store.next"),
    path.join(paths.ragitDir, "store.prev"),
    ...manifestFiles,
  ];
  result.planned.push(...targets.map((target) => toRepoPath(cwd, target)));
  if (dryRun) return;
  for (const target of targets) {
    await rm(target, { recursive: true, force: true });
    result.deleted.push(toRepoPath(cwd, target));
  }
};

const purgeCache = async (cwd: string, dryRun: boolean, result: SecurityPurgeResult): Promise<void> => {
  const config = await loadConfig(cwd);
  const target = path.resolve(cwd, config.embedding.cache_dir ?? ".ragit/cache/embeddings");
  result.planned.push(toRepoPath(cwd, target));
  if (dryRun) return;
  await rm(target, { recursive: true, force: true });
  result.deleted.push(toRepoPath(cwd, target));
};

const purgeQuarantine = async (cwd: string, dryRun: boolean, result: SecurityPurgeResult): Promise<void> => {
  const paths = resolveRagitPaths(cwd);
  result.planned.push(toRepoPath(cwd, paths.quarantineDir));
  if (dryRun) return;
  await rm(paths.quarantineDir, { recursive: true, force: true });
  await mkdir(paths.quarantineDir, { recursive: true });
  result.deleted.push(toRepoPath(cwd, paths.quarantineDir));
};

export const runSecurityPurge = async (
  cwd: string,
  target: SecurityPurgeTarget,
  dryRun = false,
): Promise<SecurityPurgeResult> => {
  await ensureRagitStructure(cwd);
  const result: SecurityPurgeResult = {
    mode: dryRun ? "dry-run" : "apply",
    target,
    planned: [],
    rewritten: [],
    deleted: [],
    warnings: [],
  };
  if (target === "control-plane" || target === "all") {
    await purgeControlPlane(cwd, dryRun, result);
  }
  if (target === "store" || target === "all") {
    await purgeStore(cwd, dryRun, result);
  }
  if (target === "cache" || target === "all") {
    await purgeCache(cwd, dryRun, result);
  }
  if (target === "quarantine" || target === "all") {
    await purgeQuarantine(cwd, dryRun, result);
  }
  if (!dryRun && (target === "control-plane" || target === "all")) {
    const state = await readSecurityState(cwd);
    if (state) {
      await writeSecurityState(cwd, {
        ...state,
        legacyUnsafeState: false,
      });
    }
  }
  return result;
};
