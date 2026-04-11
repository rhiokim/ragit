import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { CliView } from "./cliContract.js";
import { loadConfig } from "./config.js";
import { toRepoPath } from "./identity.js";
import { ensureRagitStructure, resolveRagitPaths } from "./project.js";
import {
  ArtifactEventProvenance,
  RagitEventMetadata,
  RagitEventRecord,
  RagitEventType,
  RedactionSummary,
  TimelineKind,
} from "./types.js";
import {
  assertKnowledgeWriteSecurity,
  attachRedactionSummary,
  mergeRedactionSummaries,
  persistQuarantineSummary,
  sanitizeStructuredValue,
} from "./security.js";

export interface AppendLedgerEventInput {
  eventType: RagitEventType;
  recordedAt?: string;
  goalId?: string | null;
  episodeId?: string | null;
  sessionId?: string | null;
  sourceHeadSha?: string | null;
  summary: string;
  artifactIds?: string[];
  relatedPaths?: string[];
  openLoops?: string[];
  nextActions?: string[];
  metadata?: RagitEventMetadata;
  provenance: ArtifactEventProvenance;
}

export interface TimelineQueryOptions {
  goalId?: string;
  episodeId?: string;
  sessionId?: string;
  kind?: TimelineKind;
  since?: string;
  until?: string;
  maxCount?: number;
}

export interface TimelineSummary {
  eventCount: number;
  byType: Partial<Record<RagitEventType, number>>;
  firstRecordedAt: string | null;
  lastRecordedAt: string | null;
  latestGoalId: string | null;
  latestEpisodeId: string | null;
  latestSessionId: string | null;
}

export interface TimelineResult {
  filters: {
    goalId: string | null;
    episodeId: string | null;
    sessionId: string | null;
    kind: TimelineKind | null;
    since: string | null;
    until: string | null;
    maxCount: number | null;
  };
  summary: TimelineSummary;
  events: RagitEventRecord[];
  redactionSummary: RedactionSummary;
}

export interface EventLedgerStats {
  eventCount: number;
  lastRecordedAt: string | null;
  latestEpisodeId: string | null;
  latestGoalId: string | null;
  latestSessionId: string | null;
}

const normalizeWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim();
const sha1 = (...parts: string[]): string => createHash("sha1").update(parts.join(":")).digest("hex");
const uniqueStrings = (items: string[] = []): string[] => Array.from(new Set(items.map((item) => item.trim()).filter(Boolean)));
const toDayKey = (iso: string): string => iso.slice(0, 10);
const toTimeKey = (iso: string): string => iso.slice(11, 19);

const isEventType = (value: string): value is RagitEventType =>
  value === "session.materialize" ||
  value === "artifact.review" ||
  value === "memory.wrap" ||
  value === "memory.promote" ||
  value === "harness.capture" ||
  value === "harness.run" ||
  value === "harness.promote" ||
  value === "security.admission" ||
  value === "ingest.completed";

const normalizeMetadata = (value: unknown): RagitEventMetadata | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>));
};

export const timelineKindFromEventType = (eventType: RagitEventType): TimelineKind => {
  const [root] = eventType.split(".");
  if (root === "session" || root === "artifact" || root === "memory" || root === "harness" || root === "ingest" || root === "security") {
    return root;
  }
  return "session";
};

export const eventLedgerFilePath = (cwd: string, recordedAt: string): string =>
  path.join(resolveRagitPaths(cwd).eventDir, `${toDayKey(recordedAt)}.jsonl`);

export const eventLedgerRepoPath = (cwd: string, recordedAt: string): string => toRepoPath(cwd, eventLedgerFilePath(cwd, recordedAt));

const normalizeProvenance = (value: unknown): ArtifactEventProvenance | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    (raw.actor === "user" || raw.actor === "assistant" || raw.actor === "system") &&
    typeof raw.producer === "string" &&
    typeof raw.producerVersion === "string" &&
    typeof raw.operation === "string" &&
    Array.isArray(raw.inputRefs) &&
    Array.isArray(raw.outputRefs) &&
    Array.isArray(raw.evidenceRefs) &&
    typeof raw.contentHash === "string"
  ) {
    return {
      actor: raw.actor,
      producer: raw.producer,
      producerVersion: raw.producerVersion,
      operation: raw.operation,
      inputRefs: uniqueStrings(raw.inputRefs.filter((item): item is string => typeof item === "string")),
      outputRefs: uniqueStrings(raw.outputRefs.filter((item): item is string => typeof item === "string")),
      evidenceRefs: uniqueStrings(raw.evidenceRefs.filter((item): item is string => typeof item === "string")),
      contentHash: raw.contentHash,
    };
  }
  return null;
};

const fallbackProvenance = (value: Record<string, unknown>): ArtifactEventProvenance | null => {
  const actor = value.actor;
  if (actor !== "user" && actor !== "assistant" && actor !== "system") return null;
  if (
    typeof value.producer !== "string" ||
    typeof value.producerVersion !== "string" ||
    typeof value.operation !== "string" ||
    typeof value.contentHash !== "string"
  ) {
    return null;
  }
  return {
    actor,
    producer: value.producer,
    producerVersion: value.producerVersion,
    operation: value.operation,
    inputRefs: uniqueStrings(Array.isArray(value.inputRefs) ? value.inputRefs.filter((item): item is string => typeof item === "string") : []),
    outputRefs: uniqueStrings(Array.isArray(value.outputRefs) ? value.outputRefs.filter((item): item is string => typeof item === "string") : []),
    evidenceRefs: uniqueStrings(Array.isArray(value.evidenceRefs) ? value.evidenceRefs.filter((item): item is string => typeof item === "string") : []),
    contentHash: value.contentHash,
  };
};

const normalizeEventRecord = (value: unknown): RagitEventRecord | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const eventType = typeof raw.eventType === "string" ? raw.eventType : "";
  if (!isEventType(eventType)) return null;
  const recordedAt = typeof raw.recordedAt === "string" ? raw.recordedAt : "";
  const eventId = typeof raw.eventId === "string" ? raw.eventId : "";
  const summary = typeof raw.summary === "string" ? raw.summary : "";
  const provenance = normalizeProvenance(raw.provenance) ?? fallbackProvenance(raw);
  if (!recordedAt || !eventId || !summary || !provenance) return null;
  const rawArtifactIds = Array.isArray(raw.artifactIds)
    ? raw.artifactIds.filter((item): item is string => typeof item === "string")
    : [];
  return {
    version: 1,
    eventId,
    eventType,
    recordedAt,
    goalId: typeof raw.goalId === "string" ? raw.goalId : null,
    episodeId: typeof raw.episodeId === "string" ? raw.episodeId : null,
    sessionId:
      typeof raw.sessionId === "string"
        ? raw.sessionId
        : typeof raw.sourceSessionId === "string"
          ? raw.sourceSessionId
          : null,
    sourceHeadSha: typeof raw.sourceHeadSha === "string" ? raw.sourceHeadSha : null,
    summary,
    artifactIds: uniqueStrings(rawArtifactIds),
    relatedPaths: uniqueStrings(Array.isArray(raw.relatedPaths) ? raw.relatedPaths.filter((item): item is string => typeof item === "string") : []),
    openLoops: uniqueStrings(Array.isArray(raw.openLoops) ? raw.openLoops.filter((item): item is string => typeof item === "string") : []),
    nextActions: uniqueStrings(Array.isArray(raw.nextActions) ? raw.nextActions.filter((item): item is string => typeof item === "string") : []),
    metadata: normalizeMetadata(raw.metadata),
    provenance,
  };
};

const createEventId = (payload: Omit<RagitEventRecord, "eventId" | "version">): string =>
  `evt_${sha1(
    payload.eventType,
    payload.goalId ?? "none",
    payload.episodeId ?? "none",
    payload.sessionId ?? "none",
    payload.sourceHeadSha ?? "none",
    normalizeWhitespace(payload.summary),
    payload.artifactIds.join(","),
    payload.relatedPaths.join(","),
    payload.openLoops.join(","),
    payload.nextActions.join(","),
    JSON.stringify(payload.metadata ?? null),
    payload.provenance.contentHash,
  ).slice(0, 16)}`;

const hasEventId = async (target: string, eventId: string): Promise<boolean> => {
  try {
    const content = await readFile(target, "utf8");
    return content.split(/\r?\n/).some((line) => line.includes(`"eventId":"${eventId}"`) || line.includes(`"eventId": "${eventId}"`));
  } catch {
    return false;
  }
};

export const appendLedgerEvent = async (
  cwd: string,
  input: AppendLedgerEventInput,
  dryRun = false,
): Promise<{ event: RagitEventRecord; path: string; appended: boolean }> => {
  await ensureRagitStructure(cwd);
  const config = await loadConfig(cwd);
  assertKnowledgeWriteSecurity(config, input.eventType, dryRun);
  const recordedAt = input.recordedAt ?? new Date().toISOString();
  const eventBase: Omit<RagitEventRecord, "eventId" | "version"> = {
    eventType: input.eventType,
    recordedAt,
    goalId: input.goalId ?? null,
    episodeId: input.episodeId ?? null,
    sessionId: input.sessionId ?? null,
    sourceHeadSha: input.sourceHeadSha ?? null,
    summary: normalizeWhitespace(input.summary),
    artifactIds: uniqueStrings(input.artifactIds),
    relatedPaths: uniqueStrings(input.relatedPaths),
    openLoops: uniqueStrings(input.openLoops),
    nextActions: uniqueStrings(input.nextActions),
    metadata: normalizeMetadata(input.metadata),
    provenance: {
      ...input.provenance,
      inputRefs: uniqueStrings(input.provenance.inputRefs),
      outputRefs: uniqueStrings(input.provenance.outputRefs),
      evidenceRefs: uniqueStrings(input.provenance.evidenceRefs),
    },
  };
  const sanitizedBase = sanitizeStructuredValue(eventBase, "event.ledger");
  const event: RagitEventRecord = {
    version: 1,
    eventId: createEventId(sanitizedBase.value),
    ...sanitizedBase.value,
  };
  const target = eventLedgerFilePath(cwd, recordedAt);
  let appended = false;
  if (!dryRun) {
    await mkdir(path.dirname(target), { recursive: true });
    if (!(await hasEventId(target, event.eventId))) {
      await appendFile(target, `${JSON.stringify(event)}\n`, "utf8");
      appended = true;
    }
    await persistQuarantineSummary(cwd, config, {
      surface: "event.ledger",
      sourceRef: toRepoPath(cwd, target),
      summary: sanitizedBase.summary,
      previewBySource: sanitizedBase.previewBySource,
      operation: input.eventType,
      recordedAt,
    });
  }
  return { event, path: toRepoPath(cwd, target), appended };
};

export const readLedgerEvents = async (cwd: string): Promise<RagitEventRecord[]> => {
  await ensureRagitStructure(cwd);
  const paths = resolveRagitPaths(cwd);
  const files = (await readdir(paths.eventDir)).filter((name) => name.endsWith(".jsonl")).sort();
  const events: RagitEventRecord[] = [];
  for (const file of files) {
    const content = await readFile(path.join(paths.eventDir, file), "utf8");
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed = normalizeEventRecord(JSON.parse(line));
        if (parsed) events.push(parsed);
      } catch {
        continue;
      }
    }
  }
  return events.sort((left, right) => left.recordedAt.localeCompare(right.recordedAt) || left.eventId.localeCompare(right.eventId));
};

export const queryTimeline = async (cwd: string, options: TimelineQueryOptions = {}): Promise<TimelineResult> => {
  const allEvents = await readLedgerEvents(cwd);
  const filtered = allEvents
    .filter((event) => (options.goalId ? event.goalId === options.goalId : true))
    .filter((event) => (options.episodeId ? event.episodeId === options.episodeId : true))
    .filter((event) => (options.sessionId ? event.sessionId === options.sessionId : true))
    .filter((event) => (options.kind ? timelineKindFromEventType(event.eventType) === options.kind : true))
    .filter((event) => (options.since ? event.recordedAt >= options.since : true))
    .filter((event) => (options.until ? event.recordedAt <= options.until : true))
    .sort((left, right) => right.recordedAt.localeCompare(left.recordedAt) || right.eventId.localeCompare(left.eventId));
  const events = options.maxCount ? filtered.slice(0, options.maxCount) : filtered;
  const byType: Partial<Record<RagitEventType, number>> = {};
  for (const event of events) {
    byType[event.eventType] = (byType[event.eventType] ?? 0) + 1;
  }
  const summary: TimelineSummary = {
    eventCount: events.length,
    byType,
    firstRecordedAt: events.length > 0 ? events[events.length - 1].recordedAt : null,
    lastRecordedAt: events.length > 0 ? events[0].recordedAt : null,
    latestGoalId: events.find((event) => event.goalId)?.goalId ?? null,
    latestEpisodeId: events.find((event) => event.episodeId)?.episodeId ?? null,
    latestSessionId: events.find((event) => event.sessionId)?.sessionId ?? null,
  };
  const rawResult = {
    filters: {
      goalId: options.goalId ?? null,
      episodeId: options.episodeId ?? null,
      sessionId: options.sessionId ?? null,
      kind: options.kind ?? null,
      since: options.since ?? null,
      until: options.until ?? null,
      maxCount: options.maxCount ?? null,
    },
    summary,
    events,
  };
  const sanitized = sanitizeStructuredValue(rawResult, "timeline.output");
  return attachRedactionSummary(sanitized.value, sanitized.summary);
};

export const readEventLedgerStats = async (cwd: string): Promise<EventLedgerStats> => {
  const events = await readLedgerEvents(cwd);
  const latest = events[events.length - 1] ?? null;
  const latestWithGoal = [...events].reverse().find((event) => event.goalId) ?? null;
  const latestWithEpisode = [...events].reverse().find((event) => event.episodeId) ?? null;
  const latestWithSession = [...events].reverse().find((event) => event.sessionId) ?? null;
  return {
    eventCount: events.length,
    lastRecordedAt: latest?.recordedAt ?? null,
    latestEpisodeId: latestWithEpisode?.episodeId ?? null,
    latestGoalId: latestWithGoal?.goalId ?? null,
    latestSessionId: latestWithSession?.sessionId ?? null,
  };
};

const renderStringList = (title: string, items: string[], indent = "  "): string[] => {
  if (items.length === 0) return [];
  return [title, ...items.map((item) => `${indent}- ${item}`)];
};

export const formatTimelineText = (result: TimelineResult, view: CliView = "default"): string => {
  const lines = [
    "# ragit timeline",
    `- events: ${result.summary.eventCount}`,
    `- kind_filter: ${result.filters.kind ?? "none"}`,
    `- goal_filter: ${result.filters.goalId ?? "none"}`,
    `- episode_filter: ${result.filters.episodeId ?? "none"}`,
    `- session_filter: ${result.filters.sessionId ?? "none"}`,
    `- since: ${result.filters.since ?? "none"}`,
    `- until: ${result.filters.until ?? "none"}`,
    `- max_count: ${result.filters.maxCount ?? "none"}`,
    `- view: ${view}`,
    `- redaction_applied: ${result.redactionSummary.applied}`,
    `- masked_count: ${result.redactionSummary.maskedCount}`,
    "",
  ];
  if (result.events.length === 0) {
    lines.push("- no events");
    return lines.join("\n");
  }
  let currentDay: string | null = null;
  for (const event of result.events) {
    const day = toDayKey(event.recordedAt);
    if (day !== currentDay) {
      currentDay = day;
      lines.push(day);
    }
    const base = `${toTimeKey(event.recordedAt)} ${event.eventType}`;
    if (view === "minimal") {
      lines.push(`  - ${base} | ${event.summary}`);
      continue;
    }
    lines.push(`  - ${base}`);
    lines.push(`    summary: ${event.summary}`);
    lines.push(`    goal: ${event.goalId ?? "none"}`);
    lines.push(`    episode: ${event.episodeId ?? "none"}`);
    lines.push(`    session: ${event.sessionId ?? "none"}`);
    if (view === "full") {
      lines.push(`    head: ${event.sourceHeadSha ?? "none"}`);
      lines.push(`    provenance: ${event.provenance.operation} by ${event.provenance.producer}@${event.provenance.producerVersion}`);
    }
    if (event.eventType === "harness.run" && event.metadata) {
      const runId = typeof event.metadata.runId === "string" ? event.metadata.runId : null;
      const suiteId = typeof event.metadata.suiteId === "string" ? event.metadata.suiteId : null;
      const executor = typeof event.metadata.executorKind === "string" ? event.metadata.executorKind : null;
      const counts = event.metadata.counts;
      if (runId) lines.push(`    run_id: ${runId}`);
      if (suiteId) lines.push(`    suite_id: ${suiteId}`);
      if (executor) lines.push(`    executor: ${executor}`);
      if (counts && typeof counts === "object" && !Array.isArray(counts)) {
        const record = counts as Record<string, unknown>;
        lines.push(
          `    counts: total=${record.total ?? 0}, passed=${record.passed ?? 0}, failed=${record.failed ?? 0}, errored=${record.errored ?? 0}, skipped=${record.skipped ?? 0}`,
        );
      }
    }
    lines.push(...renderStringList("    artifacts:", event.artifactIds));
    lines.push(...renderStringList("    related_paths:", event.relatedPaths));
    lines.push(...renderStringList("    open_loops:", event.openLoops));
    lines.push(...renderStringList("    next_actions:", event.nextActions));
  }
  return lines.join("\n");
};
