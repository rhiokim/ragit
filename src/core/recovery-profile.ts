import { buildRecoveryView } from "./recovery-view.js";
import { sanitizeStructuredValue } from "./security.js";
import type {
  NarrativeRecoverySource,
  NarrativeRecoveryView,
  NarrativeSnapshotItem,
  NarrativeViewModel,
} from "./narrative-model.js";

const MAX_RECOVERY_NOW_ITEMS = 10;
const MAX_TRUST_ITEMS = 16;
const MAX_FORMATION_STEPS = 20;

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
  freshnessStatus: "fresh" | "suspect" | "stale" | null;
  validationStatus: "verified" | "attention" | "unverified" | null;
  trustBadge: "durable-doc" | "reviewed-artifact" | "promoted-artifact" | "operational-event" | null;
  sensitivity: "standard" | "redacted" | "restricted" | null;
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
    freshnessCounts: {
      fresh: number;
      suspect: number;
      stale: number;
    };
    validationCounts: {
      verified: number;
      attention: number;
      unverified: number;
    };
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

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const compactText = (value: string | null | undefined, max = 180): string => {
  const normalized = (value ?? "").replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
};

const uniqueStrings = (values: Array<string | null | undefined>): string[] =>
  Array.from(new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0)));

const uniqueBy = <T>(items: T[], keyFor: (value: T) => string): T[] => {
  const seen = new Set<string>();
  const output: T[] = [];
  for (const item of items) {
    const key = keyFor(item);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
};

const compareIsoDatesDescending = (left: string | null | undefined, right: string | null | undefined): number =>
  (right ?? "").localeCompare(left ?? "");

const scoreTrustItem = (item: RecoveryTrustItem): number => {
  let score = 0;
  if (item.validationStatus === "attention") score += 240;
  if (item.validationStatus === "unverified") score += 160;
  if (item.freshnessStatus === "stale") score += 180;
  if (item.freshnessStatus === "suspect") score += 120;
  if (item.validationStatus === "verified") score += 20;
  if (item.trustBadge === "durable-doc") score += 40;
  if (item.trustBadge === "promoted-artifact") score += 30;
  if (item.trustBadge === "reviewed-artifact") score += 20;
  if (item.lineageKinds.includes("explicit")) score += 15;
  if (item.lineageKinds.includes("path-continuity")) score += 10;
  if (item.kind === "event") score -= 20;
  return score;
};

const emptyNarrativeRecoveryProfile = (): NarrativeRecoveryProfile => ({
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
    freshnessCounts: { fresh: 0, suspect: 0, stale: 0 },
    validationCounts: { verified: 0, attention: 0, unverified: 0 },
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

const mapRecoveryNowItem = (
  item: NarrativeRecoveryView["recoverNow"]["priorityItems"][number],
  rank: number,
): RecoveryNowItem => ({
  itemId: item.id,
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
  title: item.title,
  summary: compactText(item.summary, 220),
  rank,
  source: item.source,
  sourceRef: item.source === "none" ? "narrative" : item.source,
  snapshotSha: item.snapshotSha,
  threadId: item.threadId,
  nodeId: null,
  relatedPaths: uniqueStrings([item.path]),
  status: item.kind === "open-loop" && item.reasonCodes.includes("blocked") ? "blocked" : null,
});

const mapRecoveryTrustItem = (item: NarrativeRecoveryView["trustItems"][number], rank: number): RecoveryTrustItem => ({
  itemId: item.id,
  kind: item.kind,
  title: item.title,
  summary: compactText(item.summary, 220),
  rank,
  threadId: item.threadId,
  freshnessStatus: item.freshnessStatus,
  validationStatus: item.validationStatus,
  trustBadge: item.trust,
  sensitivity: item.sensitivity,
  lineageKinds: uniqueStrings(item.lineage ? [item.lineage] : []),
  sourceRef: item.threadId ?? item.path ?? item.artifactId ?? item.snapshotSha ?? item.id,
  relatedPaths: uniqueStrings([item.path]),
  reasonCodes: uniqueStrings(item.reasonCodes),
  evidenceRefs: uniqueStrings(item.evidenceRefs),
  recommendedActions: uniqueStrings(item.recommendedActions),
});

const mapFormationStep = (
  step: NarrativeRecoveryView["formationSteps"][number],
  rank: number,
): RecoveryFormationStep => ({
  itemId: step.id,
  kind: step.kind,
  title: step.title,
  summary: compactText(step.summary, 220),
  rank,
  refId: step.artifactId ?? step.path ?? step.threadId ?? step.snapshotSha ?? step.id,
  when: step.recordedAt,
  relatedPaths: uniqueStrings([step.path]),
  threadId: step.threadId,
});

const mapSnapshotStep = (snapshot: NarrativeSnapshotItem, rank: number): RecoveryFormationStep => ({
  itemId: `snapshot:${snapshot.commitSha}`,
  kind: "snapshot",
  title: snapshot.subject,
  summary: compactText(`${snapshot.shortSha} · ${snapshot.subject}`, 220),
  rank,
  refId: snapshot.commitSha,
  when: snapshot.authoredAt,
  relatedPaths: [],
  threadId: null,
});

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
    relatedPaths: Array.isArray(value.relatedPaths) ? value.relatedPaths.filter((entry): entry is string => typeof entry === "string") : [],
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
    freshnessStatus: value.freshnessStatus === "fresh" || value.freshnessStatus === "suspect" || value.freshnessStatus === "stale" ? value.freshnessStatus : null,
    validationStatus: value.validationStatus === "verified" || value.validationStatus === "attention" || value.validationStatus === "unverified" ? value.validationStatus : null,
    trustBadge:
      value.trustBadge === "durable-doc" ||
      value.trustBadge === "reviewed-artifact" ||
      value.trustBadge === "promoted-artifact" ||
      value.trustBadge === "operational-event"
        ? value.trustBadge
        : null,
    sensitivity: value.sensitivity === "standard" || value.sensitivity === "redacted" || value.sensitivity === "restricted" ? value.sensitivity : null,
    lineageKinds: Array.isArray(value.lineageKinds)
      ? value.lineageKinds.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      : typeof value.lineage === "string" && value.lineage.trim().length > 0
        ? [value.lineage]
        : [],
    sourceRef: typeof value.sourceRef === "string" ? value.sourceRef : "narrative",
    relatedPaths: Array.isArray(value.relatedPaths) ? value.relatedPaths.filter((entry): entry is string => typeof entry === "string") : [],
    reasonCodes: Array.isArray(value.reasonCodes) ? value.reasonCodes.filter((entry): entry is string => typeof entry === "string") : [],
    evidenceRefs: Array.isArray(value.evidenceRefs) ? value.evidenceRefs.filter((entry): entry is string => typeof entry === "string") : [],
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
    refId: typeof value.refId === "string" ? value.refId : typeof value.snapshotSha === "string" ? value.snapshotSha : itemId,
    when: typeof value.when === "string" ? value.when : typeof value.recordedAt === "string" ? value.recordedAt : null,
    relatedPaths: Array.isArray(value.relatedPaths) ? value.relatedPaths.filter((entry): entry is string => typeof entry === "string") : [],
    threadId: typeof value.threadId === "string" ? value.threadId : null,
  };
};

const coerceRecoveryProfile = (value: unknown): NarrativeRecoveryProfile => {
  if (!isPlainObject(value)) {
    return emptyNarrativeRecoveryProfile();
  }

  const recoverNowSection = isPlainObject(value.recoverNow) ? (value.recoverNow as Record<string, unknown>) : {};
  const whatToTrustSection = isPlainObject(value.whatToTrust) ? (value.whatToTrust as Record<string, unknown>) : {};
  const howWeGotHereSection = isPlainObject(value.howWeGotHere) ? (value.howWeGotHere as Record<string, unknown>) : {};
  const recoverNowItemsValue = recoverNowSection.items;
  const trustItemsValue = whatToTrustSection.items;
  const stepsValue = howWeGotHereSection.steps;
  const freshnessCountsSection = isPlainObject(whatToTrustSection.freshnessCounts)
    ? (whatToTrustSection.freshnessCounts as Record<string, unknown>)
    : null;
  const validationCountsSection = isPlainObject(whatToTrustSection.validationCounts)
    ? (whatToTrustSection.validationCounts as Record<string, unknown>)
    : null;
  const recoverNowItems = Array.isArray(recoverNowItemsValue)
    ? recoverNowItemsValue.map((item, index) => coerceRecoveryNowItem(item, index + 1)).filter((item): item is RecoveryNowItem => item !== null)
    : [];
  const trustItems = Array.isArray(trustItemsValue)
    ? trustItemsValue.map((item, index) => coerceRecoveryTrustItem(item, index + 1)).filter((item): item is RecoveryTrustItem => item !== null)
    : [];
  const steps = Array.isArray(stepsValue)
    ? stepsValue
        .map((step, index) => coerceRecoveryFormationStep(step, index + 1))
        .filter((step): step is RecoveryFormationStep => step !== null)
    : [];

  const freshnessCounts = freshnessCountsSection
    ? {
        fresh: typeof freshnessCountsSection.fresh === "number" ? freshnessCountsSection.fresh : 0,
        suspect: typeof freshnessCountsSection.suspect === "number" ? freshnessCountsSection.suspect : 0,
        stale: typeof freshnessCountsSection.stale === "number" ? freshnessCountsSection.stale : 0,
      }
    : { fresh: 0, suspect: 0, stale: 0 };
  const validationCounts = validationCountsSection
    ? {
        verified: typeof validationCountsSection.verified === "number" ? validationCountsSection.verified : 0,
        attention: typeof validationCountsSection.attention === "number" ? validationCountsSection.attention : 0,
        unverified: typeof validationCountsSection.unverified === "number" ? validationCountsSection.unverified : 0,
      }
    : { verified: 0, attention: 0, unverified: 0 };

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
      items: recoverNowItems.slice(0, MAX_RECOVERY_NOW_ITEMS),
      currentGoal: typeof recoverNowSection.currentGoal === "string" ? recoverNowSection.currentGoal : null,
      currentSummary: typeof recoverNowSection.currentSummary === "string" ? recoverNowSection.currentSummary : null,
      latestSessionId: typeof recoverNowSection.latestSessionId === "string" ? recoverNowSection.latestSessionId : null,
      openLoopCount: typeof recoverNowSection.openLoopCount === "number" ? recoverNowSection.openLoopCount : 0,
      nextActionCount: typeof recoverNowSection.nextActionCount === "number" ? recoverNowSection.nextActionCount : 0,
      stableDecisionCount: typeof recoverNowSection.stableDecisionCount === "number" ? recoverNowSection.stableDecisionCount : 0,
    },
    whatToTrust: {
      items: trustItems.slice(0, MAX_TRUST_ITEMS),
      freshnessCounts,
      validationCounts,
    },
    howWeGotHere: {
      steps: steps.slice(0, MAX_FORMATION_STEPS),
      snapshotCount: typeof howWeGotHereSection.snapshotCount === "number" ? howWeGotHereSection.snapshotCount : 0,
      threadCount: typeof howWeGotHereSection.threadCount === "number" ? howWeGotHereSection.threadCount : 0,
      intentCount: typeof howWeGotHereSection.intentCount === "number" ? howWeGotHereSection.intentCount : 0,
      eventCount: typeof howWeGotHereSection.eventCount === "number" ? howWeGotHereSection.eventCount : 0,
    },
    empty: typeof value.empty === "boolean" ? value.empty : recoverNowItems.length === 0 && trustItems.length === 0 && steps.length === 0,
  };
};

const convertLegacyRecoveryViewToProfile = (
  recovery: NarrativeRecoveryView,
  viewModel: Pick<NarrativeViewModel, "snapshots" | "threads" | "nodes" | "intentItems" | "unassignedIntentItems" | "timelineEvents">,
): NarrativeRecoveryProfile => {
  const recoverNowItems = uniqueBy(
    recovery.recoverNow.priorityItems.map((item, index) => mapRecoveryNowItem(item, index + 1)),
    (item) => item.itemId,
  ).slice(0, MAX_RECOVERY_NOW_ITEMS);

  const trustItems = uniqueBy(
    recovery.trustItems.map((item, index) => mapRecoveryTrustItem(item, index + 1)),
    (item) => item.itemId,
  )
    .sort((left, right) => scoreTrustItem(right) - scoreTrustItem(left) || left.rank - right.rank || left.itemId.localeCompare(right.itemId))
    .slice(0, MAX_TRUST_ITEMS)
    .map((item, index) => ({ ...item, rank: index + 1 }));

  const legacySteps = uniqueBy(
    recovery.formationSteps.map((step, index) => mapFormationStep(step, index + 1)),
    (item) => item.itemId,
  );
  const snapshotSteps = uniqueBy(
    viewModel.snapshots.map((snapshot, index) => mapSnapshotStep(snapshot, index + 1)),
    (item) => item.itemId,
  );
  const steps = uniqueBy(
    [...snapshotSteps, ...legacySteps].sort((left, right) => {
      const byTime = compareIsoDatesDescending(left.when, right.when);
      if (byTime !== 0) return byTime;
      return left.itemId.localeCompare(right.itemId);
    }),
    (item) => item.itemId,
  ).slice(0, MAX_FORMATION_STEPS);

  const freshnessCounts = trustItems.reduce(
    (acc, item) => {
      if (item.freshnessStatus === "fresh") acc.fresh += 1;
      if (item.freshnessStatus === "suspect") acc.suspect += 1;
      if (item.freshnessStatus === "stale") acc.stale += 1;
      return acc;
    },
    { fresh: 0, suspect: 0, stale: 0 },
  );
  const validationCounts = trustItems.reduce(
    (acc, item) => {
      if (item.validationStatus === "verified") acc.verified += 1;
      if (item.validationStatus === "attention") acc.attention += 1;
      if (item.validationStatus === "unverified") acc.unverified += 1;
      return acc;
    },
    { verified: 0, attention: 0, unverified: 0 },
  );

  return {
    recoverNow: {
      source: recovery.recoverNow.source,
      items: recoverNowItems,
      currentGoal: recovery.recoverNow.goal,
      currentSummary: recovery.recoverNow.summary,
      latestSessionId: recovery.recoverNow.latestSessionId,
      openLoopCount: recovery.recoverNow.openLoops.length,
      nextActionCount: recovery.recoverNow.nextActions.length,
      stableDecisionCount: recovery.recoverNow.durableDecisions.length,
    },
    whatToTrust: {
      items: trustItems,
      freshnessCounts,
      validationCounts,
    },
    howWeGotHere: {
      steps,
      snapshotCount: snapshotSteps.length,
      threadCount: viewModel.threads.length,
      intentCount: viewModel.intentItems.length,
      eventCount: viewModel.timelineEvents.length,
    },
    empty: recoverNowItems.length === 0 && trustItems.length === 0 && steps.length === 0,
  };
};

export const buildNarrativeRecoveryProfile = async (
  cwd: string,
  viewModel: Omit<NarrativeViewModel, "recovery" | "recoveryProfile">,
  legacyRecovery?: NarrativeRecoveryView,
): Promise<NarrativeRecoveryProfile> => {
  const recovery = legacyRecovery ?? (await buildRecoveryView(cwd, viewModel));
  const profile = convertLegacyRecoveryViewToProfile(recovery, viewModel);
  const sanitized = sanitizeStructuredValue(profile, "narrative.output", "narrative.recoveryProfile");
  return sanitized.value as NarrativeRecoveryProfile;
};

export const normalizeNarrativeRecoveryProfile = (value: unknown): NarrativeRecoveryProfile => {
  if (!isPlainObject(value)) return emptyNarrativeRecoveryProfile();
  const legacyRecoverNow = isPlainObject(value.recoverNow) ? (value.recoverNow as Record<string, unknown>) : null;
  const legacyTrustItems = value.trustItems;
  if (legacyRecoverNow && Array.isArray(legacyRecoverNow.priorityItems) && Array.isArray(legacyTrustItems)) {
    return convertLegacyRecoveryViewToProfile(value as unknown as NarrativeRecoveryView, {
      snapshots: [],
      threads: [],
      nodes: [],
      intentItems: [],
      unassignedIntentItems: [],
      timelineEvents: [],
    });
  }
  return coerceRecoveryProfile(value);
};
