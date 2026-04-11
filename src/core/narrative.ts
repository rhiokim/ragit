import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { listArtifactRecords, loadArtifactRecord } from "./artifacts.js";
import { getHeadSha, GitCommitInfo, listGitCommits } from "./git.js";
import { loadSnapshotManifestIfExists } from "./manifest.js";
import { resolveRagitPaths } from "./project.js";
import { sanitizeStructuredValue } from "./security.js";
import {
  ArtifactRecord,
  ArtifactStatus,
  DocType,
  DocumentRecord,
  RagitEventRecord,
  RagitEventType,
  SnapshotManifest,
} from "./types.js";

const DECISION_DOC_TYPES = new Set<DocType>(["adr", "plan", "spec", "pbd"]);
const INTENT_KINDS = new Set<ArtifactRecord["kind"]>(["feedback", "constraint", "insight", "openLoop", "failure"]);
const TIMELINE_EVENT_TYPES = new Set<RagitEventType>([
  "session.materialize",
  "artifact.review",
  "memory.wrap",
  "memory.promote",
  "harness.capture",
  "harness.run",
  "harness.promote",
  "security.admission",
  "ingest.completed",
]);

export interface NarrativeOptions {
  revRange?: string;
  maxCommits?: number;
  output?: string;
  dryRun?: boolean;
}

export interface NarrativeWindowSummary {
  revRange: string | null;
  maxCommits: number;
  selectedSnapshotShas: string[];
  missingSnapshotCommits: number;
}

export interface NarrativeSummary {
  decisionThreads: number;
  decisionNodes: number;
  intentItems: number;
  timelineEvents: number;
  heuristicEdges: number;
}

export interface NarrativeResult {
  dryRun: boolean;
  reportPath: string;
  headSha: string;
  window: NarrativeWindowSummary;
  summary: NarrativeSummary;
  warnings: string[];
}

interface SelectedSnapshot {
  commitSha: string;
  subject: string;
  authorName: string;
  authoredAt: string;
  manifest: SnapshotManifest;
  snapshotIndex: number;
}

type NarrativeChangeType = "added" | "modified" | "deleted" | "related";
type NarrativeRelationKind = "root" | "explicit" | "path-continuity" | "heuristic-high" | "heuristic-medium";

interface RawNarrativeDecisionNode {
  sourceKey: string;
  snapshotIndex: number;
  commitSha: string;
  authoredAt: string;
  path: string;
  docType: DocType;
  title: string;
  summary: string;
  changeType: NarrativeChangeType;
  sourceArtifactId: string | null;
  goalId: string | null;
  episodeId: string | null;
  sourceSessionId: string | null;
  relatedPaths: string[];
}

interface NarrativeDecisionNode extends RawNarrativeDecisionNode {
  nodeId: string;
  threadId: string;
  predecessorNodeId: string | null;
  relationKind: NarrativeRelationKind;
  confidence: number;
}

interface NarrativeDecisionThread {
  threadId: string;
  title: string;
  docType: DocType;
  docPaths: string[];
  goalIds: string[];
  episodeIds: string[];
  sessionIds: string[];
  snapshotShas: string[];
  nodeIds: string[];
}

interface NarrativeIntentItem {
  itemId: string;
  artifactId: string;
  kind: ArtifactRecord["kind"];
  status: ArtifactStatus;
  title: string;
  summary: string;
  goalId: string | null;
  episodeId: string | null;
  sourceSessionId: string | null;
  anchorSha: string | null;
  relatedPaths: string[];
  createdAt: string;
  threadIds: string[];
}

interface NarrativeEventItem {
  eventId: string;
  eventType: RagitEventType;
  recordedAt: string;
  summary: string;
  sourceHeadSha: string | null;
  goalId: string | null;
  episodeId: string | null;
  sessionId: string | null;
  relatedPaths: string[];
  threadIds: string[];
}

interface NarrativeViewModel {
  repoName: string;
  headSha: string;
  generatedAt: string;
  window: NarrativeWindowSummary;
  summary: NarrativeSummary;
  snapshots: Array<{
    commitSha: string;
    subject: string;
    authoredAt: string;
    shortSha: string;
  }>;
  threads: NarrativeDecisionThread[];
  nodes: NarrativeDecisionNode[];
  intentItems: NarrativeIntentItem[];
  unassignedIntentItems: NarrativeIntentItem[];
  timelineEvents: NarrativeEventItem[];
  warnings: string[];
  empty: boolean;
}

const shortSha = (value: string): string => value.slice(0, 7);
const normalizeRepoPath = (value: string): string => value.replaceAll("\\", "/");
const compactText = (value: string, max = 180): string => {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
};
const normalizeTitle = (value: string): string =>
  value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
const uniqueStrings = (values: Array<string | null | undefined>): string[] =>
  Array.from(new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0)));
const arraysIntersect = (left: string[], right: string[]): boolean => {
  const rightSet = new Set(right);
  return left.some((item) => rightSet.has(item));
};
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const documentTitle = (doc: DocumentRecord): string => {
  const firstSection = doc.sections[0];
  if (firstSection?.title) return firstSection.title.trim();
  const basename = path.basename(doc.path).replace(/\.[^.]+(?:\.[^.]+)?$/, "");
  return basename || doc.path;
};

const documentSummary = (doc: DocumentRecord): string => {
  const firstSection = doc.sections[0];
  if (firstSection?.content) return compactText(firstSection.content, 200);
  return compactText(doc.path, 200);
};

const resolveNarrativeOutput = (
  cwd: string,
  anchorSha: string,
  output?: string,
): { absolutePath: string; displayPath: string } => {
  const defaultRelative = normalizeRepoPath(path.join(".ragit", "reports", "narrative", `${anchorSha}.html`));
  if (!output) {
    const absolutePath = path.join(cwd, defaultRelative);
    return { absolutePath, displayPath: defaultRelative };
  }
  if (path.isAbsolute(output)) {
    return { absolutePath: output, displayPath: output };
  }
  const normalized = normalizeRepoPath(output);
  return {
    absolutePath: path.resolve(cwd, normalized),
    displayPath: normalized,
  };
};

const collectSelectedSnapshots = async (
  cwd: string,
  revRange: string | undefined,
  maxCommits: number,
): Promise<{
  headSha: string;
  snapshots: SelectedSnapshot[];
  missingSnapshotCommits: number;
}> => {
  const commits = await listGitCommits(cwd, revRange ? { revRange } : {});
  const headSha = commits[0]?.sha ?? (await getHeadSha(cwd));
  const snapshots: SelectedSnapshot[] = [];
  let missingSnapshotCommits = 0;
  for (const commit of commits) {
    const manifest = await loadSnapshotManifestIfExists(cwd, commit.sha);
    if (!manifest) {
      missingSnapshotCommits += 1;
      continue;
    }
    snapshots.push({
      commitSha: commit.sha,
      subject: commit.subject,
      authorName: commit.authorName,
      authoredAt: commit.authoredAt,
      manifest,
      snapshotIndex: snapshots.length,
    });
    if (snapshots.length >= maxCommits) break;
  }
  return {
    headSha,
    snapshots,
    missingSnapshotCommits,
  };
};

const compareDecisionDocs = (
  currentDocs: DocumentRecord[],
  previousDocs: DocumentRecord[],
): Array<{
  changeType: NarrativeChangeType;
  current: DocumentRecord | null;
  previous: DocumentRecord | null;
}> => {
  const currentByPath = new Map(currentDocs.map((doc) => [normalizeRepoPath(doc.path), doc]));
  const previousByPath = new Map(previousDocs.map((doc) => [normalizeRepoPath(doc.path), doc]));
  const changes: Array<{
    changeType: NarrativeChangeType;
    current: DocumentRecord | null;
    previous: DocumentRecord | null;
  }> = [];

  for (const doc of currentDocs) {
    const previous = previousByPath.get(normalizeRepoPath(doc.path));
    if (!previous) {
      changes.push({ changeType: "added", current: doc, previous: null });
      continue;
    }
    if (previous.versionId !== doc.versionId || previous.hash !== doc.hash) {
      changes.push({ changeType: "modified", current: doc, previous });
    }
  }

  for (const doc of previousDocs) {
    if (currentByPath.has(normalizeRepoPath(doc.path))) continue;
    changes.push({ changeType: "deleted", current: null, previous: doc });
  }

  changes.sort((left, right) => {
    const leftDoc = left.current ?? left.previous;
    const rightDoc = right.current ?? right.previous;
    return normalizeRepoPath(leftDoc?.path ?? "").localeCompare(normalizeRepoPath(rightDoc?.path ?? ""));
  });
  return changes;
};

const toRawNode = async (
  cwd: string,
  snapshot: SelectedSnapshot,
  doc: DocumentRecord,
  changeType: NarrativeChangeType,
  sourceKey: string,
): Promise<RawNarrativeDecisionNode> => {
  const backingArtifact = doc.artifactId ? await loadArtifactRecord(cwd, doc.artifactId) : null;
  return {
    sourceKey,
    snapshotIndex: snapshot.snapshotIndex,
    commitSha: snapshot.commitSha,
    authoredAt: snapshot.authoredAt,
    path: normalizeRepoPath(doc.path),
    docType: doc.docType,
    title: documentTitle(doc),
    summary: documentSummary(doc),
    changeType,
    sourceArtifactId: doc.artifactId ?? null,
    goalId: backingArtifact?.goalId ?? null,
    episodeId: backingArtifact?.episodeId ?? null,
    sourceSessionId: backingArtifact?.sourceSessionId ?? null,
    relatedPaths: uniqueStrings(backingArtifact?.relatedPaths ?? []),
  };
};

const collectChangedDecisionNodes = async (cwd: string, snapshots: SelectedSnapshot[]): Promise<RawNarrativeDecisionNode[]> => {
  const ascendingSnapshots = [...snapshots].reverse();
  const nodes: RawNarrativeDecisionNode[] = [];
  for (let index = 0; index < ascendingSnapshots.length; index += 1) {
    const currentSnapshot = {
      ...ascendingSnapshots[index],
      snapshotIndex: index,
    };
    const previousSnapshot = index > 0 ? { ...ascendingSnapshots[index - 1], snapshotIndex: index - 1 } : null;
    const currentDocs = currentSnapshot.manifest.docs.filter((doc) => DECISION_DOC_TYPES.has(doc.docType));
    const previousDocs = previousSnapshot ? previousSnapshot.manifest.docs.filter((doc) => DECISION_DOC_TYPES.has(doc.docType)) : [];
    const changes = compareDecisionDocs(currentDocs, previousDocs);
    for (const change of changes) {
      const targetDoc = change.current ?? change.previous;
      if (!targetDoc) continue;
      nodes.push(
        await toRawNode(
          cwd,
          currentSnapshot,
          targetDoc,
          change.changeType,
          `${currentSnapshot.commitSha}:${change.changeType}:${normalizeRepoPath(targetDoc.path)}`,
        ),
      );
    }
  }
  return nodes;
};

const collectCandidateIntentItems = async (
  cwd: string,
  snapshots: SelectedSnapshot[],
  rawNodes: RawNarrativeDecisionNode[],
): Promise<NarrativeIntentItem[]> => {
  const selectedSnapshotSet = new Set(snapshots.map((snapshot) => snapshot.commitSha));
  const earliestAuthoredAt = snapshots.length > 0 ? [...snapshots].reverse()[0].authoredAt : null;
  const latestAuthoredAt = snapshots.length > 0 ? snapshots[0].authoredAt : null;
  const goalIds = new Set(rawNodes.map((node) => node.goalId).filter(Boolean));
  const episodeIds = new Set(rawNodes.map((node) => node.episodeId).filter(Boolean));
  const records = await listArtifactRecords(cwd, { statuses: ["reviewed", "promoted"] });

  return records
    .filter((artifact) => INTENT_KINDS.has(artifact.kind))
    .filter((artifact) => {
      const anchor = artifact.boundHeadSha ?? artifact.sourceHeadSha ?? artifact.captureHeadSha;
      if (anchor && selectedSnapshotSet.has(anchor)) return true;
      if (anchor) return false;
      if (!earliestAuthoredAt || !latestAuthoredAt) return false;
      if (artifact.createdAt < earliestAuthoredAt || artifact.createdAt > latestAuthoredAt) return false;
      return (artifact.goalId ? goalIds.has(artifact.goalId) : false) || (artifact.episodeId ? episodeIds.has(artifact.episodeId) : false);
    })
    .map((artifact) => ({
      itemId: artifact.artifactId,
      artifactId: artifact.artifactId,
      kind: artifact.kind,
      status: artifact.status,
      title: artifact.title,
      summary: artifact.summary,
      goalId: artifact.goalId,
      episodeId: artifact.episodeId,
      sourceSessionId: artifact.sourceSessionId,
      anchorSha: artifact.boundHeadSha ?? artifact.sourceHeadSha ?? artifact.captureHeadSha,
      relatedPaths: artifact.relatedPaths.map(normalizeRepoPath),
      createdAt: artifact.createdAt,
      threadIds: [],
    }));
};

const addSupportNodes = async (
  cwd: string,
  snapshots: SelectedSnapshot[],
  rawNodes: RawNarrativeDecisionNode[],
  intentItems: NarrativeIntentItem[],
): Promise<RawNarrativeDecisionNode[]> => {
  const existingPaths = new Set(rawNodes.map((node) => node.path));
  const supportNodes: RawNarrativeDecisionNode[] = [];
  for (const relatedPath of uniqueStrings(intentItems.flatMap((item) => item.relatedPaths))) {
    if (existingPaths.has(relatedPath)) continue;
    for (const snapshot of snapshots) {
      const doc = snapshot.manifest.docs.find(
        (candidate) => normalizeRepoPath(candidate.path) === relatedPath && DECISION_DOC_TYPES.has(candidate.docType),
      );
      if (!doc) continue;
      existingPaths.add(relatedPath);
      supportNodes.push(await toRawNode(cwd, snapshot, doc, "related", `${snapshot.commitSha}:related:${relatedPath}`));
      break;
    }
  }
  return [...rawNodes, ...supportNodes];
};

const buildPathContinuityPredecessor = (
  current: RawNarrativeDecisionNode,
  olderNodes: NarrativeDecisionNode[],
): NarrativeDecisionNode | null =>
  [...olderNodes].reverse().find((candidate) => candidate.path === current.path) ?? null;

const buildExplicitPredecessor = async (
  cwd: string,
  current: RawNarrativeDecisionNode,
  olderNodes: NarrativeDecisionNode[],
): Promise<NarrativeDecisionNode | null> => {
  if (!current.sourceArtifactId) return null;
  const artifact = await loadArtifactRecord(cwd, current.sourceArtifactId);
  if (!artifact || artifact.supersedes.length === 0) return null;
  return [...olderNodes].reverse().find((candidate) => candidate.sourceArtifactId && artifact.supersedes.includes(candidate.sourceArtifactId)) ?? null;
};

const buildHeuristicPredecessor = (
  current: RawNarrativeDecisionNode,
  olderNodes: NarrativeDecisionNode[],
): { predecessor: NarrativeDecisionNode | null; relationKind: NarrativeRelationKind } => {
  const previousSnapshotIndex = current.snapshotIndex - 1;
  if (previousSnapshotIndex < 0) return { predecessor: null, relationKind: "root" };
  const normalizedCurrentTitle = normalizeTitle(current.title);
  const candidates = olderNodes.filter(
    (candidate) =>
      candidate.snapshotIndex === previousSnapshotIndex &&
      candidate.docType === current.docType &&
      normalizeTitle(candidate.title) === normalizedCurrentTitle,
  );
  if (candidates.length === 1) {
    return {
      predecessor: candidates[0],
      relationKind: "heuristic-high",
    };
  }
  if (candidates.length <= 1) return { predecessor: null, relationKind: "root" };
  const narrowed = candidates.filter(
    (candidate) =>
      (current.goalId && candidate.goalId === current.goalId) ||
      (current.episodeId && candidate.episodeId === current.episodeId) ||
      arraysIntersect(candidate.relatedPaths, current.relatedPaths),
  );
  if (narrowed.length === 1) {
    return {
      predecessor: narrowed[0],
      relationKind: "heuristic-medium",
    };
  }
  return { predecessor: null, relationKind: "root" };
};

const relationConfidence = (relationKind: NarrativeRelationKind): number => {
  switch (relationKind) {
    case "explicit":
      return 1;
    case "path-continuity":
      return 0.95;
    case "heuristic-high":
      return 0.8;
    case "heuristic-medium":
      return 0.65;
    default:
      return 0;
  }
};

const assignNarrativeThreads = async (cwd: string, rawNodes: RawNarrativeDecisionNode[]): Promise<NarrativeDecisionNode[]> => {
  const ordered = [...rawNodes].sort((left, right) => {
    if (left.snapshotIndex !== right.snapshotIndex) return left.snapshotIndex - right.snapshotIndex;
    return left.path.localeCompare(right.path);
  });
  const nodes: NarrativeDecisionNode[] = [];

  for (const rawNode of ordered) {
    const explicitPredecessor = await buildExplicitPredecessor(cwd, rawNode, nodes);
    const pathPredecessor = explicitPredecessor ? null : buildPathContinuityPredecessor(rawNode, nodes);
    const heuristic = explicitPredecessor || pathPredecessor ? { predecessor: null, relationKind: "root" as const } : buildHeuristicPredecessor(rawNode, nodes);
    const predecessor = explicitPredecessor ?? pathPredecessor ?? heuristic.predecessor;
    const relationKind: NarrativeRelationKind = explicitPredecessor
      ? "explicit"
      : pathPredecessor
        ? "path-continuity"
        : heuristic.relationKind;
    const nodeId = `nar_${rawNode.snapshotIndex}_${nodes.length + 1}`;
    const threadId = predecessor?.threadId ?? `thread_${nodeId}`;
    nodes.push({
      ...rawNode,
      nodeId,
      threadId,
      predecessorNodeId: predecessor?.nodeId ?? null,
      relationKind,
      confidence: relationConfidence(relationKind),
    });
  }

  return nodes;
};

const buildThreads = (nodes: NarrativeDecisionNode[]): NarrativeDecisionThread[] => {
  const byThread = new Map<string, NarrativeDecisionNode[]>();
  for (const node of nodes) {
    const bucket = byThread.get(node.threadId) ?? [];
    bucket.push(node);
    byThread.set(node.threadId, bucket);
  }
  return [...byThread.entries()]
    .map(([threadId, threadNodes]) => {
      const orderedNodes = [...threadNodes].sort((left, right) => {
        if (left.snapshotIndex !== right.snapshotIndex) return left.snapshotIndex - right.snapshotIndex;
        return left.authoredAt.localeCompare(right.authoredAt);
      });
      const latestNode = orderedNodes[orderedNodes.length - 1];
      return {
        threadId,
        title: latestNode.title,
        docType: latestNode.docType,
        docPaths: uniqueStrings(orderedNodes.map((node) => node.path)),
        goalIds: uniqueStrings(orderedNodes.map((node) => node.goalId)),
        episodeIds: uniqueStrings(orderedNodes.map((node) => node.episodeId)),
        sessionIds: uniqueStrings(orderedNodes.map((node) => node.sourceSessionId)),
        snapshotShas: uniqueStrings(orderedNodes.map((node) => node.commitSha)),
        nodeIds: orderedNodes.map((node) => node.nodeId),
      };
    })
    .sort((left, right) => left.title.localeCompare(right.title));
};

const attachIntentItems = (threads: NarrativeDecisionThread[], intentItems: NarrativeIntentItem[]): {
  assigned: NarrativeIntentItem[];
  unassigned: NarrativeIntentItem[];
} => {
  const attached = intentItems.map((item) => {
    const byPath = threads.filter((thread) => arraysIntersect(thread.docPaths, item.relatedPaths));
    const byGoal = byPath.length > 0 ? [] : threads.filter((thread) => item.goalId && thread.goalIds.includes(item.goalId));
    const byEpisode = byPath.length > 0 || byGoal.length > 0 ? [] : threads.filter((thread) => item.episodeId && thread.episodeIds.includes(item.episodeId));
    const byAnchor =
      byPath.length > 0 || byGoal.length > 0 || byEpisode.length > 0
        ? []
        : threads.filter((thread) => item.anchorSha && thread.snapshotShas.includes(item.anchorSha));
    const matched = byPath.length > 0 ? byPath : byGoal.length > 0 ? byGoal : byEpisode.length > 0 ? byEpisode : byAnchor;
    return {
      ...item,
      threadIds: matched.map((thread) => thread.threadId),
    };
  });
  return {
    assigned: attached.filter((item) => item.threadIds.length > 0),
    unassigned: attached.filter((item) => item.threadIds.length === 0),
  };
};

const attachTimelineEvents = (
  threads: NarrativeDecisionThread[],
  events: RagitEventRecord[],
): NarrativeEventItem[] =>
  events.map((event) => {
    const matched = threads.filter(
      (thread) =>
        (event.sourceHeadSha ? thread.snapshotShas.includes(event.sourceHeadSha) : false) ||
        (event.goalId ? thread.goalIds.includes(event.goalId) : false) ||
        (event.sessionId ? thread.sessionIds.includes(event.sessionId) : false) ||
        arraysIntersect(thread.docPaths, event.relatedPaths.map(normalizeRepoPath)),
    );
    return {
      eventId: event.eventId,
      eventType: event.eventType,
      recordedAt: event.recordedAt,
      summary: event.summary,
      sourceHeadSha: event.sourceHeadSha,
      goalId: event.goalId,
      episodeId: event.episodeId,
      sessionId: event.sessionId,
      relatedPaths: event.relatedPaths.map(normalizeRepoPath),
      threadIds: matched.map((thread) => thread.threadId),
    };
  });

const selectNarrativeEvents = async (
  cwd: string,
  snapshots: SelectedSnapshot[],
): Promise<RagitEventRecord[]> => {
  if (snapshots.length === 0) return [];
  const selectedSnapshotShas = new Set(snapshots.map((snapshot) => snapshot.commitSha));
  const ascending = [...snapshots].reverse();
  const earliestAuthoredAt = ascending[0].authoredAt;
  const latestAuthoredAt = snapshots[0].authoredAt;
  const timeline = await readNarrativeLedgerEvents(cwd);
  return timeline
    .filter((event) => TIMELINE_EVENT_TYPES.has(event.eventType))
    .filter(
      (event) =>
        (event.sourceHeadSha ? selectedSnapshotShas.has(event.sourceHeadSha) : false) ||
        (event.recordedAt >= earliestAuthoredAt && event.recordedAt <= latestAuthoredAt),
    )
    .sort((left, right) => left.recordedAt.localeCompare(right.recordedAt) || left.eventId.localeCompare(right.eventId));
};

const isRagitEventType = (value: string): value is RagitEventType =>
  TIMELINE_EVENT_TYPES.has(value as RagitEventType) ||
  value === "artifact.review";

const normalizeNarrativeEventRecord = (value: unknown): RagitEventRecord | null => {
  if (!isPlainObject(value)) return null;
  if (value.version !== 1) return null;
  if (typeof value.eventId !== "string" || typeof value.recordedAt !== "string" || typeof value.summary !== "string") return null;
  if (typeof value.eventType !== "string" || !isRagitEventType(value.eventType)) return null;
  return {
    version: 1,
    eventId: value.eventId,
    eventType: value.eventType,
    recordedAt: value.recordedAt,
    goalId: typeof value.goalId === "string" ? value.goalId : null,
    episodeId: typeof value.episodeId === "string" ? value.episodeId : null,
    sessionId: typeof value.sessionId === "string" ? value.sessionId : null,
    sourceHeadSha: typeof value.sourceHeadSha === "string" ? value.sourceHeadSha : null,
    summary: value.summary,
    artifactIds: Array.isArray(value.artifactIds) ? value.artifactIds.filter((item): item is string => typeof item === "string") : [],
    relatedPaths: Array.isArray(value.relatedPaths)
      ? value.relatedPaths.filter((item): item is string => typeof item === "string").map(normalizeRepoPath)
      : [],
    openLoops: Array.isArray(value.openLoops) ? value.openLoops.filter((item): item is string => typeof item === "string") : [],
    nextActions: Array.isArray(value.nextActions) ? value.nextActions.filter((item): item is string => typeof item === "string") : [],
    metadata: isPlainObject(value.metadata) ? value.metadata : undefined,
    provenance: isPlainObject(value.provenance)
      ? {
          actor: value.provenance.actor === "user" || value.provenance.actor === "assistant" || value.provenance.actor === "system"
            ? value.provenance.actor
            : "system",
          producer: typeof value.provenance.producer === "string" ? value.provenance.producer : "ragit",
          producerVersion: typeof value.provenance.producerVersion === "string" ? value.provenance.producerVersion : "unknown",
          operation: typeof value.provenance.operation === "string" ? value.provenance.operation : "narrative.read",
          inputRefs: Array.isArray(value.provenance.inputRefs)
            ? value.provenance.inputRefs.filter((item): item is string => typeof item === "string")
            : [],
          outputRefs: Array.isArray(value.provenance.outputRefs)
            ? value.provenance.outputRefs.filter((item): item is string => typeof item === "string")
            : [],
          evidenceRefs: Array.isArray(value.provenance.evidenceRefs)
            ? value.provenance.evidenceRefs.filter((item): item is string => typeof item === "string")
            : [],
          contentHash: typeof value.provenance.contentHash === "string" ? value.provenance.contentHash : "",
        }
      : {
          actor: "system",
          producer: "ragit",
          producerVersion: "unknown",
          operation: "narrative.read",
          inputRefs: [],
          outputRefs: [],
          evidenceRefs: [],
          contentHash: "",
        },
  };
};

const readNarrativeLedgerEvents = async (cwd: string): Promise<RagitEventRecord[]> => {
  const eventDir = resolveRagitPaths(cwd).eventDir;
  let files: string[] = [];
  try {
    files = (await readdir(eventDir)).filter((entry) => entry.endsWith(".jsonl")).sort();
  } catch {
    return [];
  }
  const events: RagitEventRecord[] = [];
  for (const file of files) {
    const absolutePath = path.join(eventDir, file);
    let content = "";
    try {
      content = await readFile(absolutePath, "utf8");
    } catch {
      continue;
    }
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed = normalizeNarrativeEventRecord(JSON.parse(line));
        if (parsed) events.push(parsed);
      } catch {
        continue;
      }
    }
  }
  return events.sort((left, right) => left.recordedAt.localeCompare(right.recordedAt) || left.eventId.localeCompare(right.eventId));
};

const toSummary = (
  nodes: NarrativeDecisionNode[],
  threads: NarrativeDecisionThread[],
  intentItems: NarrativeIntentItem[],
  timelineEvents: NarrativeEventItem[],
): NarrativeSummary => ({
  decisionThreads: threads.length,
  decisionNodes: nodes.length,
  intentItems: intentItems.length,
  timelineEvents: timelineEvents.length,
  heuristicEdges: nodes.filter((node) => node.relationKind === "heuristic-high" || node.relationKind === "heuristic-medium").length,
});

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const serializeForScript = (value: unknown): string =>
  JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");

const renderDecisionSection = (viewModel: NarrativeViewModel): string => {
  if (viewModel.empty || viewModel.threads.length === 0 || viewModel.snapshots.length === 0) {
    return `
      <div class="empty-state">
        <p>Selected window에 indexed snapshot 또는 decision doc가 없습니다.</p>
        <p>먼저 <code>ragit ingest</code>로 snapshot을 만들고, 필요하면 reviewed/promoted memory를 쌓으십시오.</p>
      </div>
    `;
  }

  const headerCells = viewModel.snapshots
    .map(
      (snapshot) => `
        <div class="snapshot-header-cell">
          <div class="snapshot-sha">${escapeHtml(snapshot.shortSha)}</div>
          <div class="snapshot-date">${escapeHtml(snapshot.authoredAt.slice(0, 10))}</div>
          <div class="snapshot-subject">${escapeHtml(snapshot.subject)}</div>
        </div>
      `,
    )
    .join("");

  const rows = viewModel.threads
    .map((thread) => {
      const cells = viewModel.snapshots
        .map((snapshot) => {
          const nodes = viewModel.nodes.filter((node) => node.threadId === thread.threadId && node.commitSha === snapshot.commitSha);
          return `
            <div class="thread-cell">
              ${nodes
                .map(
                  (node) => `
                    <button
                      type="button"
                      class="node-chip node-${escapeHtml(node.changeType)}"
                      data-thread-focus="${escapeHtml(thread.threadId)}"
                      data-thread-ref="${escapeHtml(thread.threadId)}"
                      data-detail='${escapeHtml(
                        JSON.stringify({
                          type: "decision",
                          title: node.title,
                          summary: node.summary,
                          path: node.path,
                          artifactId: node.sourceArtifactId,
                          snapshotSha: node.commitSha,
                          relationKind: node.relationKind,
                          confidence: node.confidence,
                          changeType: node.changeType,
                        }),
                      )}'
                    >
                      <span class="node-badge">${escapeHtml(node.changeType)}</span>
                      <span class="node-title">${escapeHtml(node.title)}</span>
                      <span class="node-meta">${escapeHtml(node.relationKind)}</span>
                    </button>
                  `,
                )
                .join("")}
            </div>
          `;
        })
        .join("");
      const labelDetail = escapeHtml(
        JSON.stringify({
          type: "thread",
          title: thread.title,
          summary: `${thread.docType} thread across ${thread.snapshotShas.length} snapshot(s)`,
          path: thread.docPaths.join(", "),
          artifactId: null,
          snapshotSha: thread.snapshotShas.at(-1) ?? null,
          relationKind: "thread",
          confidence: null,
          changeType: null,
        }),
      );
      return `
        <div class="thread-row" style="grid-template-columns: 220px repeat(${viewModel.snapshots.length}, minmax(160px, 1fr));">
          <button
            type="button"
            class="thread-label"
            data-thread-focus="${escapeHtml(thread.threadId)}"
            data-thread-ref="${escapeHtml(thread.threadId)}"
            data-detail='${labelDetail}'
          >
            <span class="thread-title">${escapeHtml(thread.title)}</span>
            <span class="thread-meta">${escapeHtml(thread.docType)} · ${thread.nodeIds.length} node(s)</span>
          </button>
          ${cells}
        </div>
      `;
    })
    .join("");

  return `
    <div class="decision-grid" style="grid-template-columns: 220px repeat(${viewModel.snapshots.length}, minmax(160px, 1fr));">
      <div class="snapshot-header-spacer"></div>
      ${headerCells}
    </div>
    <div class="decision-rows">
      ${rows}
    </div>
  `;
};

const renderIntentSection = (items: NarrativeIntentItem[], title: string): string => {
  if (items.length === 0) {
    return `<div class="empty-state"><p>No ${escapeHtml(title.toLowerCase())} in the selected window.</p></div>`;
  }
  return items
    .map((item) => {
      const detail = escapeHtml(
        JSON.stringify({
          type: "intent",
          title: item.title,
          summary: item.summary,
          path: item.relatedPaths.join(", "),
          artifactId: item.artifactId,
          snapshotSha: item.anchorSha,
          relationKind: item.kind,
          confidence: null,
          changeType: item.status,
        }),
      );
      return `
        <article
          class="intent-item"
          data-thread-refs="${escapeHtml(item.threadIds.join(" "))}"
        >
          <button
            type="button"
            class="intent-button"
            data-thread-focus="${escapeHtml(item.threadIds[0] ?? "")}"
            data-detail='${detail}'
          >
            <span class="intent-kind">${escapeHtml(item.kind)}</span>
            <span class="intent-title">${escapeHtml(item.title)}</span>
            <span class="intent-summary">${escapeHtml(item.summary)}</span>
          </button>
        </article>
      `;
    })
    .join("");
};

const renderTimelineSection = (events: NarrativeEventItem[]): string => {
  if (events.length === 0) {
    return `<div class="empty-state"><p>No operational events matched the selected snapshot window.</p></div>`;
  }
  return events
    .map((event) => {
      const detail = escapeHtml(
        JSON.stringify({
          type: "event",
          title: event.eventType,
          summary: event.summary,
          path: event.relatedPaths.join(", "),
          artifactId: null,
          snapshotSha: event.sourceHeadSha,
          relationKind: "event",
          confidence: null,
          changeType: null,
        }),
      );
      return `
        <article class="timeline-item" data-thread-refs="${escapeHtml(event.threadIds.join(" "))}">
          <button
            type="button"
            class="timeline-button"
            data-thread-focus="${escapeHtml(event.threadIds[0] ?? "")}"
            data-detail='${detail}'
          >
            <span class="timeline-date">${escapeHtml(event.recordedAt)}</span>
            <span class="timeline-type">${escapeHtml(event.eventType)}</span>
            <span class="timeline-summary">${escapeHtml(event.summary)}</span>
          </button>
        </article>
      `;
    })
    .join("");
};

export const renderNarrativeReport = (viewModel: NarrativeViewModel): string => `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(viewModel.repoName)} narrative report</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f5f1e8;
        --panel: #fffaf2;
        --ink: #1d1a16;
        --muted: #6b655c;
        --line: #d9d0c3;
        --accent: #0e6b50;
        --added: #d7f5e8;
        --modified: #fff2cc;
        --deleted: #f9d6d2;
        --related: #dfe9ff;
        --active: #143d59;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: linear-gradient(180deg, #f8f5ee 0%, var(--bg) 100%);
        color: var(--ink);
      }
      main {
        max-width: 1440px;
        margin: 0 auto;
        padding: 32px 24px 48px;
      }
      h1, h2, h3, p { margin: 0; }
      .report-header {
        display: flex;
        justify-content: space-between;
        gap: 24px;
        align-items: end;
        margin-bottom: 24px;
      }
      .report-subtitle {
        color: var(--muted);
        margin-top: 8px;
        line-height: 1.5;
      }
      .legend {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
        color: var(--muted);
        font-size: 13px;
      }
      .legend span::before {
        content: "";
        display: inline-block;
        width: 10px;
        height: 10px;
        border-radius: 999px;
        margin-right: 6px;
        vertical-align: middle;
      }
      .legend-added::before { background: #54b67d; }
      .legend-modified::before { background: #d3a628; }
      .legend-deleted::before { background: #c45d4a; }
      .legend-related::before { background: #4869d2; }
      section {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 20px;
        padding: 20px;
        box-shadow: 0 10px 30px rgba(29, 26, 22, 0.05);
      }
      .summary-grid, .content-grid {
        display: grid;
        gap: 18px;
      }
      .summary-grid {
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        margin-bottom: 18px;
      }
      .summary-card {
        padding: 16px;
        border-radius: 16px;
        background: rgba(255, 255, 255, 0.6);
        border: 1px solid var(--line);
      }
      .summary-label {
        color: var(--muted);
        font-size: 13px;
        margin-bottom: 8px;
      }
      .summary-value {
        font-size: 28px;
        font-weight: 700;
      }
      .content-grid {
        grid-template-columns: minmax(0, 2fr) minmax(320px, 1fr);
        align-items: start;
      }
      .stack {
        display: grid;
        gap: 18px;
      }
      .decision-grid, .thread-row {
        display: grid;
        gap: 12px;
      }
      .decision-grid {
        margin-top: 16px;
        margin-bottom: 12px;
      }
      .snapshot-header-cell, .thread-cell, .thread-label {
        border: 1px solid var(--line);
        border-radius: 14px;
        min-height: 88px;
        background: rgba(255,255,255,0.75);
      }
      .snapshot-header-cell {
        padding: 12px;
      }
      .snapshot-sha {
        font-weight: 700;
      }
      .snapshot-date, .snapshot-subject, .thread-meta, .intent-kind, .timeline-type, .detail-meta {
        color: var(--muted);
        font-size: 12px;
      }
      .snapshot-subject {
        margin-top: 8px;
        line-height: 1.45;
      }
      .decision-rows {
        display: grid;
        gap: 12px;
      }
      .thread-label, .node-chip, .intent-button, .timeline-button {
        width: 100%;
        appearance: none;
        border: 0;
        background: transparent;
        text-align: left;
        cursor: pointer;
        color: inherit;
      }
      .thread-label {
        padding: 14px;
        display: grid;
        gap: 8px;
      }
      .thread-title {
        font-weight: 700;
      }
      .thread-cell {
        padding: 10px;
        display: grid;
        gap: 8px;
        align-content: start;
      }
      .node-chip {
        padding: 10px 12px;
        border-radius: 12px;
        display: grid;
        gap: 6px;
        border: 1px solid rgba(20, 61, 89, 0.08);
      }
      .node-added { background: var(--added); }
      .node-modified { background: var(--modified); }
      .node-deleted { background: var(--deleted); }
      .node-related { background: var(--related); }
      .node-badge {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--muted);
      }
      .node-title, .intent-title {
        font-weight: 700;
      }
      .node-meta, .intent-summary, .timeline-summary {
        font-size: 13px;
        line-height: 1.45;
        color: #3f392f;
      }
      .intent-group + .intent-group {
        margin-top: 16px;
      }
      .intent-list, .timeline-list {
        display: grid;
        gap: 10px;
        margin-top: 12px;
      }
      .intent-item, .timeline-item {
        border: 1px solid var(--line);
        border-radius: 14px;
        background: rgba(255,255,255,0.72);
      }
      .intent-button, .timeline-button {
        padding: 14px;
        display: grid;
        gap: 6px;
      }
      .detail-card {
        margin-top: 16px;
        padding: 16px;
        border: 1px dashed var(--line);
        border-radius: 16px;
        background: rgba(255,255,255,0.66);
        display: grid;
        gap: 10px;
      }
      .detail-title {
        font-weight: 700;
      }
      .detail-summary {
        line-height: 1.55;
      }
      .detail-list {
        display: grid;
        gap: 6px;
        font-size: 13px;
      }
      .empty-state {
        border: 1px dashed var(--line);
        border-radius: 16px;
        padding: 18px;
        color: var(--muted);
        line-height: 1.6;
      }
      .is-active {
        outline: 2px solid var(--active);
        outline-offset: 2px;
      }
      .is-muted {
        opacity: 0.3;
      }
      @media (max-width: 1100px) {
        .content-grid {
          grid-template-columns: 1fr;
        }
      }
      @media (max-width: 760px) {
        main {
          padding: 20px 14px 32px;
        }
        .report-header {
          display: grid;
          align-items: start;
        }
        .decision-grid, .thread-row {
          overflow-x: auto;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <header class="report-header">
        <div>
          <h1>${escapeHtml(viewModel.repoName)} narrative report</h1>
          <p class="report-subtitle">
            프로젝트의 결정 변화사, 의도, 운영 시간축을 같은 창에서 읽도록 합성한 self-contained report입니다.
          </p>
        </div>
        <div class="legend">
          <span class="legend-added">added</span>
          <span class="legend-modified">modified</span>
          <span class="legend-deleted">deleted</span>
          <span class="legend-related">related</span>
        </div>
      </header>

      <section id="report-summary">
        <div class="summary-grid">
          <div class="summary-card"><div class="summary-label">Head</div><div class="summary-value">${escapeHtml(shortSha(viewModel.headSha))}</div></div>
          <div class="summary-card"><div class="summary-label">Selected Snapshots</div><div class="summary-value">${viewModel.window.selectedSnapshotShas.length}</div></div>
          <div class="summary-card"><div class="summary-label">Decision Threads</div><div class="summary-value">${viewModel.summary.decisionThreads}</div></div>
          <div class="summary-card"><div class="summary-label">Intent Items</div><div class="summary-value">${viewModel.summary.intentItems}</div></div>
          <div class="summary-card"><div class="summary-label">Timeline Events</div><div class="summary-value">${viewModel.summary.timelineEvents}</div></div>
          <div class="summary-card"><div class="summary-label">Missing Snapshot Commits</div><div class="summary-value">${viewModel.window.missingSnapshotCommits}</div></div>
        </div>
        <div class="detail-list">
          <div><strong>Window</strong>: ${escapeHtml(viewModel.window.revRange ?? "HEAD")} · max ${viewModel.window.maxCommits} selected snapshot commit(s)</div>
          <div><strong>Generated at</strong>: ${escapeHtml(viewModel.generatedAt)}</div>
          <div><strong>Warnings</strong>: ${viewModel.warnings.length === 0 ? "none" : escapeHtml(viewModel.warnings.join(" | "))}</div>
        </div>
      </section>

      <div class="content-grid" style="margin-top: 18px;">
        <section id="decision-evolution">
          <h2>Decision Evolution</h2>
          ${renderDecisionSection(viewModel)}
        </section>

        <div class="stack">
          <section id="intent-panel">
            <h2>Intent Panel</h2>
            <div class="intent-group">
              <h3>Assigned</h3>
              <div class="intent-list">${renderIntentSection(viewModel.intentItems, "Assigned intent items")}</div>
            </div>
            <div class="intent-group">
              <h3>Unassigned</h3>
              <div class="intent-list">${renderIntentSection(viewModel.unassignedIntentItems, "Unassigned intent items")}</div>
            </div>
            <div id="detail-card" class="detail-card">
              <div class="detail-title">Detail</div>
              <div class="detail-summary">노드, intent, timeline event를 클릭하면 결속 정보와 근거 메타데이터를 여기서 보여 줍니다.</div>
            </div>
          </section>

          <section id="operational-timeline">
            <h2>Operational Timeline</h2>
            <div class="timeline-list">${renderTimelineSection(viewModel.timelineEvents)}</div>
          </section>
        </div>
      </div>
    </main>
    <script id="narrative-data" type="application/json">${serializeForScript(viewModel)}</script>
    <script>
      const activeClass = "is-active";
      const mutedClass = "is-muted";
      const detailCard = document.getElementById("detail-card");
      const renderDetail = (payload) => {
        if (!detailCard) return;
        if (!payload) {
          detailCard.innerHTML = '<div class="detail-title">Detail</div><div class="detail-summary">선택된 항목이 없습니다.</div>';
          return;
        }
        const rows = [
          ["Path", payload.path || "none"],
          ["Artifact", payload.artifactId || "none"],
          ["Snapshot", payload.snapshotSha || "none"],
          ["Relation", payload.relationKind || "none"],
          ["Confidence", payload.confidence === null || payload.confidence === undefined ? "none" : String(payload.confidence)],
        ];
        detailCard.innerHTML = [
          '<div class="detail-title">' + (payload.title || 'Detail') + '</div>',
          '<div class="detail-summary">' + (payload.summary || '') + '</div>',
          '<div class="detail-list">' + rows.map(([label, value]) => '<div><span class="detail-meta">' + label + '</span>: ' + value + '</div>').join("") + '</div>',
        ].join("");
      };

      const syncThreadFocus = (threadId) => {
        const threadRefs = document.querySelectorAll("[data-thread-ref], [data-thread-refs]");
        if (!threadId) {
          threadRefs.forEach((element) => {
            element.classList.remove(activeClass);
            element.classList.remove(mutedClass);
          });
          return;
        }
        threadRefs.forEach((element) => {
          const refs = ((element.getAttribute("data-thread-ref") || "") + " " + (element.getAttribute("data-thread-refs") || "")).trim().split(/\\s+/).filter(Boolean);
          const matches = refs.includes(threadId);
          element.classList.toggle(activeClass, matches);
          element.classList.toggle(mutedClass, refs.length > 0 && !matches);
        });
      };

      document.querySelectorAll("[data-thread-focus]").forEach((element) => {
        element.addEventListener("click", () => {
          const threadId = element.getAttribute("data-thread-focus") || "";
          const detailRaw = element.getAttribute("data-detail");
          let detail = null;
          if (detailRaw) {
            try {
              detail = JSON.parse(detailRaw);
            } catch {}
          }
          syncThreadFocus(threadId || null);
          renderDetail(detail);
        });
      });
    </script>
  </body>
</html>`;

export const buildNarrativeViewModel = async (
  cwd: string,
  options: NarrativeOptions = {},
): Promise<{ result: NarrativeResult; viewModel: NarrativeViewModel; absoluteReportPath: string }> => {
  const maxCommits = options.maxCommits && options.maxCommits > 0 ? options.maxCommits : 10;
  const { headSha, snapshots, missingSnapshotCommits } = await collectSelectedSnapshots(cwd, options.revRange, maxCommits);
  const rawChangedNodes = await collectChangedDecisionNodes(cwd, snapshots);
  const candidateIntentItems = await collectCandidateIntentItems(cwd, snapshots, rawChangedNodes);
  const rawNodes = await addSupportNodes(cwd, snapshots, rawChangedNodes, candidateIntentItems);
  const nodes = await assignNarrativeThreads(cwd, rawNodes);
  const threads = buildThreads(nodes);
  const intentGroups = attachIntentItems(threads, candidateIntentItems);
  const eventRecords = await selectNarrativeEvents(cwd, snapshots);
  const timelineEvents = attachTimelineEvents(threads, eventRecords);
  const summary = toSummary(nodes, threads, [...intentGroups.assigned, ...intentGroups.unassigned], timelineEvents);
  const anchorSha = snapshots[0]?.commitSha ?? headSha;
  const outputTarget = resolveNarrativeOutput(cwd, anchorSha, options.output);
  const warnings: string[] = [];
  if (snapshots.length === 0) {
    warnings.push("selected window에 snapshot manifest가 없어 empty-state report를 생성합니다.");
  }
  const rawViewModel: NarrativeViewModel = {
    repoName: path.basename(cwd),
    headSha,
    generatedAt: new Date().toISOString(),
    window: {
      revRange: options.revRange ?? null,
      maxCommits,
      selectedSnapshotShas: snapshots.map((snapshot) => snapshot.commitSha),
      missingSnapshotCommits,
    },
    summary,
    snapshots: [...snapshots]
      .reverse()
      .map((snapshot) => ({
        commitSha: snapshot.commitSha,
        subject: snapshot.subject,
        authoredAt: snapshot.authoredAt,
        shortSha: shortSha(snapshot.commitSha),
      })),
    threads,
    nodes,
    intentItems: intentGroups.assigned,
    unassignedIntentItems: intentGroups.unassigned,
    timelineEvents,
    warnings,
    empty: snapshots.length === 0 || threads.length === 0,
  };
  const sanitizedViewModel = sanitizeStructuredValue(rawViewModel, "narrative.output", "narrative");
  const viewModel = sanitizedViewModel.value;
  const result: NarrativeResult = {
    dryRun: Boolean(options.dryRun),
    reportPath: outputTarget.displayPath,
    headSha,
    window: viewModel.window,
    summary: viewModel.summary,
    warnings: viewModel.warnings,
  };
  return {
    result,
    viewModel,
    absoluteReportPath: outputTarget.absolutePath,
  };
};

export const runNarrativeReport = async (cwd: string, options: NarrativeOptions = {}): Promise<NarrativeResult> => {
  const paths = resolveRagitPaths(cwd);
  const built = await buildNarrativeViewModel(cwd, options);
  if (!options.dryRun) {
    await mkdir(path.dirname(built.absoluteReportPath), { recursive: true });
    await writeFile(built.absoluteReportPath, renderNarrativeReport(built.viewModel), "utf8");
  }
  if (!options.output && built.result.reportPath.startsWith(".ragit/")) {
    await mkdir(paths.narrativeReportsDir, { recursive: true });
  }
  return built.result;
};

export const formatNarrativeText = (result: NarrativeResult): string =>
  [
    "# ragit narrative",
    `- dry_run: ${result.dryRun}`,
    `- report_path: ${result.reportPath}`,
    `- head: ${result.headSha}`,
    `- window_rev_range: ${result.window.revRange ?? "HEAD"}`,
    `- selected_snapshots: ${result.window.selectedSnapshotShas.length}`,
    `- missing_snapshot_commits: ${result.window.missingSnapshotCommits}`,
    `- decision_threads: ${result.summary.decisionThreads}`,
    `- decision_nodes: ${result.summary.decisionNodes}`,
    `- intent_items: ${result.summary.intentItems}`,
    `- timeline_events: ${result.summary.timelineEvents}`,
    `- heuristic_edges: ${result.summary.heuristicEdges}`,
    ...(result.warnings.length === 0 ? [] : ["", ...result.warnings.map((warning) => `- warning ${warning}`)]),
  ].join("\n");
