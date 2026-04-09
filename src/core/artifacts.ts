import { createHash } from "node:crypto";
import { access, appendFile, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { assertAllowedKeys, assertRepoRelativePathArray } from "./cliInput.js";
import { chunkSections, parseSections } from "./chunk.js";
import { loadConfig } from "./config.js";
import { cosineSimilarity, embedText, embedTexts, resolveEmbeddingProfile } from "./embedding.js";
import { getHeadSha, tryGetGitRoot } from "./git.js";
import { chunkVersionId, toRepoPath } from "./identity.js";
import { maskSecrets } from "./mask.js";
import { ensureRagitStructure, resolveRagitPaths } from "./project.js";
import {
  ArtifactBindingStatus,
  ArtifactEventProvenance,
  ArtifactEvidenceRef,
  ArtifactKind,
  ArtifactManifestEntry,
  ArtifactRecord,
  ArtifactScope,
  ArtifactStatus,
  ArtifactTier,
  BaseArtifactRecord,
  ChunkRecord,
  EmbeddingProfile,
  HarnessArtifactKind,
  RetrievalHit,
  SearchPolicy,
  SessionArtifactKind,
} from "./types.js";
import { RAGIT_VERSION } from "./version.js";

export interface SessionTurn {
  turnId: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
}

export interface SessionToolTrace {
  traceId: string;
  title?: string;
  command?: string;
  output?: string;
  error?: string;
  createdAt: string;
}

export interface SessionMaterializeInput {
  goal: string;
  episode?: {
    id: string;
    title?: string;
  };
  turns: SessionTurn[];
  toolTraces?: SessionToolTrace[];
  relatedPaths?: string[];
  sourceHeadSha?: string | null;
  createdAt?: string;
}

export interface SessionMaterializeResult {
  sessionId: string;
  transcriptPath: string;
  eventPath: string;
  artifactIds: string[];
  dryRun: boolean;
  warnings: string[];
}

export interface ArtifactReviewInput {
  updates: Array<{
    artifactId: string;
    nextStatus: Exclude<ArtifactStatus, "captured" | "promoted">;
    reason?: string;
    supersedes?: string[];
  }>;
}

export interface ArtifactReviewResult {
  updated: string[];
  dryRun: boolean;
  warnings: string[];
}

const normalizeWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim();
const slugify = (value: string): string =>
  value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s-]/g, " ")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "artifact";

const sha1 = (...parts: string[]): string => createHash("sha1").update(parts.join(":")).digest("hex");
const compactText = (text: string, max = 200): string => {
  const normalized = normalizeWhitespace(text);
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max)}...`;
};
const toDayKey = (iso: string): string => iso.slice(0, 10);
const safeReadHeadSha = async (cwd: string): Promise<string | null> => {
  try {
    return await getHeadSha(cwd);
  } catch {
    return null;
  }
};
const asString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} 값은 비어 있지 않은 문자열이어야 합니다.`);
  }
  return value.trim();
};

const asOptionalString = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
};

const asStringArray = (value: unknown, label: string): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${label} 값은 string[] 이어야 합니다.`);
  }
  return value.map((entry, index) => asString(entry, `${label}[${index}]`));
};

const asSessionTurn = (value: unknown, label: string): SessionTurn => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 항목은 객체여야 합니다.`);
  }
  const raw = value as Record<string, unknown>;
  assertAllowedKeys(raw, ["turnId", "role", "content", "createdAt"], label);
  const role = asString(raw.role, `${label}.role`).toLowerCase();
  if (role !== "user" && role !== "assistant" && role !== "system") {
    throw new Error(`${label}.role 값은 user|assistant|system 이어야 합니다.`);
  }
  return {
    turnId: asString(raw.turnId, `${label}.turnId`),
    role,
    content: asString(raw.content, `${label}.content`),
    createdAt: asString(raw.createdAt, `${label}.createdAt`),
  };
};

const asToolTrace = (value: unknown, label: string): SessionToolTrace => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 항목은 객체여야 합니다.`);
  }
  const raw = value as Record<string, unknown>;
  assertAllowedKeys(raw, ["traceId", "title", "command", "output", "error", "createdAt"], label);
  return {
    traceId: asString(raw.traceId, `${label}.traceId`),
    title: asOptionalString(raw.title),
    command: asOptionalString(raw.command),
    output: asOptionalString(raw.output),
    error: asOptionalString(raw.error),
    createdAt: asString(raw.createdAt, `${label}.createdAt`),
  };
};

export const normalizeSessionMaterializeInput = (value: unknown): SessionMaterializeInput => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("session materialize 입력은 JSON 객체여야 합니다.");
  }
  const raw = value as Record<string, unknown>;
  assertAllowedKeys(raw, ["goal", "episode", "turns", "toolTraces", "relatedPaths", "sourceHeadSha", "createdAt"], "session materialize");
  const episodeRaw = raw.episode;
  let episode: SessionMaterializeInput["episode"];
  if (episodeRaw !== undefined) {
    if (!episodeRaw || typeof episodeRaw !== "object" || Array.isArray(episodeRaw)) {
      throw new Error("session materialize.episode 값은 객체여야 합니다.");
    }
    const record = episodeRaw as Record<string, unknown>;
    assertAllowedKeys(record, ["id", "title"], "session materialize.episode");
    episode = {
      id: asString(record.id, "session materialize.episode.id"),
      title: asOptionalString(record.title),
    };
  }
  return {
    goal: asString(raw.goal, "session materialize.goal"),
    episode,
    turns: Array.isArray(raw.turns) ? raw.turns.map((entry, index) => asSessionTurn(entry, `session materialize.turns[${index}]`)) : [],
    toolTraces: Array.isArray(raw.toolTraces)
      ? raw.toolTraces.map((entry, index) => asToolTrace(entry, `session materialize.toolTraces[${index}]`))
      : [],
    relatedPaths: raw.relatedPaths === undefined ? [] : assertRepoRelativePathArray(asStringArray(raw.relatedPaths, "session materialize.relatedPaths"), "session materialize.relatedPaths"),
    sourceHeadSha: raw.sourceHeadSha === null ? null : asOptionalString(raw.sourceHeadSha),
    createdAt: asOptionalString(raw.createdAt),
  };
};

export const normalizeArtifactReviewInput = (value: unknown): ArtifactReviewInput => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("artifact review 입력은 JSON 객체여야 합니다.");
  }
  const raw = value as Record<string, unknown>;
  assertAllowedKeys(raw, ["updates"], "artifact review");
  if (!Array.isArray(raw.updates)) {
    throw new Error("artifact review.updates 값은 배열이어야 합니다.");
  }
  return {
    updates: raw.updates.map((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`artifact review.updates[${index}] 값은 객체여야 합니다.`);
      }
      const record = entry as Record<string, unknown>;
      assertAllowedKeys(record, ["artifactId", "nextStatus", "reason", "supersedes"], `artifact review.updates[${index}]`);
      const nextStatus = asString(record.nextStatus, `artifact review.updates[${index}].nextStatus`) as ArtifactReviewInput["updates"][number]["nextStatus"];
      if (!["reviewed", "retracted", "superseded", "archived"].includes(nextStatus)) {
        throw new Error(`artifact review.updates[${index}].nextStatus 값이 올바르지 않습니다: ${nextStatus}`);
      }
      return {
        artifactId: asString(record.artifactId, `artifact review.updates[${index}].artifactId`),
        nextStatus,
        reason: asOptionalString(record.reason),
        supersedes: record.supersedes === undefined ? [] : asStringArray(record.supersedes, `artifact review.updates[${index}].supersedes`),
      };
    }),
  };
};

const createGoalId = (goal: string): string => `goal_${sha1(goal).slice(0, 12)}`;
const createSessionId = (createdAt: string, goal: string): string => `${createdAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}-${sha1(goal).slice(0, 8)}`;
const createEvidenceId = (seed: string): string => `evid_${sha1(seed).slice(0, 12)}`;
const createArtifactId = (scope: ArtifactScope, kind: ArtifactKind, goalId: string | null, title: string): string =>
  `art_${scope}_${kind}_${sha1(scope, kind, goalId ?? "none", normalizeWhitespace(title)).slice(0, 16)}`;

const sessionArtifactPath = (cwd: string, artifactId: string): string => path.join(resolveRagitPaths(cwd).sessionArtifactsDir, `${artifactId}.json`);
const harnessArtifactPath = (cwd: string, kind: HarnessArtifactKind, artifactId: string): string =>
  path.join(resolveRagitPaths(cwd).harnessArtifactsDir, kind, `${artifactId}.json`);
const eventLedgerPath = (cwd: string, recordedAt: string): string => path.join(resolveRagitPaths(cwd).eventDir, `${toDayKey(recordedAt)}.jsonl`);
const transcriptPath = (cwd: string, sessionId: string): string => path.join(resolveRagitPaths(cwd).transcriptDir, `${sessionId}.jsonl`);

const pathForArtifact = (cwd: string, artifact: ArtifactRecord): string =>
  artifact.artifactScope === "session" ? sessionArtifactPath(cwd, artifact.artifactId) : harnessArtifactPath(cwd, artifact.kind as HarnessArtifactKind, artifact.artifactId);

const fileExists = async (target: string): Promise<boolean> => {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

const writeJson = async (target: string, payload: unknown): Promise<void> => {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
};

const appendJsonLine = async (target: string, payload: unknown): Promise<void> => {
  await mkdir(path.dirname(target), { recursive: true });
  await appendFile(target, `${JSON.stringify(payload)}\n`, "utf8");
};

export const loadArtifactRecord = async (cwd: string, artifactId: string): Promise<ArtifactRecord | null> => {
  const paths = resolveRagitPaths(cwd);
  const sessionTarget = path.join(paths.sessionArtifactsDir, `${artifactId}.json`);
  try {
    const content = await readFile(sessionTarget, "utf8");
    return JSON.parse(content) as ArtifactRecord;
  } catch {}
  const kinds: HarnessArtifactKind[] = ["case", "oracle", "failure", "fixture", "golden", "checker", "rubric", "promptTemplate", "trace", "envAssumption", "suite"];
  for (const kind of kinds) {
    try {
      const content = await readFile(path.join(paths.harnessArtifactsDir, kind, `${artifactId}.json`), "utf8");
      return JSON.parse(content) as ArtifactRecord;
    } catch {}
  }
  return null;
};

const listJsonFiles = async (directory: string): Promise<string[]> => {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await listJsonFiles(target)));
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".json")) {
        files.push(target);
      }
    }
    return files;
  } catch {
    return [];
  }
};

export const listArtifactRecords = async (
  cwd: string,
  options: {
    scope?: ArtifactScope;
    statuses?: ArtifactStatus[];
  } = {},
): Promise<ArtifactRecord[]> => {
  const paths = resolveRagitPaths(cwd);
  const files = [
    ...(options.scope === undefined || options.scope === "session" ? await listJsonFiles(paths.sessionArtifactsDir) : []),
    ...(options.scope === undefined || options.scope === "harness" ? await listJsonFiles(paths.harnessArtifactsDir) : []),
  ];
  const records: ArtifactRecord[] = [];
  for (const file of files) {
    const content = await readFile(file, "utf8");
    const artifact = JSON.parse(content) as ArtifactRecord;
    if (options.statuses && !options.statuses.includes(artifact.status)) continue;
    records.push(artifact);
  }
  records.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  return records;
};

export const persistArtifactRecord = async (cwd: string, artifact: ArtifactRecord, dryRun = false): Promise<string> => {
  const target = pathForArtifact(cwd, artifact);
  if (!dryRun) {
    await writeJson(target, artifact);
  }
  return toRepoPath(cwd, target);
};

const buildEvidenceRef = (artifactId: string, text: string, turnIds: string[] = [], toolTraceIds: string[] = []): ArtifactEvidenceRef => ({
  evidenceId: createEvidenceId(`${artifactId}:${text}`),
  turnIds,
  toolTraceIds,
  excerpt: compactText(text, 240),
});

const createProvenance = (operation: string, inputRefs: string[], outputRefs: string[], evidenceRefs: string[]): ArtifactEventProvenance => ({
  actor: "assistant",
  producer: "ragit",
  producerVersion: RAGIT_VERSION,
  operation,
  inputRefs,
  outputRefs,
  evidenceRefs,
  contentHash: sha1(operation, ...inputRefs, ...outputRefs, ...evidenceRefs),
});

const feedbackRegex = /\b(prefer|too\s+(long|verbose|short)|please|wrong|bad|keep|format|concise|brief|use)\b/i;
const constraintRegex = /\b(must|must not|should not|do not|don't|avoid|keep)\b/i;
const failureRegex = /\b(error|fail|failed|failure|regression|bug|traceback|exception)\b/i;
const blockerRegex = /\b(blocker|blocked|unresolved|next action|next step|todo)\b/i;
const insightRegex = /\b(therefore|means|implies|so the rule is|key insight|stable rule)\b/i;

const artifactText = (title: string, summary: string, extras: string[] = []): string =>
  [`# ${title}`, "", summary, ...(extras.length > 0 ? ["", ...extras] : [])].join("\n");

const buildSessionArtifact = (params: {
  kind: SessionArtifactKind;
  title: string;
  summary: string;
  text: string;
  goalId: string;
  episodeId: string | null;
  sourceSessionId: string;
  sourceHeadSha: string | null;
  relatedPaths: string[];
  evidenceRefs: ArtifactEvidenceRef[];
  authority: BaseArtifactRecord["authority"];
  confidence: number;
  createdAt: string;
}): ArtifactRecord => {
  const artifactId = createArtifactId("session", params.kind, params.goalId, params.title);
  const bound = params.sourceHeadSha;
  const searchPolicy: SearchPolicy = params.kind === "failure" ? "evidence" : "session";
  return {
    artifactId,
    artifactScope: "session",
    kind: params.kind,
    tier: "candidate",
    status: "captured",
    title: params.title,
    summary: params.summary,
    text: params.text,
    goalId: params.goalId,
    episodeId: params.episodeId,
    sourceSessionId: params.sourceSessionId,
    sourceHeadSha: params.sourceHeadSha,
    captureHeadSha: params.sourceHeadSha,
    boundHeadSha: bound,
    bindingStatus: bound ? "bound" : "pending",
    authority: params.authority,
    confidence: params.confidence,
    searchPolicy,
    relatedPaths: params.relatedPaths,
    tags: [params.kind],
    supersedes: [],
    evidenceRefs: params.evidenceRefs,
    provenance: createProvenance("session.materialize", [params.sourceSessionId], [artifactId], params.evidenceRefs.map((item) => item.evidenceId)),
    createdAt: params.createdAt,
    updatedAt: params.createdAt,
  };
};

const inferTitle = (prefix: string, content: string): string => {
  const normalized = compactText(content, 80);
  const cleaned = normalized.replace(/[.?!]+$/, "");
  return `${prefix}: ${cleaned}`;
};

const collectSessionArtifacts = (
  sessionId: string,
  goalId: string,
  episodeId: string | null,
  sourceHeadSha: string | null,
  relatedPaths: string[],
  createdAt: string,
  turns: SessionTurn[],
  traces: SessionToolTrace[],
): ArtifactRecord[] => {
  const records = new Map<string, ArtifactRecord>();
  for (const turn of turns) {
    const normalized = normalizeWhitespace(turn.content);
    if (!normalized) continue;
    const evidence = [buildEvidenceRef(`turn:${turn.turnId}`, normalized, [turn.turnId])];
    if (turn.role === "user" && feedbackRegex.test(normalized)) {
      const record = buildSessionArtifact({
        kind: "feedback",
        title: inferTitle("Feedback", normalized),
        summary: compactText(normalized, 140),
        text: artifactText(inferTitle("Feedback", normalized), compactText(normalized, 220)),
        goalId,
        episodeId,
        sourceSessionId: sessionId,
        sourceHeadSha,
        relatedPaths,
        evidenceRefs: evidence,
        authority: "user_asserted",
        confidence: 1,
        createdAt,
      });
      records.set(record.artifactId, record);
    }
    if (constraintRegex.test(normalized)) {
      const record = buildSessionArtifact({
        kind: "constraint",
        title: inferTitle("Constraint", normalized),
        summary: compactText(normalized, 140),
        text: artifactText(inferTitle("Constraint", normalized), compactText(normalized, 220)),
        goalId,
        episodeId,
        sourceSessionId: sessionId,
        sourceHeadSha,
        relatedPaths,
        evidenceRefs: evidence,
        authority: turn.role === "user" ? "user_asserted" : "assistant_inferred",
        confidence: turn.role === "user" ? 1 : 0.8,
        createdAt,
      });
      records.set(record.artifactId, record);
    }
    if (failureRegex.test(normalized)) {
      const record = buildSessionArtifact({
        kind: "failure",
        title: inferTitle("Failure", normalized),
        summary: compactText(normalized, 140),
        text: artifactText(inferTitle("Failure", normalized), compactText(normalized, 220)),
        goalId,
        episodeId,
        sourceSessionId: sessionId,
        sourceHeadSha,
        relatedPaths,
        evidenceRefs: evidence,
        authority: turn.role === "user" ? "user_asserted" : "assistant_inferred",
        confidence: turn.role === "user" ? 1 : 0.85,
        createdAt,
      });
      records.set(record.artifactId, record);
    }
    if (normalized.includes("?") || blockerRegex.test(normalized)) {
      const record = buildSessionArtifact({
        kind: "openLoop",
        title: inferTitle("Open Loop", normalized),
        summary: compactText(normalized, 140),
        text: artifactText(inferTitle("Open Loop", normalized), compactText(normalized, 220)),
        goalId,
        episodeId,
        sourceSessionId: sessionId,
        sourceHeadSha,
        relatedPaths,
        evidenceRefs: evidence,
        authority: turn.role === "user" ? "user_asserted" : "assistant_inferred",
        confidence: 0.85,
        createdAt,
      });
      records.set(record.artifactId, record);
    }
    if (insightRegex.test(normalized)) {
      const record = buildSessionArtifact({
        kind: "insight",
        title: inferTitle("Insight", normalized),
        summary: compactText(normalized, 140),
        text: artifactText(inferTitle("Insight", normalized), compactText(normalized, 220)),
        goalId,
        episodeId,
        sourceSessionId: sessionId,
        sourceHeadSha,
        relatedPaths,
        evidenceRefs: evidence,
        authority: turn.role === "user" ? "user_asserted" : "assistant_inferred",
        confidence: 0.82,
        createdAt,
      });
      records.set(record.artifactId, record);
    }
  }
  for (const trace of traces) {
    const source = normalizeWhitespace([trace.title, trace.command, trace.output, trace.error].filter(Boolean).join("\n"));
    if (!source || !failureRegex.test(source)) continue;
    const evidence = [buildEvidenceRef(`trace:${trace.traceId}`, source, [], [trace.traceId])];
    const record = buildSessionArtifact({
      kind: "failure",
      title: inferTitle("Failure", trace.title ?? source),
      summary: compactText(source, 140),
      text: artifactText(inferTitle("Failure", trace.title ?? source), compactText(source, 220)),
      goalId,
      episodeId,
      sourceSessionId: sessionId,
      sourceHeadSha,
      relatedPaths,
      evidenceRefs: evidence,
      authority: "assistant_inferred",
      confidence: 0.9,
      createdAt,
    });
    records.set(record.artifactId, record);
  }
  return Array.from(records.values());
};

export const sessionMaterialize = async (cwd: string, input: SessionMaterializeInput, dryRun = false): Promise<SessionMaterializeResult> => {
  await ensureRagitStructure(cwd);
  const config = await loadConfig(cwd);
  const currentHeadSha = input.sourceHeadSha ?? (await safeReadHeadSha(cwd));
  const createdAt = input.createdAt ?? new Date().toISOString();
  const sessionId = createSessionId(createdAt, input.goal);
  const goalId = createGoalId(input.goal);
  const episodeId = input.episode?.id ?? null;
  const transcriptFile = transcriptPath(cwd, sessionId);
  const eventFile = eventLedgerPath(cwd, createdAt);

  const redactedTurns = input.turns.map((turn) => ({
    ...turn,
    content: config.security.secret_masking ? maskSecrets(turn.content).text : turn.content,
  }));
  const redactedTraces = (input.toolTraces ?? []).map((trace) => ({
    ...trace,
    output: trace.output ? (config.security.secret_masking ? maskSecrets(trace.output).text : trace.output) : undefined,
    error: trace.error ? (config.security.secret_masking ? maskSecrets(trace.error).text : trace.error) : undefined,
  }));

  const artifacts = collectSessionArtifacts(
    sessionId,
    goalId,
    episodeId,
    currentHeadSha,
    input.relatedPaths ?? [],
    createdAt,
    redactedTurns,
    redactedTraces,
  );

  if (!dryRun) {
    for (const turn of redactedTurns) {
      await appendJsonLine(transcriptFile, turn);
    }
    for (const trace of redactedTraces) {
      await appendJsonLine(transcriptFile, { type: "toolTrace", ...trace });
    }
    const outputRefs: string[] = [];
    for (const artifact of artifacts) {
      outputRefs.push(await persistArtifactRecord(cwd, artifact, false));
    }
    await appendJsonLine(eventFile, {
      eventId: `evt_${sha1("session.materialize", sessionId, createdAt).slice(0, 16)}`,
      eventType: "session.materialize",
      recordedAt: createdAt,
      goalId,
      episodeId,
      sourceSessionId: sessionId,
      sourceHeadSha: currentHeadSha,
      summary: `Materialized ${artifacts.length} session artifacts`,
      openLoops: artifacts.filter((artifact) => artifact.kind === "openLoop").map((artifact) => artifact.artifactId),
      nextActions: [],
      actor: "assistant",
      producer: "ragit",
      producerVersion: RAGIT_VERSION,
      inputRefs: [toRepoPath(cwd, transcriptFile)],
      outputRefs,
      evidenceRefs: artifacts.flatMap((artifact) => artifact.evidenceRefs.map((item) => item.evidenceId)),
      operation: "session.materialize",
      contentHash: sha1(sessionId, createdAt, ...artifacts.map((artifact) => artifact.artifactId)),
    });
  }

  return {
    sessionId,
    transcriptPath: toRepoPath(cwd, transcriptFile),
    eventPath: toRepoPath(cwd, eventFile),
    artifactIds: artifacts.map((artifact) => artifact.artifactId),
    dryRun,
    warnings: artifacts.length === 0 ? ["추출 조건을 만족한 artifact가 없습니다."] : [],
  };
};

export const reviewArtifacts = async (cwd: string, input: ArtifactReviewInput, dryRun = false): Promise<ArtifactReviewResult> => {
  await ensureRagitStructure(cwd);
  const now = new Date().toISOString();
  const updated: string[] = [];
  const warnings: string[] = [];
  const canTransition = (current: ArtifactStatus, next: ArtifactStatus): boolean => {
    if (current === "captured") return next === "reviewed" || next === "retracted" || next === "archived";
    if (current === "reviewed") return next === "superseded" || next === "retracted" || next === "archived";
    if (current === "promoted") return next === "superseded" || next === "archived";
    return false;
  };
  for (const update of input.updates) {
    const artifact = await loadArtifactRecord(cwd, update.artifactId);
    if (!artifact) {
      warnings.push(`artifact를 찾을 수 없습니다: ${update.artifactId}`);
      continue;
    }
    if (!canTransition(artifact.status, update.nextStatus)) {
      warnings.push(`허용되지 않는 상태 전이입니다: ${artifact.artifactId} (${artifact.status} -> ${update.nextStatus})`);
      continue;
    }
    const next: ArtifactRecord = {
      ...artifact,
      status: update.nextStatus,
      supersedes: update.supersedes ?? artifact.supersedes,
      updatedAt: now,
      provenance: createProvenance(
        "artifact.review",
        [artifact.artifactId],
        [artifact.artifactId],
        artifact.evidenceRefs.map((item) => item.evidenceId),
      ),
    };
    if (!dryRun) {
      await persistArtifactRecord(cwd, next, false);
      await appendJsonLine(eventLedgerPath(cwd, now), {
        eventId: `evt_${sha1("artifact.review", next.artifactId, now).slice(0, 16)}`,
        eventType: "artifact.review",
        recordedAt: now,
        goalId: next.goalId,
        episodeId: next.episodeId,
        sourceSessionId: next.sourceSessionId,
        sourceHeadSha: next.sourceHeadSha,
        summary: update.reason ?? `Artifact ${next.artifactId} -> ${next.status}`,
        openLoops: [],
        nextActions: [],
        actor: "assistant",
        producer: "ragit",
        producerVersion: RAGIT_VERSION,
        inputRefs: [next.artifactId],
        outputRefs: [next.artifactId],
        evidenceRefs: next.evidenceRefs.map((item) => item.evidenceId),
        operation: "artifact.review",
        contentHash: sha1(next.artifactId, next.status, now),
      });
    }
    updated.push(next.artifactId);
  }
  return { updated, dryRun, warnings };
};

const repoRootMatches = async (cwd: string): Promise<boolean> => {
  const root = await tryGetGitRoot(cwd);
  if (!root) return true;
  try {
    const [resolvedRoot, resolvedCwd] = await Promise.all([realpath(root), realpath(cwd)]);
    return resolvedRoot === resolvedCwd;
  } catch {
    return path.resolve(root) === path.resolve(cwd);
  }
};

export const bindPendingArtifacts = async (cwd: string, headSha: string): Promise<string[]> => {
  await ensureRagitStructure(cwd);
  const currentRepoRootOk = await repoRootMatches(cwd);
  if (!currentRepoRootOk) return [];
  const artifacts = await listArtifactRecords(cwd, { statuses: ["captured", "reviewed"] });
  const boundIds: string[] = [];
  for (const artifact of artifacts) {
    if (artifact.bindingStatus !== "pending") continue;
    if (
      artifact.relatedPaths.some((entry) => {
        if (entry.startsWith("..") || path.isAbsolute(entry)) return true;
        return false;
      })
    ) {
      continue;
    }
    let relatedPathsReady = true;
    for (const relatedPath of artifact.relatedPaths) {
      if (!(await fileExists(path.resolve(cwd, relatedPath)))) {
        relatedPathsReady = false;
        break;
      }
    }
    if (!relatedPathsReady) continue;
    const next: ArtifactRecord = {
      ...artifact,
      boundHeadSha: headSha,
      bindingStatus: "bound",
      updatedAt: new Date().toISOString(),
    };
    await persistArtifactRecord(cwd, next, false);
    boundIds.push(next.artifactId);
  }
  return boundIds;
};

const artifactChunkRecord = (
  artifact: ArtifactRecord,
  pathValue: string,
  sectionTitle: string,
  text: string,
  headSha: string,
  embedding: number[],
  suffix: string,
): ChunkRecord => {
  const documentId = `artifact:${artifact.artifactId}`;
  const documentVersionId = `${documentId}:${artifact.updatedAt}`;
  const chunkId = chunkVersionId(documentVersionId, suffix, 0, text);
  return {
    id: chunkId,
    documentId,
    documentVersionId,
    sectionId: suffix,
    sectionTitle,
    path: pathValue,
    docType: "pbd",
    commitSha: headSha,
    text,
    tokenCount: text.split(/\s+/).filter(Boolean).length,
    embedding,
    originType: "artifact",
    artifactId: artifact.artifactId,
    artifactKind: artifact.kind,
    tier: artifact.tier,
    status: artifact.status,
    authority: artifact.authority,
    confidence: artifact.confidence,
    goalId: artifact.goalId,
    episodeId: artifact.episodeId,
    sourceSessionId: artifact.sourceSessionId,
    bindingStatus: artifact.bindingStatus,
    searchPolicy: artifact.searchPolicy,
  };
};

export const buildArtifactIndexData = async (
  cwd: string,
  headSha: string,
  scope: "durable" | "all",
  embeddingProfile: EmbeddingProfile,
): Promise<{
  artifactEntries: ArtifactManifestEntry[];
  chunks: ChunkRecord[];
  chunkScopes: {
    session: string[];
    harness: string[];
    evidence: string[];
  };
}> => {
  if (scope !== "all") {
    return {
      artifactEntries: [],
      chunks: [],
      chunkScopes: {
        session: [],
        harness: [],
        evidence: [],
      },
    };
  }
  const artifacts = await listArtifactRecords(cwd, { statuses: ["captured", "reviewed"] });
  const entries: ArtifactManifestEntry[] = [];
  const chunks: ChunkRecord[] = [];
  const chunkScopes = {
    session: [] as string[],
    harness: [] as string[],
    evidence: [] as string[],
  };
  const chunkPlans: Array<{
    artifact: ArtifactRecord;
    pathValue: string;
    sectionTitle: string;
    text: string;
    suffix: string;
    targetScope: "session" | "harness" | "evidence";
    chunkIds: string[];
  }> = [];
  for (const artifact of artifacts) {
    const repoPath = toRepoPath(cwd, pathForArtifact(cwd, artifact));
    const chunkIds: string[] = [];
    if (artifact.status === "reviewed" && artifact.bindingStatus !== "local_only") {
      if (artifact.artifactScope === "session") {
        chunkPlans.push({
          artifact,
          pathValue: repoPath,
          sectionTitle: artifact.title,
          text: artifact.text,
          suffix: "artifact",
          targetScope: "session",
          chunkIds,
        });
      }
      if (artifact.artifactScope === "harness") {
        chunkPlans.push({
          artifact,
          pathValue: repoPath,
          sectionTitle: artifact.title,
          text: artifact.text,
          suffix: "artifact",
          targetScope: "harness",
          chunkIds,
        });
      }
    }
    for (const evidence of artifact.evidenceRefs) {
      chunkPlans.push({
        artifact,
        pathValue: `${repoPath}#evidence`,
        sectionTitle: "Evidence",
        text: evidence.excerpt,
        suffix: evidence.evidenceId,
        targetScope: "evidence",
        chunkIds,
      });
    }
    entries.push({
      artifactId: artifact.artifactId,
      artifactScope: artifact.artifactScope,
      kind: artifact.kind,
      tier: artifact.tier,
      status: artifact.status,
      path: repoPath,
      chunkIds,
      searchPolicy: artifact.searchPolicy,
      sourceSessionId: artifact.sourceSessionId,
      sourceHeadSha: artifact.sourceHeadSha,
      goalId: artifact.goalId,
      episodeId: artifact.episodeId,
      bindingStatus: artifact.bindingStatus,
    });
  }
  const embeddings = await embedTexts(
    chunkPlans.map((plan) => plan.text),
    embeddingProfile,
  );
  for (const [index, plan] of chunkPlans.entries()) {
    const chunk = artifactChunkRecord(
      plan.artifact,
      plan.pathValue,
      plan.sectionTitle,
      plan.text,
      headSha,
      embeddings[index] ?? [],
      plan.suffix,
    );
    chunks.push(chunk);
    plan.chunkIds.push(chunk.id);
    chunkScopes[plan.targetScope].push(chunk.id);
  }
  return { artifactEntries: entries, chunks, chunkScopes };
};

const authorityWeight = (artifact: ArtifactRecord): number => {
  if (artifact.tier === "durable" || artifact.status === "promoted") return 1;
  if (artifact.artifactScope === "harness" && artifact.status === "reviewed") return 0.9;
  if (artifact.status === "reviewed") return 0.8;
  if (artifact.searchPolicy === "evidence") return 0.4;
  return 0.6;
};

const recencyWeight = (isoString: string): number => {
  const updatedAt = new Date(isoString).getTime();
  const days = Math.max(0, (Date.now() - updatedAt) / (1000 * 60 * 60 * 24));
  return Math.max(0.2, 1 - Math.min(days / 30, 0.8));
};

const scopeMatches = (artifact: ArtifactRecord, scope: "session" | "harness" | "evidence" | "all"): boolean => {
  if (scope === "all") return true;
  if (scope === "evidence") return artifact.evidenceRefs.length > 0;
  return artifact.artifactScope === scope;
};

export const searchArtifacts = async (
  cwd: string,
  query: string,
  scope: "session" | "harness" | "evidence" | "all",
  topK: number,
): Promise<RetrievalHit[]> => {
  await ensureRagitStructure(cwd);
  const config = await loadConfig(cwd);
  const embeddingProfile = resolveEmbeddingProfile(config);
  const artifacts = await listArtifactRecords(cwd, {
    statuses: scope === "evidence" ? ["captured", "reviewed"] : ["reviewed", "promoted"],
  });
  const queryEmbedding = await embedText(query, embeddingProfile);
  const candidatesToEmbed: Array<{
    artifact: ArtifactRecord;
    text: string;
    sectionTitle: string;
    path: string;
    scopeValue: "session" | "harness" | "evidence";
  }> = [];
  for (const artifact of artifacts) {
    if (!scopeMatches(artifact, scope)) continue;
    if (artifact.status === "superseded" || artifact.status === "retracted" || artifact.status === "archived") continue;
    const baseTexts =
      scope === "evidence"
        ? artifact.evidenceRefs.map((item) => ({
            text: item.excerpt,
            sectionTitle: "Evidence",
            path: `${pathForArtifact(cwd, artifact)}#${item.evidenceId}`,
            scopeValue: "evidence" as const,
          }))
        : [{
            text: artifact.text,
            sectionTitle: artifact.title,
            path: pathForArtifact(cwd, artifact),
            scopeValue: (scope === "all" ? (artifact.searchPolicy === "evidence" ? "evidence" : artifact.artifactScope) : scope) as "session" | "harness" | "evidence",
          }];
    for (const candidate of baseTexts) {
      candidatesToEmbed.push({
        artifact,
        text: candidate.text,
        sectionTitle: candidate.sectionTitle,
        path: candidate.path,
        scopeValue: candidate.scopeValue,
      });
    }
  }
  const candidateEmbeddings = await embedTexts(
    candidatesToEmbed.map((candidate) => candidate.text),
    embeddingProfile,
  );
  const candidates: RetrievalHit[] = [];
  for (const [index, candidate] of candidatesToEmbed.entries()) {
    const semantic = cosineSimilarity(queryEmbedding, candidateEmbeddings[index] ?? []);
    const keyword = candidate.text.toLowerCase().includes(query.toLowerCase()) ? 1 : 0;
    const semanticHybrid = config.retrieval.alpha * semantic + (1 - config.retrieval.alpha) * keyword;
    const scoreFinal = 0.8 * semanticHybrid + 0.15 * authorityWeight(candidate.artifact) + 0.05 * recencyWeight(candidate.artifact.updatedAt);
    candidates.push({
      chunkId: `${candidate.artifact.artifactId}:${sha1(candidate.path).slice(0, 8)}`,
      path: toRepoPath(cwd, candidate.path.replace(/#.*$/, "")),
      sectionTitle: candidate.sectionTitle,
      scoreVector: semantic,
      scoreKeyword: keyword,
      scoreFinal,
      text: candidate.text,
      scope: candidate.scopeValue,
      originType: "artifact",
      artifactId: candidate.artifact.artifactId,
      artifactKind: candidate.artifact.kind,
      authority: candidate.artifact.authority,
      confidence: candidate.artifact.confidence,
    });
  }
  return candidates.sort((left, right) => right.scoreFinal - left.scoreFinal).slice(0, topK);
};

export const loadRecallArtifacts = async (cwd: string, goal: string): Promise<ArtifactRecord[]> => {
  const goalId = createGoalId(goal);
  const artifacts = await listArtifactRecords(cwd);
  const reviewed = artifacts.filter(
    (artifact) =>
      artifact.goalId === goalId &&
      artifact.status === "reviewed" &&
      (artifact.artifactScope === "session" || artifact.artifactScope === "harness"),
  );
  const latestCapturedSessionId =
    artifacts
      .filter((artifact) => artifact.status === "captured" && ["feedback", "failure", "openLoop"].includes(artifact.kind))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]?.sourceSessionId ?? null;
  const latestCaptured =
    latestCapturedSessionId === null
      ? []
      : artifacts.filter(
          (artifact) =>
            artifact.status === "captured" &&
            artifact.sourceSessionId === latestCapturedSessionId &&
            ["feedback", "failure", "openLoop"].includes(artifact.kind),
        );
  return [...reviewed, ...latestCaptured];
};

export const countArtifactState = async (cwd: string): Promise<{
  sessionArtifactCount: number;
  harnessArtifactCount: number;
  pendingBindings: number;
}> => {
  const artifacts = await listArtifactRecords(cwd);
  return {
    sessionArtifactCount: artifacts.filter((artifact) => artifact.artifactScope === "session").length,
    harnessArtifactCount: artifacts.filter((artifact) => artifact.artifactScope === "harness").length,
    pendingBindings: artifacts.filter((artifact) => artifact.bindingStatus === "pending").length,
  };
};
