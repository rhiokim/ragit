import { readFile } from "node:fs/promises";
import path from "node:path";

export type FilterScope = "all" | "recover" | "trust" | "formation";
export const NARRATIVE_MODEL_SCHEMA_VERSION = 1;
export const NARRATIVE_MODEL_LEGACY_PRODUCER_VERSION = "legacy-unversioned";
export const NARRATIVE_PROJECTION_POLICY_VERSION = 1;
export const NARRATIVE_PROJECTION_MODE = "viewer-safe";
export type NarrativeProjectionMode = typeof NARRATIVE_PROJECTION_MODE;
export type NarrativeTrustBadge = "durable-doc" | "reviewed-artifact" | "promoted-artifact" | "operational-event";
export type NarrativeSensitivityBadge = "standard" | "redacted" | "restricted";
export type NarrativeFreshnessStatus = "fresh" | "suspect" | "stale";
export type NarrativeValidationStatus = "verified" | "attention" | "unverified";
export type NarrativeRecoverySource = "working-memory" | "latest-session" | "recall" | "narrative" | "none";

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

export interface RecoveryNowItem {
  itemId: string;
  kind:
    | "working-goal"
    | "working-summary"
    | "latest-session"
    | "open-loop"
    | "next-action"
    | "stable-decision"
    | "retrieval-hit"
    | "constraint"
    | "decision"
    | "thread"
    | "intent";
  title: string;
  summary: string;
  rank: number;
  source: NarrativeRecoverySource;
  sourceRef: string;
  snapshotSha: string | null;
  threadId: string | null;
  nodeId: string | null;
  relatedPaths: string[];
  status: string | null;
}

export interface RecoveryTrustItem {
  itemId: string;
  kind: "thread" | "node" | "intent" | "event";
  title: string;
  summary: string;
  rank: number;
  threadId: string | null;
  freshnessStatus: NarrativeFreshnessStatus | null;
  validationStatus: NarrativeValidationStatus | null;
  trustBadge: NarrativeTrustBadge | null;
  sensitivity: NarrativeSensitivityBadge | null;
  lineageKinds: string[];
  sourceRef: string;
  relatedPaths: string[];
  reasonCodes: string[];
  evidenceRefs: string[];
  recommendedActions: string[];
}

export interface RecoveryFormationStep {
  itemId: string;
  kind: "snapshot" | "thread" | "intent" | "event" | "memory" | "decision";
  title: string;
  summary: string;
  rank: number;
  refId: string;
  when: string | null;
  relatedPaths: string[];
  threadId: string | null;
}

export interface NarrativeRecoveryProfile {
  recoverNow: {
    source: NarrativeRecoverySource;
    items: RecoveryNowItem[];
    currentGoal: string | null;
    currentSummary: string | null;
    latestSessionId: string | null;
    openLoopCount: number;
    nextActionCount: number;
    stableDecisionCount: number;
  };
  whatToTrust: {
    items: RecoveryTrustItem[];
    freshnessCounts: NarrativeFreshnessCounts;
    validationCounts: NarrativeValidationCounts;
  };
  howWeGotHere: {
    steps: RecoveryFormationStep[];
    snapshotCount: number;
    threadCount: number;
    intentCount: number;
    eventCount: number;
  };
  empty: boolean;
}

export interface NarrativeModel {
  schemaVersion: number;
  producerVersion: string;
  projectionPolicyVersion: number;
  projectionMode: NarrativeProjectionMode;
  repoName: string;
  headSha: string;
  generatedAt: string;
  summary: {
    decisionThreads: number;
    decisionNodes: number;
    intentItems: number;
    timelineEvents: number;
    heuristicEdges: number;
    freshnessCounts: NarrativeFreshnessCounts;
    validationCounts: NarrativeValidationCounts;
  };
  window: {
    revRange: string | null;
    maxCommits: number;
    selectedSnapshotShas: string[];
    missingSnapshotCommits: number;
  };
  snapshots: Array<{
    commitSha: string;
    subject: string;
    authoredAt: string;
    shortSha: string;
  }>;
  threads: Array<{
    threadId: string;
    title: string;
    docType: string;
    docPaths: string[];
    snapshotShas: string[];
    nodeIds: string[];
    binding: {
      goalCount: number;
      episodeCount: number;
      sessionCount: number;
      relatedPathCount: number;
    };
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
      lineageKinds: string[];
    };
  }>;
  nodes: Array<{
    nodeId: string;
    threadId: string;
    commitSha: string;
    authoredAt: string;
    path: string;
    title: string;
    summary: string;
    changeType: string;
    relationKind: string;
    confidence: number;
    docType: string;
    relatedPaths?: string[];
    sourceArtifactId?: string | null;
    predecessorNodeId?: string | null;
    binding: {
      goalCount: number;
      episodeCount: number;
      sessionCount: number;
      relatedPathCount: number;
    };
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
      lineage: string;
    };
  }>;
  intentItems: Array<{
    itemId: string;
    artifactId?: string;
    kind: string;
    status: string;
    title: string;
    summary: string;
    anchorSha?: string | null;
    relatedPaths?: string[];
    createdAt: string;
    threadIds?: string[];
    binding: {
      goalCount: number;
      episodeCount: number;
      sessionCount: number;
      relatedPathCount: number;
    };
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
  }>;
  unassignedIntentItems: Array<{
    itemId: string;
    artifactId?: string;
    kind: string;
    status: string;
    title: string;
    summary: string;
    anchorSha?: string | null;
    relatedPaths?: string[];
    createdAt: string;
    threadIds?: string[];
    binding: {
      goalCount: number;
      episodeCount: number;
      sessionCount: number;
      relatedPathCount: number;
    };
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
  }>;
  timelineEvents: Array<{
    eventId: string;
    eventType: string;
    recordedAt: string;
    summary: string;
    sourceHeadSha?: string | null;
    relatedPaths?: string[];
    threadIds?: string[];
    binding: {
      goalCount: number;
      episodeCount: number;
      sessionCount: number;
      relatedPathCount: number;
    };
    badges: {
      trust: "operational-event";
      sensitivity: NarrativeSensitivityBadge;
    };
  }>;
  recovery: NarrativeRecoveryProfile;
  warnings: string[];
  empty: boolean;
}

export interface ExplorerState {
  query: string;
  scope: FilterScope;
  selectedRecoveryItemId: string | null;
  selectedTrustItemId: string | null;
  selectedFormationStepId: string | null;
}

export interface ExplorerThreadView {
  threadId: string;
  title: string;
  docType: string;
  docPaths: string[];
  snapshotShas: string[];
  nodeIds: string[];
  nodes: NarrativeModel["nodes"];
  binding: NarrativeModel["threads"][number]["binding"];
  freshnessStatus: NarrativeFreshnessStatus | null;
  driftReasonCodes: string[];
  recommendedActions: string[];
  driftSourceRefs: string[];
  validationStatus: NarrativeValidationStatus | null;
  validationReasonCodes: string[];
  validationEvidenceRefs: string[];
  validationRecommendedActions: string[];
  badges: NarrativeModel["threads"][number]["badges"];
  relationKinds: string[];
  searchText: string;
}

export interface ExplorerRecoveryItemView extends RecoveryNowItem {
  linkedThread: ExplorerThreadView | null;
  searchText: string;
}

export interface ExplorerTrustItemView extends RecoveryTrustItem {
  linkedThread: ExplorerThreadView | null;
  searchText: string;
}

export interface ExplorerFormationStepView extends RecoveryFormationStep {
  linkedThread: ExplorerThreadView | null;
  searchText: string;
}

export interface ExplorerDetail {
  kind: "recovery" | "trust" | "formation" | "thread" | "empty";
  title: string;
  summary: string;
  path: string;
  artifactId: string;
  snapshotSha: string;
  relationKind: string;
  confidence: string;
  freshnessStatus: NarrativeFreshnessStatus | null;
  driftReasonCodes: string[];
  recommendedActions: string[];
  driftSourceRefs: string[];
  validationStatus: NarrativeValidationStatus | null;
  validationReasonCodes: string[];
  validationEvidenceRefs: string[];
  validationRecommendedActions: string[];
  extra: string[];
}

export interface ExplorerView {
  threads: ExplorerThreadView[];
  recoveryItems: ExplorerRecoveryItemView[];
  visibleRecoveryItems: ExplorerRecoveryItemView[];
  selectedRecoveryItem: ExplorerRecoveryItemView | null;
  trustItems: ExplorerTrustItemView[];
  visibleTrustItems: ExplorerTrustItemView[];
  selectedTrustItem: ExplorerTrustItemView | null;
  formationSteps: ExplorerFormationStepView[];
  visibleFormationSteps: ExplorerFormationStepView[];
  selectedFormationStep: ExplorerFormationStepView | null;
  selectedThread: ExplorerThreadView | null;
  detail: ExplorerDetail;
  empty: boolean;
}

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

const emptyRecoveryProfile = (): NarrativeRecoveryProfile => ({
  recoverNow: {
    source: "none",
    items: [],
    currentGoal: null,
    currentSummary: null,
    latestSessionId: null,
    openLoopCount: 0,
    nextActionCount: 0,
    stableDecisionCount: 0,
  },
  whatToTrust: {
    items: [],
    freshnessCounts: emptyFreshnessCounts(),
    validationCounts: emptyValidationCounts(),
  },
  howWeGotHere: {
    steps: [],
    snapshotCount: 0,
    threadCount: 0,
    intentCount: 0,
    eventCount: 0,
  },
  empty: true,
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

const coerceDriftOverlayFields = (value: unknown): ReturnType<typeof emptyDriftOverlayFields> => {
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

const coerceValidationOverlayFields = (value: unknown): ReturnType<typeof emptyValidationOverlayFields> => {
  if (!isPlainObject(value)) return emptyValidationOverlayFields();
  return {
    validationStatus:
      value.validationStatus === "verified" ||
      value.validationStatus === "attention" ||
      value.validationStatus === "unverified"
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

const attachDriftOverlayDefaults = <T extends object>(value: T): T & ReturnType<typeof emptyDriftOverlayFields> => ({
  ...value,
  ...coerceDriftOverlayFields(value),
});

const attachValidationOverlayDefaults = <T extends object>(
  value: T,
): T & ReturnType<typeof emptyValidationOverlayFields> => ({
  ...value,
  ...coerceValidationOverlayFields(value),
});

const normalizeText = (value: string): string =>
  value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const matchesQuery = (haystack: string, query: string): boolean => {
  const needle = normalizeText(query);
  if (!needle) return true;
  return normalizeText(haystack).includes(needle);
};

const uniqueStrings = (values: Array<string | null | undefined>): string[] =>
  Array.from(new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0)));

const asArray = <T>(value: T[] | undefined | null): T[] => (Array.isArray(value) ? value : []);

const arraysIntersect = (left: string[], right: string[]): boolean => {
  const rightSet = new Set(right);
  return left.some((value) => rightSet.has(value));
};

const summarizeList = (values: string[], limit = 2): string => {
  const items = uniqueStrings(values);
  if (items.length === 0) return "none";
  if (items.length <= limit) return items.join(", ");
  return `${items.slice(0, limit).join(", ")} +${items.length - limit} more`;
};

const hasNarrativeModelCoreShape = (value: Record<string, unknown>): boolean =>
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

const coerceRecoveryNowItem = (value: unknown, rank: number): RecoveryNowItem | null => {
  if (!isPlainObject(value)) return null;
  const itemId = typeof value.itemId === "string" ? value.itemId : typeof value.id === "string" ? value.id : "";
  if (!itemId) return null;
  return {
    itemId,
    kind:
      value.kind === "working-goal" ||
      value.kind === "working-summary" ||
      value.kind === "latest-session" ||
      value.kind === "open-loop" ||
      value.kind === "next-action" ||
      value.kind === "stable-decision" ||
      value.kind === "retrieval-hit" ||
      value.kind === "constraint" ||
      value.kind === "decision" ||
      value.kind === "thread" ||
      value.kind === "intent"
        ? value.kind
        : "decision",
    title: typeof value.title === "string" ? value.title : "",
    summary: typeof value.summary === "string" ? value.summary : "",
    rank: typeof value.rank === "number" ? value.rank : rank,
    source:
      value.source === "working-memory" ||
      value.source === "latest-session" ||
      value.source === "recall" ||
      value.source === "narrative" ||
      value.source === "none"
        ? value.source
        : "narrative",
    sourceRef: typeof value.sourceRef === "string" ? value.sourceRef : "narrative",
    snapshotSha: typeof value.snapshotSha === "string" ? value.snapshotSha : null,
    threadId: typeof value.threadId === "string" ? value.threadId : null,
    nodeId: typeof value.nodeId === "string" ? value.nodeId : null,
    relatedPaths: Array.isArray(value.relatedPaths)
      ? value.relatedPaths.filter((entry): entry is string => typeof entry === "string")
      : [],
    status: typeof value.status === "string" ? value.status : null,
  };
};

const coerceRecoveryTrustItem = (value: unknown, rank: number): RecoveryTrustItem | null => {
  if (!isPlainObject(value)) return null;
  const itemId = typeof value.itemId === "string" ? value.itemId : typeof value.id === "string" ? value.id : "";
  if (!itemId) return null;
  return {
    itemId,
    kind: value.kind === "thread" || value.kind === "node" || value.kind === "intent" || value.kind === "event" ? value.kind : "thread",
    title: typeof value.title === "string" ? value.title : "",
    summary: typeof value.summary === "string" ? value.summary : "",
    rank: typeof value.rank === "number" ? value.rank : rank,
    threadId: typeof value.threadId === "string" ? value.threadId : null,
    freshnessStatus:
      value.freshnessStatus === "fresh" || value.freshnessStatus === "suspect" || value.freshnessStatus === "stale"
        ? value.freshnessStatus
        : null,
    validationStatus:
      value.validationStatus === "verified" ||
      value.validationStatus === "attention" ||
      value.validationStatus === "unverified"
        ? value.validationStatus
        : null,
    trustBadge:
      value.trustBadge === "durable-doc" ||
      value.trustBadge === "reviewed-artifact" ||
      value.trustBadge === "promoted-artifact" ||
      value.trustBadge === "operational-event"
        ? value.trustBadge
        : null,
    sensitivity:
      value.sensitivity === "standard" || value.sensitivity === "redacted" || value.sensitivity === "restricted"
        ? value.sensitivity
        : null,
    lineageKinds: Array.isArray(value.lineageKinds)
      ? value.lineageKinds.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      : [],
    sourceRef: typeof value.sourceRef === "string" ? value.sourceRef : "narrative",
    relatedPaths: Array.isArray(value.relatedPaths)
      ? value.relatedPaths.filter((entry): entry is string => typeof entry === "string")
      : [],
    reasonCodes: Array.isArray(value.reasonCodes)
      ? value.reasonCodes.filter((entry): entry is string => typeof entry === "string")
      : [],
    evidenceRefs: Array.isArray(value.evidenceRefs)
      ? value.evidenceRefs.filter((entry): entry is string => typeof entry === "string")
      : [],
    recommendedActions: Array.isArray(value.recommendedActions)
      ? value.recommendedActions.filter((entry): entry is string => typeof entry === "string")
      : [],
  };
};

const coerceRecoveryFormationStep = (value: unknown, rank: number): RecoveryFormationStep | null => {
  if (!isPlainObject(value)) return null;
  const itemId = typeof value.itemId === "string" ? value.itemId : typeof value.id === "string" ? value.id : "";
  if (!itemId) return null;
  return {
    itemId,
    kind:
      value.kind === "snapshot" ||
      value.kind === "thread" ||
      value.kind === "intent" ||
      value.kind === "event" ||
      value.kind === "memory" ||
      value.kind === "decision"
        ? value.kind
        : "decision",
    title: typeof value.title === "string" ? value.title : "",
    summary: typeof value.summary === "string" ? value.summary : "",
    rank: typeof value.rank === "number" ? value.rank : rank,
    refId: typeof value.refId === "string" ? value.refId : itemId,
    when: typeof value.when === "string" ? value.when : null,
    relatedPaths: Array.isArray(value.relatedPaths)
      ? value.relatedPaths.filter((entry): entry is string => typeof entry === "string")
      : [],
    threadId: typeof value.threadId === "string" ? value.threadId : null,
  };
};

const coerceRecoveryProfile = (value: unknown): NarrativeRecoveryProfile => {
  if (!isPlainObject(value)) {
    return emptyRecoveryProfile();
  }

  const recoverNowSection = isPlainObject(value.recoverNow) ? value.recoverNow : {};
  const whatToTrustSection = isPlainObject(value.whatToTrust) ? value.whatToTrust : {};
  const howWeGotHereSection = isPlainObject(value.howWeGotHere) ? value.howWeGotHere : {};

  const recoverNowItems = Array.isArray(recoverNowSection.items)
    ? recoverNowSection.items
        .map((item, index) => coerceRecoveryNowItem(item, index + 1))
        .filter((item): item is RecoveryNowItem => item !== null)
    : [];
  const trustItems = Array.isArray(whatToTrustSection.items)
    ? whatToTrustSection.items
        .map((item, index) => coerceRecoveryTrustItem(item, index + 1))
        .filter((item): item is RecoveryTrustItem => item !== null)
    : [];
  const formationSteps = Array.isArray(howWeGotHereSection.steps)
    ? howWeGotHereSection.steps
        .map((step, index) => coerceRecoveryFormationStep(step, index + 1))
        .filter((step): step is RecoveryFormationStep => step !== null)
    : [];

  return {
    recoverNow: {
      source:
        recoverNowSection.source === "working-memory" ||
        recoverNowSection.source === "latest-session" ||
        recoverNowSection.source === "recall" ||
        recoverNowSection.source === "narrative" ||
        recoverNowSection.source === "none"
          ? recoverNowSection.source
          : "none",
      items: recoverNowItems,
      currentGoal: typeof recoverNowSection.currentGoal === "string" ? recoverNowSection.currentGoal : null,
      currentSummary: typeof recoverNowSection.currentSummary === "string" ? recoverNowSection.currentSummary : null,
      latestSessionId: typeof recoverNowSection.latestSessionId === "string" ? recoverNowSection.latestSessionId : null,
      openLoopCount: typeof recoverNowSection.openLoopCount === "number" ? recoverNowSection.openLoopCount : 0,
      nextActionCount: typeof recoverNowSection.nextActionCount === "number" ? recoverNowSection.nextActionCount : 0,
      stableDecisionCount:
        typeof recoverNowSection.stableDecisionCount === "number" ? recoverNowSection.stableDecisionCount : 0,
    },
    whatToTrust: {
      items: trustItems,
      freshnessCounts: coerceFreshnessCounts(whatToTrustSection.freshnessCounts),
      validationCounts: coerceValidationCounts(whatToTrustSection.validationCounts),
    },
    howWeGotHere: {
      steps: formationSteps,
      snapshotCount: typeof howWeGotHereSection.snapshotCount === "number" ? howWeGotHereSection.snapshotCount : 0,
      threadCount: typeof howWeGotHereSection.threadCount === "number" ? howWeGotHereSection.threadCount : 0,
      intentCount: typeof howWeGotHereSection.intentCount === "number" ? howWeGotHereSection.intentCount : 0,
      eventCount: typeof howWeGotHereSection.eventCount === "number" ? howWeGotHereSection.eventCount : 0,
    },
    empty:
      typeof value.empty === "boolean"
        ? value.empty
        : recoverNowItems.length === 0 && trustItems.length === 0 && formationSteps.length === 0,
  };
};

const normalizeNarrativeModel = (value: unknown): NarrativeModel => {
  if (!isPlainObject(value) || !hasNarrativeModelCoreShape(value)) {
    throw new Error("Narrative model file did not contain a valid narrative payload.");
  }

  if (typeof value.schemaVersion !== "number" || !Number.isInteger(value.schemaVersion)) {
    const legacyValue = value as Omit<
      NarrativeModel,
      "schemaVersion" | "producerVersion" | "projectionPolicyVersion" | "projectionMode" | "recovery"
    >;
    return {
      schemaVersion: NARRATIVE_MODEL_SCHEMA_VERSION,
      producerVersion: NARRATIVE_MODEL_LEGACY_PRODUCER_VERSION,
      projectionPolicyVersion: NARRATIVE_PROJECTION_POLICY_VERSION,
      projectionMode: NARRATIVE_PROJECTION_MODE,
      ...legacyValue,
      summary: {
        ...legacyValue.summary,
        freshnessCounts: coerceFreshnessCounts((legacyValue.summary as Record<string, unknown>).freshnessCounts),
        validationCounts: coerceValidationCounts((legacyValue.summary as Record<string, unknown>).validationCounts),
      },
      threads: Array.isArray(legacyValue.threads)
        ? legacyValue.threads.map((thread) => attachValidationOverlayDefaults(attachDriftOverlayDefaults(thread)))
        : [],
      nodes: Array.isArray(legacyValue.nodes)
        ? legacyValue.nodes.map((node) => attachValidationOverlayDefaults(attachDriftOverlayDefaults(node)))
        : [],
      intentItems: Array.isArray(legacyValue.intentItems)
        ? legacyValue.intentItems.map((item) => attachValidationOverlayDefaults(attachDriftOverlayDefaults(item)))
        : [],
      unassignedIntentItems: Array.isArray(legacyValue.unassignedIntentItems)
        ? legacyValue.unassignedIntentItems.map((item) => attachValidationOverlayDefaults(attachDriftOverlayDefaults(item)))
        : [],
      recovery: emptyRecoveryProfile(),
    };
  }

  if (value.schemaVersion !== NARRATIVE_MODEL_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported narrative model schemaVersion=${String(value.schemaVersion)}. ` +
        `This viewer supports only schemaVersion=${NARRATIVE_MODEL_SCHEMA_VERSION}.`,
    );
  }

  const projectionPolicyVersion =
    typeof value.projectionPolicyVersion === "number" && Number.isInteger(value.projectionPolicyVersion)
      ? value.projectionPolicyVersion
      : NARRATIVE_PROJECTION_POLICY_VERSION;
  if (projectionPolicyVersion !== NARRATIVE_PROJECTION_POLICY_VERSION) {
    throw new Error(
      `Unsupported narrative projectionPolicyVersion=${String(projectionPolicyVersion)}. ` +
        `This viewer supports only projectionPolicyVersion=${NARRATIVE_PROJECTION_POLICY_VERSION}.`,
    );
  }

  if (typeof value.projectionMode === "string" && value.projectionMode !== NARRATIVE_PROJECTION_MODE) {
    throw new Error(
      `Unsupported narrative projectionMode=${String(value.projectionMode)}. ` +
        `This viewer supports only projectionMode=${NARRATIVE_PROJECTION_MODE}.`,
    );
  }

  return {
    ...(value as NarrativeModel),
    producerVersion:
      typeof value.producerVersion === "string" && value.producerVersion.trim().length > 0
        ? value.producerVersion
        : "unknown",
    projectionPolicyVersion,
    projectionMode: value.projectionMode === NARRATIVE_PROJECTION_MODE ? value.projectionMode : NARRATIVE_PROJECTION_MODE,
    summary: {
      ...(value.summary as NarrativeModel["summary"]),
      freshnessCounts: coerceFreshnessCounts((value.summary as Record<string, unknown>).freshnessCounts),
      validationCounts: coerceValidationCounts((value.summary as Record<string, unknown>).validationCounts),
    },
    threads: Array.isArray(value.threads)
      ? value.threads.map((thread) => attachValidationOverlayDefaults(attachDriftOverlayDefaults(thread)))
      : [],
    nodes: Array.isArray(value.nodes)
      ? value.nodes.map((node) => attachValidationOverlayDefaults(attachDriftOverlayDefaults(node)))
      : [],
    intentItems: Array.isArray(value.intentItems)
      ? value.intentItems.map((item) => attachValidationOverlayDefaults(attachDriftOverlayDefaults(item)))
      : [],
    unassignedIntentItems: Array.isArray(value.unassignedIntentItems)
      ? value.unassignedIntentItems.map((item) => attachValidationOverlayDefaults(attachDriftOverlayDefaults(item)))
      : [],
    recovery: coerceRecoveryProfile(value.recovery),
  };
};

export const loadNarrativeModel = async (modelPath: string): Promise<NarrativeModel> => {
  const absolutePath = path.resolve(process.cwd(), modelPath);
  const content = await readFile(absolutePath, "utf8");
  const parsed = JSON.parse(content) as unknown;
  return normalizeNarrativeModel(parsed);
};

export const buildThreadViews = (model: NarrativeModel): ExplorerThreadView[] =>
  model.threads.map((thread) => {
    const nodes = model.nodes.filter((node) => node.threadId === thread.threadId);
    const relationKinds = uniqueStrings(nodes.map((node) => node.relationKind));
    const searchText = [
      thread.title,
      thread.docType,
      thread.docPaths.join(" "),
      thread.snapshotShas.join(" "),
      thread.badges.trust,
      thread.badges.sensitivity,
      thread.badges.lineageKinds.join(" "),
      thread.freshnessStatus ?? "",
      thread.driftReasonCodes.join(" "),
      thread.recommendedActions.join(" "),
      thread.driftSourceRefs.join(" "),
      thread.validationStatus ?? "",
      thread.validationReasonCodes.join(" "),
      thread.validationEvidenceRefs.join(" "),
      thread.validationRecommendedActions.join(" "),
      nodes.map((node) => [node.title, node.summary, node.path].join(" ")).join(" "),
    ]
      .filter(Boolean)
      .join(" ");
    return {
      threadId: thread.threadId,
      title: thread.title,
      docType: thread.docType,
      docPaths: thread.docPaths,
      snapshotShas: thread.snapshotShas,
      nodeIds: thread.nodeIds,
      nodes,
      binding: thread.binding,
      freshnessStatus: thread.freshnessStatus,
      driftReasonCodes: thread.driftReasonCodes,
      recommendedActions: thread.recommendedActions,
      driftSourceRefs: thread.driftSourceRefs,
      validationStatus: thread.validationStatus,
      validationReasonCodes: thread.validationReasonCodes,
      validationEvidenceRefs: thread.validationEvidenceRefs,
      validationRecommendedActions: thread.validationRecommendedActions,
      badges: thread.badges,
      relationKinds,
      searchText,
    };
  });

const buildThreadIndex = (threads: ExplorerThreadView[]): Map<string, ExplorerThreadView> =>
  new Map(threads.map((thread) => [thread.threadId, thread]));

const findLinkedThread = (
  threadIndex: Map<string, ExplorerThreadView>,
  explicitThreadId: string | null | undefined,
  relatedPaths: string[],
  snapshotSha?: string | null,
): ExplorerThreadView | null => {
  if (explicitThreadId && threadIndex.has(explicitThreadId)) {
    return threadIndex.get(explicitThreadId) ?? null;
  }
  const byPath = Array.from(threadIndex.values()).find((thread) => arraysIntersect(thread.docPaths, relatedPaths));
  if (byPath) return byPath;
  if (snapshotSha) {
    return Array.from(threadIndex.values()).find((thread) => thread.snapshotShas.includes(snapshotSha)) ?? null;
  }
  return null;
};

const buildRecoveryItemViews = (model: NarrativeModel, threadIndex: Map<string, ExplorerThreadView>): ExplorerRecoveryItemView[] =>
  model.recovery.recoverNow.items.map((item) => {
    const linkedThread = findLinkedThread(threadIndex, item.threadId, item.relatedPaths, item.snapshotSha);
    return {
      ...item,
      linkedThread,
      searchText: [
        item.title,
        item.summary,
        item.kind,
        item.source,
        item.sourceRef,
        item.status ?? "",
        item.snapshotSha ?? "",
        item.relatedPaths.join(" "),
        linkedThread?.title ?? "",
      ]
        .filter(Boolean)
        .join(" "),
    };
  });

const buildTrustItemViews = (model: NarrativeModel, threadIndex: Map<string, ExplorerThreadView>): ExplorerTrustItemView[] =>
  model.recovery.whatToTrust.items.map((item) => {
    const linkedThread = findLinkedThread(threadIndex, item.threadId, item.relatedPaths);
    return {
      ...item,
      linkedThread,
      searchText: [
        item.title,
        item.summary,
        item.kind,
        item.trustBadge ?? "",
        item.sensitivity ?? "",
        item.freshnessStatus ?? "",
        item.validationStatus ?? "",
        item.lineageKinds.join(" "),
        item.sourceRef,
        item.relatedPaths.join(" "),
        item.reasonCodes.join(" "),
        item.evidenceRefs.join(" "),
        item.recommendedActions.join(" "),
        linkedThread?.title ?? "",
      ]
        .filter(Boolean)
        .join(" "),
    };
  });

const buildFormationStepViews = (
  model: NarrativeModel,
  threadIndex: Map<string, ExplorerThreadView>,
): ExplorerFormationStepView[] =>
  model.recovery.howWeGotHere.steps.map((step) => {
    const linkedThread = findLinkedThread(threadIndex, step.threadId, step.relatedPaths);
    return {
      ...step,
      linkedThread,
      searchText: [
        step.title,
        step.summary,
        step.kind,
        step.refId,
        step.when ?? "",
        step.relatedPaths.join(" "),
        linkedThread?.title ?? "",
      ]
        .filter(Boolean)
        .join(" "),
    };
  });

const chooseSelectedItem = <T extends { itemId?: string; threadId?: string | null }>(
  items: T[],
  preferredId: string | null,
): T | null => {
  if (items.length === 0) return null;
  if (preferredId) {
    const match = items.find((item) => ("itemId" in item ? item.itemId === preferredId : false));
    if (match) return match;
  }
  return items[0] ?? null;
};

const chooseExplicitItem = <T extends { itemId?: string }>(items: T[], preferredId: string | null): T | null => {
  if (!preferredId) return null;
  return items.find((item) => ("itemId" in item ? item.itemId === preferredId : false)) ?? null;
};

const buildThreadDetail = (thread: ExplorerThreadView | null): ExplorerDetail => {
  if (!thread) {
    return {
      kind: "empty",
      title: "No linked thread",
      summary: "Select a recovery, trust, or formation item to inspect the recovery packet and its linked decision thread.",
      path: "none",
      artifactId: "none",
      snapshotSha: "none",
      relationKind: "none",
      confidence: "none",
      freshnessStatus: null,
      driftReasonCodes: [],
      recommendedActions: [],
      driftSourceRefs: [],
      validationStatus: null,
      validationReasonCodes: [],
      validationEvidenceRefs: [],
      validationRecommendedActions: [],
      extra: [],
    };
  }
  const latestNode = thread.nodes[thread.nodes.length - 1] ?? null;
  return {
    kind: "thread",
    title: thread.title,
    summary: `${thread.docType} thread across ${thread.snapshotShas.length} snapshot(s) with ${thread.nodes.length} node(s).`,
    path: thread.docPaths.join(", "),
    artifactId: latestNode?.sourceArtifactId ?? "none",
    snapshotSha: thread.snapshotShas[thread.snapshotShas.length - 1] ?? "none",
    relationKind: thread.relationKinds.join(" · ") || "root",
    confidence: latestNode ? String(latestNode.confidence) : "none",
    freshnessStatus: thread.freshnessStatus,
    driftReasonCodes: thread.driftReasonCodes,
    recommendedActions: thread.recommendedActions,
    driftSourceRefs: thread.driftSourceRefs,
    validationStatus: thread.validationStatus,
    validationReasonCodes: thread.validationReasonCodes,
    validationEvidenceRefs: thread.validationEvidenceRefs,
    validationRecommendedActions: thread.validationRecommendedActions,
    extra: [
      `trust: ${thread.badges.trust}`,
      `sensitivity: ${thread.badges.sensitivity}`,
      `bindings: goals=${thread.binding.goalCount}, episodes=${thread.binding.episodeCount}, sessions=${thread.binding.sessionCount}, relatedPaths=${thread.binding.relatedPathCount}`,
      `paths: ${thread.docPaths.join(", ")}`,
    ],
  };
};

const buildRecoveryDetail = (
  model: NarrativeModel,
  item: ExplorerRecoveryItemView | null,
  thread: ExplorerThreadView | null,
): ExplorerDetail => {
  if (!item) return buildThreadDetail(thread);
  return {
    kind: "recovery",
    title: item.title,
    summary: item.summary,
    path: item.relatedPaths.join(", ") || thread?.docPaths.join(", ") || "none",
    artifactId: "none",
    snapshotSha: item.snapshotSha ?? thread?.snapshotShas.at(-1) ?? "none",
    relationKind: `${item.kind} · ${item.source}`,
    confidence: "n/a",
    freshnessStatus: thread?.freshnessStatus ?? null,
    driftReasonCodes: thread?.driftReasonCodes ?? [],
    recommendedActions: uniqueStrings([...(thread?.recommendedActions ?? []), ...(item.status ? [item.status] : [])]),
    driftSourceRefs: thread?.driftSourceRefs ?? [],
    validationStatus: thread?.validationStatus ?? null,
    validationReasonCodes: thread?.validationReasonCodes ?? [],
    validationEvidenceRefs: thread?.validationEvidenceRefs ?? [],
    validationRecommendedActions: thread?.validationRecommendedActions ?? [],
    extra: [
      `source: ${item.source}`,
      `source ref: ${item.sourceRef}`,
      `rank: ${item.rank}`,
      `status: ${item.status ?? "none"}`,
      `current goal: ${model.recovery.recoverNow.currentGoal ?? "none"}`,
      `current summary: ${model.recovery.recoverNow.currentSummary ?? "none"}`,
      `latest session: ${model.recovery.recoverNow.latestSessionId ?? "none"}`,
      `linked thread: ${thread?.title ?? "none"}`,
    ],
  };
};

const buildTrustDetail = (item: ExplorerTrustItemView | null): ExplorerDetail => {
  if (!item) {
    return {
      kind: "empty",
      title: "No trust item selected",
      summary: "Select a trust item to inspect freshness, validation, and trust posture.",
      path: "none",
      artifactId: "none",
      snapshotSha: "none",
      relationKind: "none",
      confidence: "none",
      freshnessStatus: null,
      driftReasonCodes: [],
      recommendedActions: [],
      driftSourceRefs: [],
      validationStatus: null,
      validationReasonCodes: [],
      validationEvidenceRefs: [],
      validationRecommendedActions: [],
      extra: [],
    };
  }
  return {
    kind: "trust",
    title: item.title,
    summary: item.summary,
    path: item.relatedPaths.join(", ") || item.linkedThread?.docPaths.join(", ") || "none",
    artifactId: "none",
    snapshotSha: item.linkedThread?.snapshotShas.at(-1) ?? "none",
    relationKind: `${item.kind} · ${item.trustBadge ?? "none"}`,
    confidence: "n/a",
    freshnessStatus: item.freshnessStatus,
    driftReasonCodes: item.reasonCodes,
    recommendedActions: item.recommendedActions,
    driftSourceRefs: item.relatedPaths,
    validationStatus: item.validationStatus,
    validationReasonCodes: item.reasonCodes,
    validationEvidenceRefs: item.evidenceRefs,
    validationRecommendedActions: item.recommendedActions,
    extra: [
      `trust: ${item.trustBadge ?? "none"}`,
      `sensitivity: ${item.sensitivity ?? "standard"}`,
      `lineage: ${item.lineageKinds.length > 0 ? item.lineageKinds.join(", ") : "none"}`,
      `source ref: ${item.sourceRef}`,
      `linked thread: ${item.linkedThread?.title ?? "none"}`,
    ],
  };
};

const buildFormationDetail = (
  step: ExplorerFormationStepView | null,
  thread: ExplorerThreadView | null,
): ExplorerDetail => {
  if (!step) return buildThreadDetail(thread);
  return {
    kind: "formation",
    title: step.title,
    summary: step.summary,
    path: step.relatedPaths.join(", ") || thread?.docPaths.join(", ") || "none",
    artifactId: "none",
    snapshotSha: step.refId,
    relationKind: step.kind,
    confidence: "n/a",
    freshnessStatus: thread?.freshnessStatus ?? null,
    driftReasonCodes: thread?.driftReasonCodes ?? [],
    recommendedActions: thread?.recommendedActions ?? [],
    driftSourceRefs: thread?.driftSourceRefs ?? [],
    validationStatus: thread?.validationStatus ?? null,
    validationReasonCodes: thread?.validationReasonCodes ?? [],
    validationEvidenceRefs: thread?.validationEvidenceRefs ?? [],
    validationRecommendedActions: thread?.validationRecommendedActions ?? [],
    extra: [
      `when: ${step.when ?? "none"}`,
      `rank: ${step.rank}`,
      `ref: ${step.refId}`,
      `linked thread: ${thread?.title ?? "none"}`,
    ],
  };
};

export const buildExplorerView = (model: NarrativeModel, state: ExplorerState): ExplorerView => {
  const threads = buildThreadViews(model);
  const threadIndex = buildThreadIndex(threads);
  const recoveryItems = buildRecoveryItemViews(model, threadIndex);
  const trustItems = buildTrustItemViews(model, threadIndex);
  const formationSteps = buildFormationStepViews(model, threadIndex);

  const visibleRecoveryItems = recoveryItems.filter((item) =>
    state.scope === "all" || state.scope === "recover" ? matchesQuery(item.searchText, state.query) : true,
  );
  const visibleTrustItems = trustItems.filter((item) =>
    state.scope === "all" || state.scope === "trust" ? matchesQuery(item.searchText, state.query) : true,
  );
  const visibleFormationSteps = formationSteps.filter((item) =>
    state.scope === "all" || state.scope === "formation" ? matchesQuery(item.searchText, state.query) : true,
  );

  const selectedRecoveryItem =
    chooseSelectedItem(visibleRecoveryItems, state.selectedRecoveryItemId) as ExplorerRecoveryItemView | null;
  const selectedTrustItem =
    chooseExplicitItem(visibleTrustItems, state.selectedTrustItemId) as ExplorerTrustItemView | null;
  const selectedFormationStep =
    chooseExplicitItem(visibleFormationSteps, state.selectedFormationStepId) as ExplorerFormationStepView | null;

  const selectedThread =
    selectedTrustItem?.linkedThread ?? selectedRecoveryItem?.linkedThread ?? selectedFormationStep?.linkedThread ?? null;

  const detail = selectedTrustItem
    ? buildTrustDetail(selectedTrustItem)
    : selectedFormationStep
      ? buildFormationDetail(selectedFormationStep, selectedFormationStep.linkedThread ?? selectedThread)
      : selectedRecoveryItem
        ? buildRecoveryDetail(model, selectedRecoveryItem, selectedRecoveryItem.linkedThread ?? selectedThread)
        : buildThreadDetail(selectedThread);

  return {
    threads,
    recoveryItems,
    visibleRecoveryItems,
    selectedRecoveryItem,
    trustItems,
    visibleTrustItems,
    selectedTrustItem,
    formationSteps,
    visibleFormationSteps,
    selectedFormationStep,
    selectedThread,
    detail,
    empty: visibleRecoveryItems.length === 0 && visibleTrustItems.length === 0 && visibleFormationSteps.length === 0,
  };
};

export const buildRecoveryOptionName = (item: ExplorerRecoveryItemView, selected: boolean): string =>
  `${selected ? "◆ " : ""}#${item.rank} ${item.title}`;

export const buildRecoveryOptionDescription = (item: ExplorerRecoveryItemView): string =>
  `${item.kind} · ${item.source} · ${item.status ?? "active"} · ${
    item.linkedThread ? `thread:${item.linkedThread.title}` : "thread:none"
  } · ${item.summary}`;

export const buildTrustOptionName = (item: ExplorerTrustItemView, selected: boolean): string =>
  `${selected ? "◆ " : ""}${buildFreshnessBadgeLabel(item.freshnessStatus)} ${buildValidationBadgeLabel(item.validationStatus)} ${item.title}`;

export const buildTrustOptionDescription = (item: ExplorerTrustItemView): string =>
  `${item.kind} · ${item.trustBadge ?? "none"} · ${item.sensitivity ?? "standard"} · ${
    item.linkedThread ? `thread:${item.linkedThread.title}` : "thread:none"
  } · ${
    item.reasonCodes.length > 0 ? `reasons:${item.reasonCodes.slice(0, 2).join(", ")}` : "reasons:none"
  } · ${
    item.evidenceRefs.length > 0 ? `evidence:${item.evidenceRefs.slice(0, 2).join(", ")}` : "evidence:none"
  } · ${item.summary}`;

export const buildFormationOptionName = (step: ExplorerFormationStepView, selected: boolean): string =>
  `${selected ? "◆ " : ""}#${step.rank} ${step.kind} · ${step.title}`;

export const buildFormationOptionDescription = (step: ExplorerFormationStepView): string =>
  `${step.when ?? "none"} · ${step.refId} · ${
    step.linkedThread ? `thread:${step.linkedThread.title}` : "thread:none"
  } · ${step.summary}`;

export const buildFreshnessBadgeLabel = (status: NarrativeFreshnessStatus | null): string =>
  status ? `[${status}]` : "[none]";

export const buildFreshnessSummary = (
  status: NarrativeFreshnessStatus | null,
  reasonCodes: string[],
  recommendedActions: string[],
): string => {
  const parts = [`freshness: ${status ?? "none"}`];
  parts.push(`reasons: ${summarizeList(reasonCodes)}`);
  parts.push(`actions: ${summarizeList(recommendedActions)}`);
  return parts.join(" · ");
};

export const buildFreshnessDetailLines = (
  status: NarrativeFreshnessStatus | null,
  reasonCodes: string[],
  recommendedActions: string[],
  driftSourceRefs: string[],
): string[] => [
  `Freshness: ${status ?? "none"}`,
  `Reasons: ${summarizeList(reasonCodes, 3)}`,
  `Recommended Actions: ${summarizeList(recommendedActions, 3)}`,
  `Drift Sources: ${summarizeList(driftSourceRefs, 3)}`,
];

export const buildValidationBadgeLabel = (status: NarrativeValidationStatus | null): string =>
  status ? `[${status}]` : "[none]";

export const buildValidationSummary = (
  status: NarrativeValidationStatus | null,
  reasonCodes: string[],
  evidenceRefs: string[],
  recommendedActions: string[],
): string => {
  const parts = [`validation: ${status ?? "none"}`];
  parts.push(`reasons: ${summarizeList(reasonCodes)}`);
  parts.push(`evidence: ${summarizeList(evidenceRefs)}`);
  parts.push(`actions: ${summarizeList(recommendedActions)}`);
  return parts.join(" · ");
};

export const buildValidationDetailLines = (
  status: NarrativeValidationStatus | null,
  reasonCodes: string[],
  evidenceRefs: string[],
  recommendedActions: string[],
): string[] => [
  `Validation: ${status ?? "none"}`,
  `Reasons: ${summarizeList(reasonCodes, 3)}`,
  `Evidence: ${summarizeList(evidenceRefs, 3)}`,
  `Recommended Actions: ${summarizeList(recommendedActions, 3)}`,
];
