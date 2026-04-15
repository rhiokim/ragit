import { loadLatestSessionWrap, loadWorkingMemoryState, recallMemory } from "./memory.js";
import type {
  NarrativeDecisionNode,
  NarrativeDecisionThread,
  NarrativeEventItem,
  NarrativeIntentItem,
  NarrativeRecoveryDecision,
  NarrativeRecoveryFormationStep,
  NarrativeRecoveryHit,
  NarrativeRecoveryOpenLoop,
  NarrativeRecoveryPriorityItem,
  NarrativeRecoverySource,
  NarrativeRecoveryTrustItem,
  NarrativeRecoveryView,
  NarrativeViewModel,
} from "./narrative-model.js";
import type { MemoryDecision, MemoryOpenLoop, RecallPacket, SessionWrapRecord, WorkingMemoryState } from "./memoryTypes.js";
import { sanitizeStructuredValue } from "./security.js";
import type { RetrievalHit } from "./types.js";

const MAX_PRIORITY_ITEMS = 8;
const MAX_TRUST_ITEMS = 12;
const MAX_FORMATION_STEPS = 18;
const MAX_RECALL_HITS = 5;
const MAX_DURABLE_DECISIONS = 5;

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
  trustBadge: NarrativeRecoveryTrustItem["trust"];
  sensitivity: NarrativeRecoveryTrustItem["sensitivity"];
  lineageKinds: Array<NonNullable<NarrativeRecoveryTrustItem["lineage"]>>;
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
    freshnessCounts: {
      fresh: 0,
      suspect: 0,
      stale: 0,
    },
    validationCounts: {
      verified: 0,
      attention: 0,
      unverified: 0,
    },
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

const compactText = (value: string | null | undefined, max = 180): string => {
  const normalized = (value ?? "").replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
};

const uniqueStrings = (values: Array<string | null | undefined>): string[] =>
  Array.from(new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0)));

const activeOpenLoops = (items: MemoryOpenLoop[]): MemoryOpenLoop[] => items.filter((item) => item.status !== "closed");

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

const scoreTrustItem = (item: NarrativeRecoveryTrustItem): number => {
  let score = 0;
  if (item.validationStatus === "attention") score += 220;
  if (item.freshnessStatus === "stale") score += 180;
  if (item.validationStatus === "unverified") score += 140;
  if (item.freshnessStatus === "suspect") score += 110;
  if (item.validationStatus === "verified") score += 30;
  if (item.trust === "durable-doc") score += 40;
  if (item.trust === "promoted-artifact") score += 30;
  if (item.lineage === "explicit" || item.lineage === "path-continuity") score += 20;
  if (item.lineage === "heuristic-high") score += 10;
  if (item.kind === "event") score -= 30;
  return score;
};

const toRecoverySource = (
  working: WorkingMemoryState | null,
  latestSession: SessionWrapRecord | null,
  recallPacket: RecallPacket | null,
): NarrativeRecoverySource => {
  if (working) return "working-memory";
  if (latestSession) return "latest-session";
  if (recallPacket) return "recall";
  return "none";
};

const projectDecision = (item: MemoryDecision): NarrativeRecoveryDecision => ({
  id: item.id,
  title: item.title,
  summary: compactText(item.summary, 220),
  relatedFiles: item.relatedFiles ?? [],
});

const projectOpenLoop = (item: MemoryOpenLoop): NarrativeRecoveryOpenLoop => ({
  id: item.id,
  title: item.title,
  status: item.status,
  nextAction: item.nextAction,
  sourceSessionId: item.sourceSessionId ?? null,
  relatedFiles: item.relatedFiles ?? [],
});

const projectRetrievalHit = (hit: RetrievalHit): NarrativeRecoveryHit => ({
  id: hit.chunkId,
  path: hit.path,
  sectionTitle: hit.sectionTitle,
  excerpt: compactText(hit.text ?? "", 180),
  scoreFinal: hit.scoreFinal,
  originType: hit.originType ?? "document",
  artifactId: hit.artifactId ?? null,
});

const threadToTrustItem = (thread: NarrativeDecisionThread): NarrativeRecoveryTrustItem => ({
  id: `thread:${thread.threadId}`,
  kind: "thread",
  title: thread.title,
  summary: compactText(`${thread.docType} thread · ${thread.nodeIds.length} node(s) · ${thread.docPaths.join(", ")}`, 220),
  threadId: thread.threadId,
  path: thread.docPaths[0] ?? null,
  artifactId: null,
  snapshotSha: thread.snapshotShas.at(-1) ?? null,
  freshnessStatus: thread.freshnessStatus,
  validationStatus: thread.validationStatus,
  trust: thread.badges.trust,
  sensitivity: thread.badges.sensitivity,
  lineage: thread.badges.lineageKinds[0] ?? null,
  reasonCodes: uniqueStrings([...thread.driftReasonCodes, ...thread.validationReasonCodes]),
  evidenceRefs: [...thread.validationEvidenceRefs],
  recommendedActions: uniqueStrings([...thread.recommendedActions, ...thread.validationRecommendedActions]),
});

const nodeToTrustItem = (node: NarrativeDecisionNode): NarrativeRecoveryTrustItem => ({
  id: `node:${node.nodeId}`,
  kind: "node",
  title: node.title,
  summary: compactText(`${node.changeType} · ${node.summary}`, 220),
  threadId: node.threadId,
  path: node.path,
  artifactId: node.sourceArtifactId,
  snapshotSha: node.commitSha,
  freshnessStatus: node.freshnessStatus,
  validationStatus: node.validationStatus,
  trust: node.badges.trust,
  sensitivity: node.badges.sensitivity,
  lineage: node.badges.lineage,
  reasonCodes: uniqueStrings([...node.driftReasonCodes, ...node.validationReasonCodes]),
  evidenceRefs: [...node.validationEvidenceRefs],
  recommendedActions: uniqueStrings([...node.recommendedActions, ...node.validationRecommendedActions]),
});

const intentToTrustItem = (item: NarrativeIntentItem): NarrativeRecoveryTrustItem => ({
  id: `intent:${item.itemId}`,
  kind: "intent",
  title: item.title,
  summary: compactText(`${item.kind} · ${item.summary}`, 220),
  threadId: item.threadIds[0] ?? null,
  path: item.relatedPaths[0] ?? null,
  artifactId: item.artifactId,
  snapshotSha: item.anchorSha,
  freshnessStatus: item.freshnessStatus,
  validationStatus: item.validationStatus,
  trust: item.badges.trust,
  sensitivity: item.badges.sensitivity,
  lineage: null,
  reasonCodes: uniqueStrings([...item.driftReasonCodes, ...item.validationReasonCodes]),
  evidenceRefs: [...item.validationEvidenceRefs],
  recommendedActions: uniqueStrings([...item.recommendedActions, ...item.validationRecommendedActions]),
});

const eventToTrustItem = (event: NarrativeEventItem): NarrativeRecoveryTrustItem => ({
  id: `event:${event.eventId}`,
  kind: "event",
  title: event.eventType,
  summary: compactText(event.summary, 220),
  threadId: event.threadIds[0] ?? null,
  path: event.relatedPaths[0] ?? null,
  artifactId: null,
  snapshotSha: event.sourceHeadSha,
  freshnessStatus: null,
  validationStatus: null,
  trust: event.badges.trust,
  sensitivity: event.badges.sensitivity,
  lineage: null,
  reasonCodes: [],
  evidenceRefs: [],
  recommendedActions: [],
});

const buildTrustItems = (
  viewModel: Omit<NarrativeViewModel, "recovery" | "recoveryProfile">,
): NarrativeRecoveryTrustItem[] => {
  const candidates = [
    ...viewModel.threads.map(threadToTrustItem),
    ...viewModel.nodes.map(nodeToTrustItem),
    ...viewModel.intentItems.map(intentToTrustItem),
    ...viewModel.unassignedIntentItems.map(intentToTrustItem),
    ...viewModel.timelineEvents.map(eventToTrustItem),
  ];

  return candidates
    .sort((left, right) => {
      const byScore = scoreTrustItem(right) - scoreTrustItem(left);
      if (byScore !== 0) return byScore;
      return left.title.localeCompare(right.title);
    })
    .slice(0, MAX_TRUST_ITEMS);
};

const buildRecoverNow = (
  working: WorkingMemoryState | null,
  latestSession: SessionWrapRecord | null,
  recallPacket: RecallPacket | null,
  trustItems: NarrativeRecoveryTrustItem[],
): NarrativeRecoveryView["recoverNow"] => {
  const source = toRecoverySource(working, latestSession, recallPacket);
  const goal = working?.goal ?? latestSession?.goal ?? recallPacket?.goal ?? null;
  const summary = working?.summary ?? latestSession?.summary ?? null;
  const constraints = uniqueStrings([...(working?.constraints ?? []), ...(latestSession?.constraints ?? []), ...(recallPacket?.constraints ?? [])]);
  const openLoops = activeOpenLoops(working?.openLoops ?? latestSession?.openLoops ?? []).map(projectOpenLoop);
  const nextActions = uniqueStrings([...(working?.nextActions ?? []), ...(latestSession?.nextActions ?? []), ...(recallPacket?.nextActions ?? [])]);
  const durableDecisions = uniqueBy(
    [
      ...(working?.decisions ?? []).map(projectDecision),
      ...(latestSession?.decisions ?? []).map(projectDecision),
      ...(recallPacket?.relatedDecisions ?? []).map(projectDecision),
    ],
    (item) => item.id,
  ).slice(0, MAX_DURABLE_DECISIONS);
  const retrievedHits = (recallPacket?.retrievedHits ?? []).slice(0, MAX_RECALL_HITS).map(projectRetrievalHit);

  const priorityItems: NarrativeRecoveryPriorityItem[] = [
    ...openLoops.map((item): NarrativeRecoveryPriorityItem => ({
      id: `open-loop:${item.id}`,
      kind: "open-loop" as const,
      title: item.title,
      summary: compactText(item.nextAction || item.title, 180),
      source,
      threadId: null,
      path: item.relatedFiles[0] ?? null,
      artifactId: null,
      snapshotSha: null,
      freshnessStatus: null,
      validationStatus: null,
      trust: null,
      sensitivity: null,
      reasonCodes: item.status === "blocked" ? ["blocked"] : [],
      recommendedActions: [item.nextAction],
    })),
    ...nextActions.map((action, index): NarrativeRecoveryPriorityItem => ({
      id: `next-action:${index}:${action}`,
      kind: "next-action" as const,
      title: action,
      summary: compactText(action, 180),
      source,
      threadId: null,
      path: null,
      artifactId: null,
      snapshotSha: null,
      freshnessStatus: null,
      validationStatus: null,
      trust: null,
      sensitivity: null,
      reasonCodes: [],
      recommendedActions: [action],
    })),
    ...constraints.map((constraint, index): NarrativeRecoveryPriorityItem => ({
      id: `constraint:${index}:${constraint}`,
      kind: "constraint" as const,
      title: constraint,
      summary: compactText(constraint, 180),
      source,
      threadId: null,
      path: null,
      artifactId: null,
      snapshotSha: null,
      freshnessStatus: null,
      validationStatus: null,
      trust: null,
      sensitivity: null,
      reasonCodes: [],
      recommendedActions: [],
    })),
    ...durableDecisions.map((decision): NarrativeRecoveryPriorityItem => ({
      id: `decision:${decision.id}`,
      kind: "decision" as const,
      title: decision.title,
      summary: decision.summary,
      source: source === "none" ? "recall" : source,
      threadId: null,
      path: decision.relatedFiles[0] ?? null,
      artifactId: null,
      snapshotSha: null,
      freshnessStatus: null,
      validationStatus: null,
      trust: "durable-doc",
      sensitivity: "standard",
      reasonCodes: [],
      recommendedActions: [],
    })),
    ...retrievedHits.map((hit): NarrativeRecoveryPriorityItem => ({
      id: `retrieval:${hit.id}`,
      kind: "retrieval-hit" as const,
      title: hit.sectionTitle || hit.path,
      summary: hit.excerpt,
      source: "recall" as const,
      threadId: null,
      path: hit.path,
      artifactId: hit.artifactId,
      snapshotSha: recallPacket?.snapshotSha ?? null,
      freshnessStatus: null,
      validationStatus: null,
      trust: hit.originType === "artifact" ? "reviewed-artifact" : "durable-doc",
      sensitivity: "standard",
      reasonCodes: [],
      recommendedActions: [],
    })),
    ...trustItems.slice(0, 4).map((item): NarrativeRecoveryPriorityItem => ({
      id: `trust:${item.id}`,
      kind: item.kind === "intent" ? "intent" : "thread",
      title: item.title,
      summary: item.summary,
      source: "narrative" as const,
      threadId: item.threadId,
      path: item.path,
      artifactId: item.artifactId,
      snapshotSha: item.snapshotSha,
      freshnessStatus: item.freshnessStatus,
      validationStatus: item.validationStatus,
      trust: item.trust,
      sensitivity: item.sensitivity,
      reasonCodes: item.reasonCodes,
      recommendedActions: item.recommendedActions,
    })),
  ];

  return {
    source,
    goal,
    summary,
    latestSessionId: working?.latestSessionId ?? latestSession?.sessionId ?? recallPacket?.latestSessionId ?? null,
    episodeId: working?.episode?.id ?? latestSession?.episode?.id ?? null,
    sourceHeadSha: working?.sourceHeadSha ?? latestSession?.sourceHeadSha ?? recallPacket?.sourceHeadSha ?? null,
    updatedAt: working?.updatedAt ?? latestSession?.createdAt ?? recallPacket?.createdAt ?? null,
    constraints,
    openLoops,
    nextActions,
    durableDecisions,
    retrievedHits,
    priorityItems: priorityItems.slice(0, MAX_PRIORITY_ITEMS),
  };
};

const buildFormationSteps = (
  viewModel: Omit<NarrativeViewModel, "recovery" | "recoveryProfile">,
  latestSession: SessionWrapRecord | null,
  working: WorkingMemoryState | null,
): NarrativeRecoveryFormationStep[] => {
  const steps: NarrativeRecoveryFormationStep[] = [];

  if (latestSession) {
    steps.push({
      id: `memory-session:${latestSession.sessionId}`,
      kind: "memory",
      title: latestSession.goal,
      summary: compactText(latestSession.summary, 220),
      recordedAt: latestSession.createdAt,
      threadId: null,
      snapshotSha: latestSession.sourceHeadSha,
      path: null,
      artifactId: latestSession.artifactRefs[0] ?? null,
      freshnessStatus: null,
      validationStatus: null,
      trust: null,
      sensitivity: null,
      lineage: null,
    });
  }

  if (working && working.latestSessionId !== latestSession?.sessionId) {
    steps.push({
      id: `memory-working:${working.latestSessionId ?? "current"}`,
      kind: "memory",
      title: working.goal,
      summary: compactText(working.summary, 220),
      recordedAt: working.updatedAt,
      threadId: null,
      snapshotSha: working.sourceHeadSha,
      path: null,
      artifactId: working.artifactRefs[0] ?? null,
      freshnessStatus: null,
      validationStatus: null,
      trust: null,
      sensitivity: null,
      lineage: null,
    });
  }

  steps.push(
    ...viewModel.nodes.map((node) => ({
      id: `decision:${node.nodeId}`,
      kind: "decision" as const,
      title: node.title,
      summary: compactText(`${node.changeType} · ${node.summary}`, 220),
      recordedAt: node.authoredAt,
      threadId: node.threadId,
      snapshotSha: node.commitSha,
      path: node.path,
      artifactId: node.sourceArtifactId,
      freshnessStatus: node.freshnessStatus,
      validationStatus: node.validationStatus,
      trust: node.badges.trust,
      sensitivity: node.badges.sensitivity,
      lineage: node.badges.lineage,
    })),
  );

  steps.push(
    ...viewModel.intentItems.map((item) => ({
      id: `intent:${item.itemId}`,
      kind: "intent" as const,
      title: item.title,
      summary: compactText(item.summary, 220),
      recordedAt: item.createdAt,
      threadId: item.threadIds[0] ?? null,
      snapshotSha: item.anchorSha,
      path: item.relatedPaths[0] ?? null,
      artifactId: item.artifactId,
      freshnessStatus: item.freshnessStatus,
      validationStatus: item.validationStatus,
      trust: item.badges.trust,
      sensitivity: item.badges.sensitivity,
      lineage: null,
    })),
  );

  steps.push(
    ...viewModel.timelineEvents.map((event) => ({
      id: `event:${event.eventId}`,
      kind: "event" as const,
      title: event.eventType,
      summary: compactText(event.summary, 220),
      recordedAt: event.recordedAt,
      threadId: event.threadIds[0] ?? null,
      snapshotSha: event.sourceHeadSha,
      path: event.relatedPaths[0] ?? null,
      artifactId: null,
      freshnessStatus: null,
      validationStatus: null,
      trust: event.badges.trust,
      sensitivity: event.badges.sensitivity,
      lineage: null,
    })),
  );

  return steps
    .sort((left, right) => {
      const byTime = compareIsoDatesDescending(left.recordedAt, right.recordedAt);
      if (byTime !== 0) return byTime;
      return left.id.localeCompare(right.id);
    })
    .slice(0, MAX_FORMATION_STEPS)
    .reverse();
};

const convertLegacyRecoveryViewToProfile = (recovery: NarrativeRecoveryView): NarrativeRecoveryProfile => {
  const recoverNowItems = uniqueBy(
    recovery.recoverNow.priorityItems.map((item, index) => ({
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
      summary: item.summary,
      rank: index + 1,
      source: item.source,
      sourceRef: item.source === "none" ? "narrative" : item.source,
      snapshotSha: item.snapshotSha,
      threadId: item.threadId,
      nodeId: null,
      relatedPaths: uniqueStrings([item.path]),
      status: item.kind === "open-loop" && item.reasonCodes.includes("blocked") ? "blocked" : null,
    })),
    (item) => item.itemId,
  ).slice(0, MAX_PRIORITY_ITEMS);

  const trustItems = uniqueBy(
    recovery.trustItems.map((item, index) => ({
      itemId: item.id,
      kind: item.kind,
      title: item.title,
      summary: item.summary,
      rank: index + 1,
      threadId: item.threadId,
      freshnessStatus: item.freshnessStatus,
      validationStatus: item.validationStatus,
      trustBadge: item.trust,
      sensitivity: item.sensitivity,
      lineageKinds: uniqueStrings(item.lineage ? [item.lineage] : []) as Array<NonNullable<NarrativeRecoveryTrustItem["lineage"]>>,
      sourceRef: item.threadId ?? item.path ?? item.artifactId ?? item.snapshotSha ?? item.id,
      relatedPaths: uniqueStrings([item.path]),
      reasonCodes: uniqueStrings(item.reasonCodes),
      evidenceRefs: uniqueStrings(item.evidenceRefs),
      recommendedActions: uniqueStrings(item.recommendedActions),
    })),
    (item) => item.itemId,
  ).slice(0, MAX_TRUST_ITEMS);

  const steps = uniqueBy(
    recovery.formationSteps.map((step, index) => ({
      itemId: step.id,
      kind: step.kind,
      title: step.title,
      summary: step.summary,
      rank: index + 1,
      refId: step.artifactId ?? step.path ?? step.threadId ?? step.snapshotSha ?? step.id,
      when: step.recordedAt,
      relatedPaths: uniqueStrings([step.path]),
      threadId: step.threadId,
    })),
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
      snapshotCount: steps.filter((item) => item.kind === "snapshot").length,
      threadCount: trustItems.filter((item) => item.kind === "thread").length,
      intentCount: trustItems.filter((item) => item.kind === "intent").length,
      eventCount: trustItems.filter((item) => item.kind === "event").length,
    },
    empty: recoverNowItems.length === 0 && trustItems.length === 0 && steps.length === 0,
  };
};

export const normalizeNarrativeRecoveryProfile = (value: unknown): NarrativeRecoveryProfile => {
  const fallback = emptyNarrativeRecoveryProfile();
  if (!isPlainObject(value)) return fallback;

  if (isPlainObject(value.recoverNow) && Array.isArray((value.recoverNow as Record<string, unknown>).items)) {
    const recoverNowValue = value.recoverNow as Record<string, unknown>;
    const whatToTrustValue = isPlainObject(value.whatToTrust) ? value.whatToTrust : {};
    const howWeGotHereValue = isPlainObject(value.howWeGotHere) ? value.howWeGotHere : {};
    const normalized = sanitizeStructuredValue(
      {
        recoverNow: {
          source:
            recoverNowValue.source === "working-memory" ||
            recoverNowValue.source === "latest-session" ||
            recoverNowValue.source === "recall" ||
            recoverNowValue.source === "narrative" ||
            recoverNowValue.source === "none"
              ? recoverNowValue.source
              : fallback.recoverNow.source,
          items: Array.isArray(recoverNowValue.items) ? recoverNowValue.items : fallback.recoverNow.items,
          currentGoal: typeof recoverNowValue.currentGoal === "string" ? recoverNowValue.currentGoal : null,
          currentSummary: typeof recoverNowValue.currentSummary === "string" ? recoverNowValue.currentSummary : null,
          latestSessionId: typeof recoverNowValue.latestSessionId === "string" ? recoverNowValue.latestSessionId : null,
          openLoopCount:
            typeof recoverNowValue.openLoopCount === "number" && Number.isFinite(recoverNowValue.openLoopCount)
              ? recoverNowValue.openLoopCount
              : 0,
          nextActionCount:
            typeof recoverNowValue.nextActionCount === "number" && Number.isFinite(recoverNowValue.nextActionCount)
              ? recoverNowValue.nextActionCount
              : 0,
          stableDecisionCount:
            typeof recoverNowValue.stableDecisionCount === "number" && Number.isFinite(recoverNowValue.stableDecisionCount)
              ? recoverNowValue.stableDecisionCount
              : 0,
        },
        whatToTrust: {
          items: Array.isArray((whatToTrustValue as Record<string, unknown>).items)
            ? (whatToTrustValue as Record<string, unknown>).items
            : fallback.whatToTrust.items,
          freshnessCounts: {
            fresh:
              typeof (whatToTrustValue as Record<string, unknown>).freshnessCounts === "object" &&
              (whatToTrustValue as Record<string, unknown>).freshnessCounts !== null &&
              typeof ((whatToTrustValue as Record<string, unknown>).freshnessCounts as Record<string, unknown>).fresh === "number"
                ? (((whatToTrustValue as Record<string, unknown>).freshnessCounts as Record<string, unknown>).fresh as number)
                : 0,
            suspect:
              typeof (whatToTrustValue as Record<string, unknown>).freshnessCounts === "object" &&
              (whatToTrustValue as Record<string, unknown>).freshnessCounts !== null &&
              typeof ((whatToTrustValue as Record<string, unknown>).freshnessCounts as Record<string, unknown>).suspect === "number"
                ? (((whatToTrustValue as Record<string, unknown>).freshnessCounts as Record<string, unknown>).suspect as number)
                : 0,
            stale:
              typeof (whatToTrustValue as Record<string, unknown>).freshnessCounts === "object" &&
              (whatToTrustValue as Record<string, unknown>).freshnessCounts !== null &&
              typeof ((whatToTrustValue as Record<string, unknown>).freshnessCounts as Record<string, unknown>).stale === "number"
                ? (((whatToTrustValue as Record<string, unknown>).freshnessCounts as Record<string, unknown>).stale as number)
                : 0,
          },
          validationCounts: {
            verified:
              typeof (whatToTrustValue as Record<string, unknown>).validationCounts === "object" &&
              (whatToTrustValue as Record<string, unknown>).validationCounts !== null &&
              typeof ((whatToTrustValue as Record<string, unknown>).validationCounts as Record<string, unknown>).verified === "number"
                ? (((whatToTrustValue as Record<string, unknown>).validationCounts as Record<string, unknown>).verified as number)
                : 0,
            attention:
              typeof (whatToTrustValue as Record<string, unknown>).validationCounts === "object" &&
              (whatToTrustValue as Record<string, unknown>).validationCounts !== null &&
              typeof ((whatToTrustValue as Record<string, unknown>).validationCounts as Record<string, unknown>).attention === "number"
                ? (((whatToTrustValue as Record<string, unknown>).validationCounts as Record<string, unknown>).attention as number)
                : 0,
            unverified:
              typeof (whatToTrustValue as Record<string, unknown>).validationCounts === "object" &&
              (whatToTrustValue as Record<string, unknown>).validationCounts !== null &&
              typeof ((whatToTrustValue as Record<string, unknown>).validationCounts as Record<string, unknown>).unverified === "number"
                ? (((whatToTrustValue as Record<string, unknown>).validationCounts as Record<string, unknown>).unverified as number)
                : 0,
          },
        },
        howWeGotHere: {
          steps: Array.isArray((howWeGotHereValue as Record<string, unknown>).steps)
            ? (howWeGotHereValue as Record<string, unknown>).steps
            : fallback.howWeGotHere.steps,
          snapshotCount:
            typeof (howWeGotHereValue as Record<string, unknown>).snapshotCount === "number" &&
            Number.isFinite((howWeGotHereValue as Record<string, unknown>).snapshotCount)
              ? ((howWeGotHereValue as Record<string, unknown>).snapshotCount as number)
              : 0,
          threadCount:
            typeof (howWeGotHereValue as Record<string, unknown>).threadCount === "number" &&
            Number.isFinite((howWeGotHereValue as Record<string, unknown>).threadCount)
              ? ((howWeGotHereValue as Record<string, unknown>).threadCount as number)
              : 0,
          intentCount:
            typeof (howWeGotHereValue as Record<string, unknown>).intentCount === "number" &&
            Number.isFinite((howWeGotHereValue as Record<string, unknown>).intentCount)
              ? ((howWeGotHereValue as Record<string, unknown>).intentCount as number)
              : 0,
          eventCount:
            typeof (howWeGotHereValue as Record<string, unknown>).eventCount === "number" &&
            Number.isFinite((howWeGotHereValue as Record<string, unknown>).eventCount)
              ? ((howWeGotHereValue as Record<string, unknown>).eventCount as number)
              : 0,
        },
        empty: typeof value.empty === "boolean" ? value.empty : fallback.empty,
      },
      "narrative.output",
      "narrative.recoveryProfile",
    );
    return (normalized.value as NarrativeRecoveryProfile | null) ?? fallback;
  }

  if (
    (isPlainObject(value.recoverNow) && Array.isArray((value.recoverNow as Record<string, unknown>).priorityItems)) ||
    Array.isArray(value.trustItems) ||
    Array.isArray(value.formationSteps)
  ) {
    return convertLegacyRecoveryViewToProfile(value as unknown as NarrativeRecoveryView);
  }

  return fallback;
};

export const buildRecoveryView = async (
  cwd: string,
  viewModel: Omit<NarrativeViewModel, "recovery" | "recoveryProfile">,
): Promise<NarrativeRecoveryView> => {
  const warnings: string[] = [];
  const working = await loadWorkingMemoryState(cwd);
  const latestSession = await loadLatestSessionWrap(cwd);

  let recallPacket: RecallPacket | null = null;
  const recoveryGoal = working?.goal ?? latestSession?.goal ?? null;
  if (recoveryGoal) {
    try {
      const recalled = await recallMemory(cwd, recoveryGoal);
      recallPacket = recalled.packet;
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown recall error";
      warnings.push(`recovery recall failed: ${message}`);
    }
  }

  const trustItems = buildTrustItems(viewModel);
  const recovery: NarrativeRecoveryView = {
    recoverNow: buildRecoverNow(working, latestSession, recallPacket, trustItems),
    trustItems,
    formationSteps: buildFormationSteps(viewModel, latestSession, working),
    warnings,
  };

  const sanitized = sanitizeStructuredValue(recovery, "narrative.output", "narrative.recovery");
  return sanitized.value as NarrativeRecoveryView;
};

export const buildNarrativeRecoveryProfile = buildRecoveryView;
