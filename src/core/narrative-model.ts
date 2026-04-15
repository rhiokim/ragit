import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { listArtifactRecords, loadArtifactRecord } from "./artifacts.js";
import { getHeadSha, listGitCommits } from "./git.js";
import { loadSnapshotManifestIfExists } from "./manifest.js";
import { buildRecoveryView } from "./recovery-view.js";
import {
  buildNarrativeRecoveryProfile,
  normalizeNarrativeRecoveryProfile,
  type NarrativeRecoveryProfile,
} from "./recovery-profile.js";
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
import { RAGIT_VERSION } from "./version.js";

export type { NarrativeRecoveryProfile } from "./recovery-profile.js";

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

export const NARRATIVE_MODEL_SCHEMA_VERSION = 1;
export const NARRATIVE_MODEL_LEGACY_PRODUCER_VERSION = "legacy-unversioned";
export const NARRATIVE_PROJECTION_POLICY_VERSION = 1;
export const NARRATIVE_PROJECTION_MODE = "viewer-safe";

export type NarrativeProjectionMode = typeof NARRATIVE_PROJECTION_MODE;
export type NarrativeTrustBadge = "durable-doc" | "reviewed-artifact" | "promoted-artifact" | "operational-event";
export type NarrativeSensitivityBadge = "standard" | "redacted" | "restricted";
export type NarrativeFreshnessStatus = "fresh" | "suspect" | "stale";
export type NarrativeValidationStatus = "verified" | "attention" | "unverified";

export interface NarrativeFreshnessCounts {
  fresh: number;
  suspect: number;
  stale: number;
}

export interface NarrativeValidationCounts {
  verified: number;
  attention: number;
  unverified: number;
}

export type NarrativeRecoverySource = "working-memory" | "latest-session" | "recall" | "narrative" | "none";
export type NarrativeRecoveryPriorityKind =
  | "constraint"
  | "open-loop"
  | "next-action"
  | "decision"
  | "retrieval-hit"
  | "thread"
  | "intent";
export type NarrativeRecoveryTrustKind = "thread" | "node" | "intent" | "event";
export type NarrativeRecoveryFormationKind = "snapshot" | "memory" | "decision" | "intent" | "event";

export interface NarrativeRecoveryPriorityItem {
  id: string;
  kind: NarrativeRecoveryPriorityKind;
  title: string;
  summary: string;
  source: NarrativeRecoverySource;
  threadId: string | null;
  path: string | null;
  artifactId: string | null;
  snapshotSha: string | null;
  freshnessStatus: NarrativeFreshnessStatus | null;
  validationStatus: NarrativeValidationStatus | null;
  trust: NarrativeTrustBadge | null;
  sensitivity: NarrativeSensitivityBadge | null;
  reasonCodes: string[];
  recommendedActions: string[];
}

export interface NarrativeRecoveryOpenLoop {
  id: string;
  title: string;
  status: string;
  nextAction: string;
  sourceSessionId: string | null;
  relatedFiles: string[];
}

export interface NarrativeRecoveryDecision {
  id: string;
  title: string;
  summary: string;
  relatedFiles: string[];
}

export interface NarrativeRecoveryHit {
  id: string;
  path: string;
  sectionTitle: string;
  excerpt: string;
  scoreFinal: number;
  originType: string;
  artifactId: string | null;
}

export interface NarrativeRecoveryRecoverNow {
  source: NarrativeRecoverySource;
  goal: string | null;
  summary: string | null;
  latestSessionId: string | null;
  episodeId: string | null;
  sourceHeadSha: string | null;
  updatedAt: string | null;
  constraints: string[];
  openLoops: NarrativeRecoveryOpenLoop[];
  nextActions: string[];
  durableDecisions: NarrativeRecoveryDecision[];
  retrievedHits: NarrativeRecoveryHit[];
  priorityItems: NarrativeRecoveryPriorityItem[];
}

export interface NarrativeRecoveryTrustItem {
  id: string;
  kind: NarrativeRecoveryTrustKind;
  title: string;
  summary: string;
  threadId: string | null;
  path: string | null;
  artifactId: string | null;
  snapshotSha: string | null;
  freshnessStatus: NarrativeFreshnessStatus | null;
  validationStatus: NarrativeValidationStatus | null;
  trust: NarrativeTrustBadge | null;
  sensitivity: NarrativeSensitivityBadge | null;
  lineage: string | null;
  reasonCodes: string[];
  evidenceRefs: string[];
  recommendedActions: string[];
}

export interface NarrativeRecoveryFormationStep {
  id: string;
  kind: NarrativeRecoveryFormationKind;
  title: string;
  summary: string;
  recordedAt: string | null;
  threadId: string | null;
  snapshotSha: string | null;
  path: string | null;
  artifactId: string | null;
  freshnessStatus: NarrativeFreshnessStatus | null;
  validationStatus: NarrativeValidationStatus | null;
  trust: NarrativeTrustBadge | null;
  sensitivity: NarrativeSensitivityBadge | null;
  lineage: string | null;
}

export interface NarrativeRecoveryView {
  recoverNow: NarrativeRecoveryRecoverNow;
  trustItems: NarrativeRecoveryTrustItem[];
  formationSteps: NarrativeRecoveryFormationStep[];
  warnings: string[];
}

export interface NarrativeOptions {
  revRange?: string;
  maxCommits?: number;
  output?: string;
  emitModel?: string;
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
  freshnessCounts: NarrativeFreshnessCounts;
  validationCounts: NarrativeValidationCounts;
}

export interface NarrativeResult {
  dryRun: boolean;
  reportPath: string;
  modelPath: string | null;
  headSha: string;
  window: NarrativeWindowSummary;
  summary: NarrativeSummary;
  recoverySource: NarrativeRecoverySource;
  recoveryGoal: string | null;
  recoveryPriorityItems: number;
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

export type NarrativeChangeType = "added" | "modified" | "deleted" | "related";
export type NarrativeRelationKind = "root" | "explicit" | "path-continuity" | "heuristic-high" | "heuristic-medium";

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

interface NarrativeSynthesisDecisionNode extends RawNarrativeDecisionNode {
  nodeId: string;
  threadId: string;
  predecessorNodeId: string | null;
  relationKind: NarrativeRelationKind;
  confidence: number;
  freshnessStatus: NarrativeFreshnessStatus | null;
  driftReasonCodes: string[];
  recommendedActions: string[];
  driftSourceRefs: string[];
  validationStatus: NarrativeValidationStatus | null;
  validationReasonCodes: string[];
  validationEvidenceRefs: string[];
  validationRecommendedActions: string[];
}

interface NarrativeSynthesisDecisionThread {
  threadId: string;
  title: string;
  docType: DocType;
  docPaths: string[];
  goalIds: string[];
  episodeIds: string[];
  sessionIds: string[];
  snapshotShas: string[];
  nodeIds: string[];
  freshnessStatus: NarrativeFreshnessStatus | null;
  driftReasonCodes: string[];
  recommendedActions: string[];
  driftSourceRefs: string[];
  validationStatus: NarrativeValidationStatus | null;
  validationReasonCodes: string[];
  validationEvidenceRefs: string[];
  validationRecommendedActions: string[];
}

interface NarrativeSynthesisIntentItem {
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
  freshnessStatus: NarrativeFreshnessStatus | null;
  driftReasonCodes: string[];
  recommendedActions: string[];
  driftSourceRefs: string[];
  validationStatus: NarrativeValidationStatus | null;
  validationReasonCodes: string[];
  validationEvidenceRefs: string[];
  validationRecommendedActions: string[];
}

interface NarrativeSynthesisEventItem {
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

export interface NarrativeBindingSummary {
  goalCount: number;
  episodeCount: number;
  sessionCount: number;
  relatedPathCount: number;
}

export interface NarrativeSnapshotItem {
  commitSha: string;
  subject: string;
  authoredAt: string;
  shortSha: string;
}

export interface NarrativeDecisionThread {
  threadId: string;
  title: string;
  docType: DocType;
  docPaths: string[];
  snapshotShas: string[];
  nodeIds: string[];
  binding: NarrativeBindingSummary;
  freshnessStatus: NarrativeFreshnessStatus | null;
  driftReasonCodes: string[];
  recommendedActions: string[];
  driftSourceRefs: string[];
  validationStatus: NarrativeValidationStatus | null;
  validationReasonCodes: string[];
  validationEvidenceRefs: string[];
  validationRecommendedActions: string[];
  badges: {
    trust: "durable-doc";
    sensitivity: NarrativeSensitivityBadge;
    lineageKinds: NarrativeRelationKind[];
  };
}

export interface NarrativeDecisionNode {
  nodeId: string;
  threadId: string;
  commitSha: string;
  authoredAt: string;
  path: string;
  docType: DocType;
  title: string;
  summary: string;
  changeType: NarrativeChangeType;
  sourceArtifactId: string | null;
  relatedPaths: string[];
  predecessorNodeId: string | null;
  relationKind: NarrativeRelationKind;
  confidence: number;
  binding: NarrativeBindingSummary;
  freshnessStatus: NarrativeFreshnessStatus | null;
  driftReasonCodes: string[];
  recommendedActions: string[];
  driftSourceRefs: string[];
  validationStatus: NarrativeValidationStatus | null;
  validationReasonCodes: string[];
  validationEvidenceRefs: string[];
  validationRecommendedActions: string[];
  badges: {
    trust: "durable-doc";
    sensitivity: NarrativeSensitivityBadge;
    lineage: NarrativeRelationKind;
  };
}

export interface NarrativeIntentItem {
  itemId: string;
  artifactId: string;
  kind: ArtifactRecord["kind"];
  status: ArtifactStatus;
  title: string;
  summary: string;
  anchorSha: string | null;
  relatedPaths: string[];
  createdAt: string;
  threadIds: string[];
  binding: NarrativeBindingSummary;
  freshnessStatus: NarrativeFreshnessStatus | null;
  driftReasonCodes: string[];
  recommendedActions: string[];
  driftSourceRefs: string[];
  validationStatus: NarrativeValidationStatus | null;
  validationReasonCodes: string[];
  validationEvidenceRefs: string[];
  validationRecommendedActions: string[];
  badges: {
    trust: "reviewed-artifact" | "promoted-artifact";
    sensitivity: NarrativeSensitivityBadge;
  };
}

export interface NarrativeEventItem {
  eventId: string;
  eventType: RagitEventType;
  recordedAt: string;
  summary: string;
  sourceHeadSha: string | null;
  relatedPaths: string[];
  threadIds: string[];
  binding: NarrativeBindingSummary;
  badges: {
    trust: "operational-event";
    sensitivity: NarrativeSensitivityBadge;
  };
}

export interface NarrativeViewModel {
  schemaVersion: number;
  producerVersion: string;
  projectionPolicyVersion: number;
  projectionMode: NarrativeProjectionMode;
  repoName: string;
  headSha: string;
  generatedAt: string;
  window: NarrativeWindowSummary;
  summary: NarrativeSummary;
  snapshots: NarrativeSnapshotItem[];
  threads: NarrativeDecisionThread[];
  nodes: NarrativeDecisionNode[];
  intentItems: NarrativeIntentItem[];
  unassignedIntentItems: NarrativeIntentItem[];
  timelineEvents: NarrativeEventItem[];
  recovery: NarrativeRecoveryProfile;
  recoveryProfile: NarrativeRecoveryView;
  warnings: string[];
  empty: boolean;
}

export interface NarrativeViewModelNormalizationResult {
  value: NarrativeViewModel | null;
  compatibility: "versioned" | "legacy-unversioned" | "invalid";
  warnings: string[];
}

export interface NarrativeBuildResult {
  result: NarrativeResult;
  viewModel: NarrativeViewModel;
  absoluteReportPath: string;
}

interface NarrativeSynthesisViewModel {
  repoName: string;
  headSha: string;
  generatedAt: string;
  window: NarrativeWindowSummary;
  summary: NarrativeSummary;
  snapshots: NarrativeSnapshotItem[];
  threads: NarrativeSynthesisDecisionThread[];
  nodes: NarrativeSynthesisDecisionNode[];
  intentItems: NarrativeSynthesisIntentItem[];
  unassignedIntentItems: NarrativeSynthesisIntentItem[];
  timelineEvents: NarrativeSynthesisEventItem[];
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

const emptyFreshnessCounts = (): NarrativeFreshnessCounts => ({
  fresh: 0,
  suspect: 0,
  stale: 0,
});

const emptyValidationCounts = (): NarrativeValidationCounts => ({
  verified: 0,
  attention: 0,
  unverified: 0,
});

const emptyRecoveryView = (): NarrativeRecoveryView => ({
  recoverNow: {
    source: "none",
    goal: null,
    summary: null,
    latestSessionId: null,
    episodeId: null,
    sourceHeadSha: null,
    updatedAt: null,
    constraints: [],
    openLoops: [],
    nextActions: [],
    durableDecisions: [],
    retrievedHits: [],
    priorityItems: [],
  },
  trustItems: [],
  formationSteps: [],
  warnings: [],
});

const emptyDriftOverlayFields = (): {
  freshnessStatus: NarrativeFreshnessStatus | null;
  driftReasonCodes: string[];
  recommendedActions: string[];
  driftSourceRefs: string[];
} => ({
  freshnessStatus: null,
  driftReasonCodes: [],
  recommendedActions: [],
  driftSourceRefs: [],
});

const emptyValidationOverlayFields = (): {
  validationStatus: NarrativeValidationStatus | null;
  validationReasonCodes: string[];
  validationEvidenceRefs: string[];
  validationRecommendedActions: string[];
} => ({
  validationStatus: null,
  validationReasonCodes: [],
  validationEvidenceRefs: [],
  validationRecommendedActions: [],
});

const coerceFreshnessCounts = (value: unknown): NarrativeFreshnessCounts => {
  if (!isPlainObject(value)) return emptyFreshnessCounts();
  return {
    fresh: typeof value.fresh === "number" && Number.isFinite(value.fresh) ? value.fresh : 0,
    suspect: typeof value.suspect === "number" && Number.isFinite(value.suspect) ? value.suspect : 0,
    stale: typeof value.stale === "number" && Number.isFinite(value.stale) ? value.stale : 0,
  };
};

const coerceValidationCounts = (value: unknown): NarrativeValidationCounts => {
  if (!isPlainObject(value)) return emptyValidationCounts();
  return {
    verified: typeof value.verified === "number" && Number.isFinite(value.verified) ? value.verified : 0,
    attention: typeof value.attention === "number" && Number.isFinite(value.attention) ? value.attention : 0,
    unverified: typeof value.unverified === "number" && Number.isFinite(value.unverified) ? value.unverified : 0,
  };
};

const coerceDriftOverlayFields = (
  value: unknown,
): {
  freshnessStatus: NarrativeFreshnessStatus | null;
  driftReasonCodes: string[];
  recommendedActions: string[];
  driftSourceRefs: string[];
} => {
  if (!isPlainObject(value)) return emptyDriftOverlayFields();
  return {
    freshnessStatus:
      value.freshnessStatus === "fresh" || value.freshnessStatus === "suspect" || value.freshnessStatus === "stale"
        ? value.freshnessStatus
        : null,
    driftReasonCodes: Array.isArray(value.driftReasonCodes)
      ? value.driftReasonCodes.filter((item): item is string => typeof item === "string")
      : [],
    recommendedActions: Array.isArray(value.recommendedActions)
      ? value.recommendedActions.filter((item): item is string => typeof item === "string")
      : [],
    driftSourceRefs: Array.isArray(value.driftSourceRefs)
      ? value.driftSourceRefs.filter((item): item is string => typeof item === "string")
      : [],
  };
};

const coerceValidationOverlayFields = (
  value: unknown,
): {
  validationStatus: NarrativeValidationStatus | null;
  validationReasonCodes: string[];
  validationEvidenceRefs: string[];
  validationRecommendedActions: string[];
} => {
  if (!isPlainObject(value)) return emptyValidationOverlayFields();
  return {
    validationStatus:
      value.validationStatus === "verified" || value.validationStatus === "attention" || value.validationStatus === "unverified"
        ? value.validationStatus
        : null,
    validationReasonCodes: Array.isArray(value.validationReasonCodes)
      ? value.validationReasonCodes.filter((item): item is string => typeof item === "string")
      : [],
    validationEvidenceRefs: Array.isArray(value.validationEvidenceRefs)
      ? value.validationEvidenceRefs.filter((item): item is string => typeof item === "string")
      : [],
    validationRecommendedActions: Array.isArray(value.validationRecommendedActions)
      ? value.validationRecommendedActions.filter((item): item is string => typeof item === "string")
      : [],
  };
};

const attachNarrativeDriftDefaults = <T extends object>(value: T): T & ReturnType<typeof emptyDriftOverlayFields> => ({
  ...value,
  ...coerceDriftOverlayFields(value),
});

const attachNarrativeValidationDefaults = <T extends object>(value: T): T & ReturnType<typeof emptyValidationOverlayFields> => ({
  ...value,
  ...coerceValidationOverlayFields(value),
});

const coerceRecoveryPriorityItems = (value: unknown): NarrativeRecoveryPriorityItem[] => {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => isPlainObject(item))
    .map((item) => ({
      id: typeof item.id === "string" ? item.id : "",
      kind:
        item.kind === "constraint" ||
        item.kind === "open-loop" ||
        item.kind === "next-action" ||
        item.kind === "decision" ||
        item.kind === "retrieval-hit" ||
        item.kind === "thread" ||
        item.kind === "intent"
          ? item.kind
          : "decision",
      title: typeof item.title === "string" ? item.title : "",
      summary: typeof item.summary === "string" ? item.summary : "",
      source:
        item.source === "working-memory" ||
        item.source === "latest-session" ||
        item.source === "recall" ||
        item.source === "narrative" ||
        item.source === "none"
          ? item.source
          : "none",
      threadId: typeof item.threadId === "string" ? item.threadId : null,
      path: typeof item.path === "string" ? item.path : null,
      artifactId: typeof item.artifactId === "string" ? item.artifactId : null,
      snapshotSha: typeof item.snapshotSha === "string" ? item.snapshotSha : null,
      ...coerceDriftOverlayFields(item),
      validationStatus: coerceValidationOverlayFields(item).validationStatus,
      trust:
        item.trust === "durable-doc" ||
        item.trust === "reviewed-artifact" ||
        item.trust === "promoted-artifact" ||
        item.trust === "operational-event"
          ? item.trust
          : null,
      sensitivity:
        item.sensitivity === "standard" || item.sensitivity === "redacted" || item.sensitivity === "restricted"
          ? item.sensitivity
          : null,
      reasonCodes: Array.isArray(item.reasonCodes) ? item.reasonCodes.filter((entry): entry is string => typeof entry === "string") : [],
      recommendedActions: Array.isArray(item.recommendedActions)
        ? item.recommendedActions.filter((entry): entry is string => typeof entry === "string")
        : [],
    }));
};

const coerceRecoveryOpenLoops = (value: unknown): NarrativeRecoveryOpenLoop[] => {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => isPlainObject(item))
    .map((item) => ({
      id: typeof item.id === "string" ? item.id : "",
      title: typeof item.title === "string" ? item.title : "",
      status: typeof item.status === "string" ? item.status : "open",
      nextAction: typeof item.nextAction === "string" ? item.nextAction : "",
      sourceSessionId: typeof item.sourceSessionId === "string" ? item.sourceSessionId : null,
      relatedFiles: Array.isArray(item.relatedFiles)
        ? item.relatedFiles.filter((entry): entry is string => typeof entry === "string")
        : [],
    }));
};

const coerceRecoveryDecisions = (value: unknown): NarrativeRecoveryDecision[] => {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => isPlainObject(item))
    .map((item) => ({
      id: typeof item.id === "string" ? item.id : "",
      title: typeof item.title === "string" ? item.title : "",
      summary: typeof item.summary === "string" ? item.summary : "",
      relatedFiles: Array.isArray(item.relatedFiles)
        ? item.relatedFiles.filter((entry): entry is string => typeof entry === "string")
        : [],
    }));
};

const coerceRecoveryHits = (value: unknown): NarrativeRecoveryHit[] => {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => isPlainObject(item))
    .map((item) => ({
      id: typeof item.id === "string" ? item.id : "",
      path: typeof item.path === "string" ? item.path : "",
      sectionTitle: typeof item.sectionTitle === "string" ? item.sectionTitle : "",
      excerpt: typeof item.excerpt === "string" ? item.excerpt : "",
      scoreFinal: typeof item.scoreFinal === "number" && Number.isFinite(item.scoreFinal) ? item.scoreFinal : 0,
      originType: typeof item.originType === "string" ? item.originType : "document",
      artifactId: typeof item.artifactId === "string" ? item.artifactId : null,
    }));
};

const coerceRecoveryTrustItems = (value: unknown): NarrativeRecoveryTrustItem[] => {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => isPlainObject(item))
    .map((item) => {
      const validation = coerceValidationOverlayFields(item);
      return {
        id: typeof item.id === "string" ? item.id : "",
        kind: item.kind === "thread" || item.kind === "node" || item.kind === "intent" || item.kind === "event" ? item.kind : "thread",
        title: typeof item.title === "string" ? item.title : "",
        summary: typeof item.summary === "string" ? item.summary : "",
        threadId: typeof item.threadId === "string" ? item.threadId : null,
        path: typeof item.path === "string" ? item.path : null,
        artifactId: typeof item.artifactId === "string" ? item.artifactId : null,
        snapshotSha: typeof item.snapshotSha === "string" ? item.snapshotSha : null,
        ...coerceDriftOverlayFields(item),
        validationStatus: validation.validationStatus,
        trust:
          item.trust === "durable-doc" ||
          item.trust === "reviewed-artifact" ||
          item.trust === "promoted-artifact" ||
          item.trust === "operational-event"
            ? item.trust
            : null,
        sensitivity:
          item.sensitivity === "standard" || item.sensitivity === "redacted" || item.sensitivity === "restricted"
            ? item.sensitivity
            : null,
        lineage: typeof item.lineage === "string" ? item.lineage : null,
        reasonCodes: Array.isArray(item.reasonCodes) ? item.reasonCodes.filter((entry): entry is string => typeof entry === "string") : [],
        evidenceRefs: Array.isArray(item.evidenceRefs)
          ? item.evidenceRefs.filter((entry): entry is string => typeof entry === "string")
          : [],
        recommendedActions: Array.isArray(item.recommendedActions)
          ? item.recommendedActions.filter((entry): entry is string => typeof entry === "string")
          : [],
      };
    });
};

const coerceRecoveryFormationSteps = (value: unknown): NarrativeRecoveryFormationStep[] => {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => isPlainObject(item))
    .map((item) => {
      const validation = coerceValidationOverlayFields(item);
      return {
        id: typeof item.id === "string" ? item.id : "",
        kind:
          item.kind === "memory" || item.kind === "decision" || item.kind === "intent" || item.kind === "event"
            ? item.kind
            : "event",
        title: typeof item.title === "string" ? item.title : "",
        summary: typeof item.summary === "string" ? item.summary : "",
        recordedAt: typeof item.recordedAt === "string" ? item.recordedAt : null,
        threadId: typeof item.threadId === "string" ? item.threadId : null,
        snapshotSha: typeof item.snapshotSha === "string" ? item.snapshotSha : null,
        path: typeof item.path === "string" ? item.path : null,
        artifactId: typeof item.artifactId === "string" ? item.artifactId : null,
        ...coerceDriftOverlayFields(item),
        validationStatus: validation.validationStatus,
        trust:
          item.trust === "durable-doc" ||
          item.trust === "reviewed-artifact" ||
          item.trust === "promoted-artifact" ||
          item.trust === "operational-event"
            ? item.trust
            : null,
        sensitivity:
          item.sensitivity === "standard" || item.sensitivity === "redacted" || item.sensitivity === "restricted"
            ? item.sensitivity
            : null,
        lineage: typeof item.lineage === "string" ? item.lineage : null,
      };
    });
};

const coerceRecoveryView = (value: unknown): NarrativeRecoveryView => {
  if (!isPlainObject(value)) return emptyRecoveryView();
  const fallback = emptyRecoveryView();
  const recoverNowValue = isPlainObject(value.recoverNow) ? value.recoverNow : {};
  return {
    recoverNow: {
      source:
        recoverNowValue.source === "working-memory" ||
        recoverNowValue.source === "latest-session" ||
        recoverNowValue.source === "recall" ||
        recoverNowValue.source === "narrative" ||
        recoverNowValue.source === "none"
          ? recoverNowValue.source
          : fallback.recoverNow.source,
      goal: typeof recoverNowValue.goal === "string" ? recoverNowValue.goal : fallback.recoverNow.goal,
      summary: typeof recoverNowValue.summary === "string" ? recoverNowValue.summary : fallback.recoverNow.summary,
      latestSessionId:
        typeof recoverNowValue.latestSessionId === "string" ? recoverNowValue.latestSessionId : fallback.recoverNow.latestSessionId,
      episodeId: typeof recoverNowValue.episodeId === "string" ? recoverNowValue.episodeId : fallback.recoverNow.episodeId,
      sourceHeadSha:
        typeof recoverNowValue.sourceHeadSha === "string" ? recoverNowValue.sourceHeadSha : fallback.recoverNow.sourceHeadSha,
      updatedAt: typeof recoverNowValue.updatedAt === "string" ? recoverNowValue.updatedAt : fallback.recoverNow.updatedAt,
      constraints: Array.isArray(recoverNowValue.constraints)
        ? recoverNowValue.constraints.filter((entry): entry is string => typeof entry === "string")
        : [],
      openLoops: coerceRecoveryOpenLoops(recoverNowValue.openLoops),
      nextActions: Array.isArray(recoverNowValue.nextActions)
        ? recoverNowValue.nextActions.filter((entry): entry is string => typeof entry === "string")
        : [],
      durableDecisions: coerceRecoveryDecisions(recoverNowValue.durableDecisions),
      retrievedHits: coerceRecoveryHits(recoverNowValue.retrievedHits),
      priorityItems: coerceRecoveryPriorityItems(recoverNowValue.priorityItems),
    },
    trustItems: coerceRecoveryTrustItems(value.trustItems),
    formationSteps: coerceRecoveryFormationSteps(value.formationSteps),
    warnings: Array.isArray(value.warnings) ? value.warnings.filter((entry): entry is string => typeof entry === "string") : [],
  };
};

const hasNarrativeViewModelCoreShape = (value: Record<string, unknown>): boolean =>
  typeof value.repoName === "string" &&
  typeof value.headSha === "string" &&
  typeof value.generatedAt === "string" &&
  isPlainObject(value.window) &&
  isPlainObject(value.summary) &&
  Array.isArray(value.snapshots) &&
  Array.isArray(value.threads) &&
  Array.isArray(value.nodes) &&
  Array.isArray(value.intentItems) &&
  Array.isArray(value.unassignedIntentItems) &&
  Array.isArray(value.timelineEvents) &&
  Array.isArray(value.warnings) &&
  typeof value.empty === "boolean";

export const normalizeNarrativeViewModel = (
  value: unknown,
): NarrativeViewModelNormalizationResult => {
  if (!isPlainObject(value) || !hasNarrativeViewModelCoreShape(value)) {
    return {
      value: null,
      compatibility: "invalid",
      warnings: ["narrative model payload shape is invalid"],
    };
  }

  if (typeof value.schemaVersion !== "number" || !Number.isInteger(value.schemaVersion)) {
    const legacyValue = value as Omit<
      NarrativeViewModel,
      "schemaVersion" | "producerVersion" | "projectionPolicyVersion" | "projectionMode"
    >;
    return {
      value: {
        schemaVersion: NARRATIVE_MODEL_SCHEMA_VERSION,
        producerVersion: NARRATIVE_MODEL_LEGACY_PRODUCER_VERSION,
        projectionPolicyVersion: NARRATIVE_PROJECTION_POLICY_VERSION,
        projectionMode: NARRATIVE_PROJECTION_MODE,
        ...legacyValue,
        summary: {
          ...legacyValue.summary,
          freshnessCounts: coerceFreshnessCounts((legacyValue.summary as unknown as Record<string, unknown>).freshnessCounts),
          validationCounts: coerceValidationCounts(
            (legacyValue.summary as unknown as Record<string, unknown>).validationCounts,
          ),
        },
        threads: Array.isArray(legacyValue.threads)
          ? (legacyValue.threads.map((thread) => attachNarrativeValidationDefaults(attachNarrativeDriftDefaults(thread))) as NarrativeDecisionThread[])
          : [],
        nodes: Array.isArray(legacyValue.nodes)
          ? (legacyValue.nodes.map((node) => attachNarrativeValidationDefaults(attachNarrativeDriftDefaults(node))) as NarrativeDecisionNode[])
          : [],
        intentItems: Array.isArray(legacyValue.intentItems)
          ? (legacyValue.intentItems.map((item) => attachNarrativeValidationDefaults(attachNarrativeDriftDefaults(item))) as NarrativeIntentItem[])
          : [],
        unassignedIntentItems: Array.isArray(legacyValue.unassignedIntentItems)
          ? (legacyValue.unassignedIntentItems.map((item) => attachNarrativeValidationDefaults(attachNarrativeDriftDefaults(item))) as NarrativeIntentItem[])
          : [],
        timelineEvents: Array.isArray(legacyValue.timelineEvents) ? legacyValue.timelineEvents : [],
        recovery: normalizeNarrativeRecoveryProfile(
          (legacyValue as Record<string, unknown>).recovery ?? (legacyValue as Record<string, unknown>).recoveryProfile,
        ),
      },
      compatibility: "legacy-unversioned",
      warnings: ["narrative model payload had no schemaVersion and was coerced as legacy-unversioned"],
    };
  }

  const warnings: string[] = [];
  if (typeof value.projectionPolicyVersion !== "number" || !Number.isInteger(value.projectionPolicyVersion)) {
    warnings.push("narrative model payload had no projectionPolicyVersion and was coerced to the current viewer-safe policy");
  }
  if (value.projectionMode !== NARRATIVE_PROJECTION_MODE) {
    warnings.push("narrative model payload had no supported projectionMode and was coerced to viewer-safe");
  }

  return {
    value: {
      ...((value as unknown) as NarrativeViewModel),
      producerVersion:
        typeof value.producerVersion === "string" && value.producerVersion.trim().length > 0
          ? value.producerVersion
          : "unknown",
      projectionPolicyVersion:
        typeof value.projectionPolicyVersion === "number" && Number.isInteger(value.projectionPolicyVersion)
          ? value.projectionPolicyVersion
          : NARRATIVE_PROJECTION_POLICY_VERSION,
      projectionMode: value.projectionMode === NARRATIVE_PROJECTION_MODE ? value.projectionMode : NARRATIVE_PROJECTION_MODE,
      summary: {
        ...(value.summary as NarrativeSummary),
        freshnessCounts: coerceFreshnessCounts((value.summary as unknown as Record<string, unknown>).freshnessCounts),
        validationCounts: coerceValidationCounts((value.summary as unknown as Record<string, unknown>).validationCounts),
      },
      threads: Array.isArray(value.threads)
        ? value.threads.map((thread) => attachNarrativeValidationDefaults(attachNarrativeDriftDefaults(thread)))
        : [],
      nodes: Array.isArray(value.nodes)
        ? value.nodes.map((node) => attachNarrativeValidationDefaults(attachNarrativeDriftDefaults(node)))
        : [],
      intentItems: Array.isArray(value.intentItems)
        ? value.intentItems.map((item) => attachNarrativeValidationDefaults(attachNarrativeDriftDefaults(item)))
        : [],
      unassignedIntentItems: Array.isArray(value.unassignedIntentItems)
        ? value.unassignedIntentItems.map((item) => attachNarrativeValidationDefaults(attachNarrativeDriftDefaults(item)))
        : [],
      timelineEvents: Array.isArray(value.timelineEvents) ? value.timelineEvents : [],
      recovery: normalizeNarrativeRecoveryProfile(value.recovery ?? value.recoveryProfile),
    },
    compatibility: "versioned",
    warnings,
  };
};

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
): Promise<NarrativeSynthesisIntentItem[]> => {
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
      ...emptyDriftOverlayFields(),
      ...emptyValidationOverlayFields(),
    }));
};

const addSupportNodes = async (
  cwd: string,
  snapshots: SelectedSnapshot[],
  rawNodes: RawNarrativeDecisionNode[],
  intentItems: NarrativeSynthesisIntentItem[],
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
  olderNodes: NarrativeSynthesisDecisionNode[],
): NarrativeSynthesisDecisionNode | null =>
  [...olderNodes].reverse().find((candidate) => candidate.path === current.path) ?? null;

const buildExplicitPredecessor = async (
  cwd: string,
  current: RawNarrativeDecisionNode,
  olderNodes: NarrativeSynthesisDecisionNode[],
): Promise<NarrativeSynthesisDecisionNode | null> => {
  if (!current.sourceArtifactId) return null;
  const artifact = await loadArtifactRecord(cwd, current.sourceArtifactId);
  if (!artifact || artifact.supersedes.length === 0) return null;
  return [...olderNodes].reverse().find((candidate) => candidate.sourceArtifactId && artifact.supersedes.includes(candidate.sourceArtifactId)) ?? null;
};

const buildHeuristicPredecessor = (
  current: RawNarrativeDecisionNode,
  olderNodes: NarrativeSynthesisDecisionNode[],
): { predecessor: NarrativeSynthesisDecisionNode | null; relationKind: NarrativeRelationKind } => {
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

const assignNarrativeThreads = async (
  cwd: string,
  rawNodes: RawNarrativeDecisionNode[],
): Promise<NarrativeSynthesisDecisionNode[]> => {
  const ordered = [...rawNodes].sort((left, right) => {
    if (left.snapshotIndex !== right.snapshotIndex) return left.snapshotIndex - right.snapshotIndex;
    return left.path.localeCompare(right.path);
  });
  const nodes: NarrativeSynthesisDecisionNode[] = [];

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
      ...emptyDriftOverlayFields(),
      ...emptyValidationOverlayFields(),
    });
  }

  return nodes;
};

const buildThreads = (nodes: NarrativeSynthesisDecisionNode[]): NarrativeSynthesisDecisionThread[] => {
  const byThread = new Map<string, NarrativeSynthesisDecisionNode[]>();
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
        ...emptyDriftOverlayFields(),
        ...emptyValidationOverlayFields(),
      };
    })
    .sort((left, right) => left.title.localeCompare(right.title));
};

const attachIntentItems = (
  threads: NarrativeSynthesisDecisionThread[],
  intentItems: NarrativeSynthesisIntentItem[],
): {
  assigned: NarrativeSynthesisIntentItem[];
  unassigned: NarrativeSynthesisIntentItem[];
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
      ...emptyDriftOverlayFields(),
      ...emptyValidationOverlayFields(),
    };
  });
  return {
    assigned: attached.filter((item) => item.threadIds.length > 0),
    unassigned: attached.filter((item) => item.threadIds.length === 0),
  };
};

const attachTimelineEvents = (
  threads: NarrativeSynthesisDecisionThread[],
  events: RagitEventRecord[],
): NarrativeSynthesisEventItem[] =>
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
  const eventDir = path.join(cwd, ".ragit", "log", "events");
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
  nodes: NarrativeSynthesisDecisionNode[],
  threads: NarrativeSynthesisDecisionThread[],
  intentItems: NarrativeSynthesisIntentItem[],
  timelineEvents: NarrativeSynthesisEventItem[],
): NarrativeSummary => ({
  decisionThreads: threads.length,
  decisionNodes: nodes.length,
  intentItems: intentItems.length,
  timelineEvents: timelineEvents.length,
  heuristicEdges: nodes.filter((node) => node.relationKind === "heuristic-high" || node.relationKind === "heuristic-medium").length,
  freshnessCounts: emptyFreshnessCounts(),
  validationCounts: emptyValidationCounts(),
});

const toBindingSummary = (input: {
  goalCount: number;
  episodeCount: number;
  sessionCount: number;
  relatedPathCount: number;
}): NarrativeBindingSummary => ({
  goalCount: input.goalCount,
  episodeCount: input.episodeCount,
  sessionCount: input.sessionCount,
  relatedPathCount: input.relatedPathCount,
});

const toSensitivityBadge = (restricted: boolean, applied: boolean): NarrativeSensitivityBadge =>
  restricted ? "restricted" : applied ? "redacted" : "standard";

const projectSnapshotForViewerSafe = (snapshot: NarrativeSnapshotItem): NarrativeSnapshotItem =>
  sanitizeStructuredValue(snapshot, "narrative.output", `narrative.snapshot:${snapshot.commitSha}`).value as NarrativeSnapshotItem;

const projectDecisionNodeForViewerSafe = (node: NarrativeSynthesisDecisionNode): NarrativeDecisionNode => {
  const binding = toBindingSummary({
    goalCount: node.goalId ? 1 : 0,
    episodeCount: node.episodeId ? 1 : 0,
    sessionCount: node.sourceSessionId ? 1 : 0,
    relatedPathCount: node.relatedPaths.length,
  });
  const projected = {
    nodeId: node.nodeId,
    threadId: node.threadId,
    commitSha: node.commitSha,
    authoredAt: node.authoredAt,
    path: node.path,
    docType: node.docType,
    title: node.title,
    summary: node.summary,
    changeType: node.changeType,
    sourceArtifactId: node.sourceArtifactId,
    relatedPaths: node.relatedPaths,
    predecessorNodeId: node.predecessorNodeId,
    relationKind: node.relationKind,
    confidence: node.confidence,
  };
  const sanitized = sanitizeStructuredValue(projected, "narrative.output", `narrative.node:${node.nodeId}`);
  return {
    ...(sanitized.value as typeof projected),
    binding,
    ...emptyDriftOverlayFields(),
    ...emptyValidationOverlayFields(),
    badges: {
      trust: "durable-doc",
      sensitivity: toSensitivityBadge(binding.goalCount + binding.episodeCount + binding.sessionCount > 0, sanitized.summary.applied),
      lineage: node.relationKind,
    },
  };
};

const projectThreadForViewerSafe = (
  thread: NarrativeSynthesisDecisionThread,
  nodes: NarrativeSynthesisDecisionNode[],
): NarrativeDecisionThread => {
  const binding = toBindingSummary({
    goalCount: thread.goalIds.length,
    episodeCount: thread.episodeIds.length,
    sessionCount: thread.sessionIds.length,
    relatedPathCount: uniqueStrings(
      nodes.filter((node) => node.threadId === thread.threadId).flatMap((node) => node.relatedPaths),
    ).length,
  });
  const projected = {
    threadId: thread.threadId,
    title: thread.title,
    docType: thread.docType,
    docPaths: thread.docPaths,
    snapshotShas: thread.snapshotShas,
    nodeIds: thread.nodeIds,
  };
  const sanitized = sanitizeStructuredValue(projected, "narrative.output", `narrative.thread:${thread.threadId}`);
  return {
    ...(sanitized.value as typeof projected),
    binding,
    ...emptyDriftOverlayFields(),
    ...emptyValidationOverlayFields(),
    badges: {
      trust: "durable-doc",
      sensitivity: toSensitivityBadge(binding.goalCount + binding.episodeCount + binding.sessionCount > 0, sanitized.summary.applied),
      lineageKinds: uniqueStrings(nodes.filter((node) => node.threadId === thread.threadId).map((node) => node.relationKind)) as NarrativeRelationKind[],
    },
  };
};

const projectIntentItemForViewerSafe = (item: NarrativeSynthesisIntentItem): NarrativeIntentItem => {
  const binding = toBindingSummary({
    goalCount: item.goalId ? 1 : 0,
    episodeCount: item.episodeId ? 1 : 0,
    sessionCount: item.sourceSessionId ? 1 : 0,
    relatedPathCount: item.relatedPaths.length,
  });
  const projected = {
    itemId: item.itemId,
    artifactId: item.artifactId,
    kind: item.kind,
    status: item.status,
    title: item.title,
    summary: item.summary,
    anchorSha: item.anchorSha,
    relatedPaths: item.relatedPaths,
    createdAt: item.createdAt,
    threadIds: item.threadIds,
  };
  const sanitized = sanitizeStructuredValue(projected, "narrative.output", `narrative.intent:${item.itemId}`);
  return {
    ...(sanitized.value as typeof projected),
    binding,
    ...emptyDriftOverlayFields(),
    ...emptyValidationOverlayFields(),
    badges: {
      trust: item.status === "promoted" ? "promoted-artifact" : "reviewed-artifact",
      sensitivity: toSensitivityBadge(binding.goalCount + binding.episodeCount + binding.sessionCount > 0, sanitized.summary.applied),
    },
  };
};

const projectEventItemForViewerSafe = (event: NarrativeSynthesisEventItem): NarrativeEventItem => {
  const binding = toBindingSummary({
    goalCount: event.goalId ? 1 : 0,
    episodeCount: event.episodeId ? 1 : 0,
    sessionCount: event.sessionId ? 1 : 0,
    relatedPathCount: event.relatedPaths.length,
  });
  const projected = {
    eventId: event.eventId,
    eventType: event.eventType,
    recordedAt: event.recordedAt,
    summary: event.summary,
    sourceHeadSha: event.sourceHeadSha,
    relatedPaths: event.relatedPaths,
    threadIds: event.threadIds,
  };
  const sanitized = sanitizeStructuredValue(projected, "narrative.output", `narrative.event:${event.eventId}`);
  return {
    ...(sanitized.value as typeof projected),
    binding,
    badges: {
      trust: "operational-event",
      sensitivity: toSensitivityBadge(binding.goalCount + binding.episodeCount + binding.sessionCount > 0, sanitized.summary.applied),
    },
  };
};

export const projectNarrativeViewModelForViewerSafe = async (
  cwd: string,
  synthesis: NarrativeSynthesisViewModel,
): Promise<NarrativeViewModel> => {
  const snapshots = synthesis.snapshots.map(projectSnapshotForViewerSafe);
  const nodes = synthesis.nodes.map(projectDecisionNodeForViewerSafe);
  const threads = synthesis.threads.map((thread) => projectThreadForViewerSafe(thread, synthesis.nodes));
  const intentItems = synthesis.intentItems.map(projectIntentItemForViewerSafe);
  const unassignedIntentItems = synthesis.unassignedIntentItems.map(projectIntentItemForViewerSafe);
  const timelineEvents = synthesis.timelineEvents.map(projectEventItemForViewerSafe);
  const warnings = (sanitizeStructuredValue(
    synthesis.warnings,
    "narrative.output",
    "narrative.warnings",
  ).value ?? []) as string[];

  const baseViewModel = {
    schemaVersion: NARRATIVE_MODEL_SCHEMA_VERSION,
    producerVersion: RAGIT_VERSION,
    projectionPolicyVersion: NARRATIVE_PROJECTION_POLICY_VERSION,
    projectionMode: NARRATIVE_PROJECTION_MODE,
    repoName: synthesis.repoName,
    headSha: synthesis.headSha,
    generatedAt: synthesis.generatedAt,
    window: synthesis.window,
    summary: synthesis.summary,
    snapshots,
    threads,
    nodes,
    intentItems,
    unassignedIntentItems,
    timelineEvents,
    warnings,
    empty: synthesis.empty,
  } satisfies Omit<NarrativeViewModel, "recovery" | "recoveryProfile">;
  const recoveryProfile = await buildRecoveryView(cwd, baseViewModel);
  const recovery = await buildNarrativeRecoveryProfile(cwd, baseViewModel, recoveryProfile);
  return {
    ...baseViewModel,
    recovery,
    recoveryProfile,
  };
};

export const buildNarrativeViewModel = async (
  cwd: string,
  options: NarrativeOptions = {},
): Promise<NarrativeBuildResult> => {
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
  const synthesis: NarrativeSynthesisViewModel = {
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
  const viewModel = await projectNarrativeViewModelForViewerSafe(cwd, synthesis);
  const result: NarrativeResult = {
    dryRun: Boolean(options.dryRun),
    reportPath: outputTarget.displayPath,
    modelPath: null,
    headSha,
    window: viewModel.window,
    summary: viewModel.summary,
    recoverySource: viewModel.recovery.recoverNow.source,
    recoveryGoal: viewModel.recovery.recoverNow.currentGoal,
    recoveryPriorityItems: viewModel.recovery.recoverNow.items.length,
    warnings: viewModel.warnings,
  };
  return {
    result,
    viewModel,
    absoluteReportPath: outputTarget.absolutePath,
  };
};
