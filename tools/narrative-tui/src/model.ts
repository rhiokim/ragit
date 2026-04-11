import { readFile } from "node:fs/promises";
import path from "node:path";

export type FilterScope = "all" | "threads" | "decisions" | "intent" | "events";
export const NARRATIVE_MODEL_SCHEMA_VERSION = 1;
export const NARRATIVE_MODEL_LEGACY_PRODUCER_VERSION = "legacy-unversioned";
export const NARRATIVE_PROJECTION_POLICY_VERSION = 1;
export const NARRATIVE_PROJECTION_MODE = "viewer-safe";
export type NarrativeProjectionMode = typeof NARRATIVE_PROJECTION_MODE;
export type NarrativeTrustBadge = "durable-doc" | "reviewed-artifact" | "promoted-artifact" | "operational-event";
export type NarrativeSensitivityBadge = "standard" | "redacted" | "restricted";
export type NarrativeFreshnessStatus = "fresh" | "suspect" | "stale";

export interface NarrativeFreshnessCounts {
  fresh: number;
  suspect: number;
  stale: number;
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
  warnings: string[];
  empty: boolean;
}

export interface ExplorerState {
  query: string;
  scope: FilterScope;
  selectedThreadId: string | null;
  selectedIntentId: string | null;
  selectedEventId: string | null;
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
  badges: NarrativeModel["threads"][number]["badges"];
  relationKinds: string[];
  searchText: string;
}

export interface ExplorerIntentView {
  itemId: string;
  artifactId?: string;
  kind: string;
  status: string;
  title: string;
  summary: string;
  anchorSha?: string | null;
  relatedPaths: string[];
  createdAt: string;
  threadIds: string[];
  binding: NarrativeModel["intentItems"][number]["binding"];
  freshnessStatus: NarrativeFreshnessStatus | null;
  driftReasonCodes: string[];
  recommendedActions: string[];
  driftSourceRefs: string[];
  badges: NarrativeModel["intentItems"][number]["badges"];
  searchText: string;
}

export interface ExplorerEventView {
  eventId: string;
  eventType: string;
  recordedAt: string;
  summary: string;
  sourceHeadSha?: string | null;
  relatedPaths: string[];
  threadIds: string[];
  binding: NarrativeModel["timelineEvents"][number]["binding"];
  badges: NarrativeModel["timelineEvents"][number]["badges"];
  searchText: string;
}

export interface ExplorerDetail {
  kind: "thread" | "intent" | "event" | "empty";
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
  extra: string[];
}

export interface ExplorerView {
  threads: ExplorerThreadView[];
  visibleThreads: ExplorerThreadView[];
  selectedThread: ExplorerThreadView | null;
  assignedIntentItems: ExplorerIntentView[];
  unassignedIntentItems: ExplorerIntentView[];
  timelineEvents: ExplorerEventView[];
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

const coerceFreshnessCounts = (value: unknown): NarrativeFreshnessCounts => {
  if (!isPlainObject(value)) return emptyFreshnessCounts();
  return {
    fresh: typeof value.fresh === "number" && Number.isFinite(value.fresh) ? value.fresh : 0,
    suspect: typeof value.suspect === "number" && Number.isFinite(value.suspect) ? value.suspect : 0,
    stale: typeof value.stale === "number" && Number.isFinite(value.stale) ? value.stale : 0,
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

const attachDriftOverlayDefaults = <T extends object>(value: T): T & ReturnType<typeof emptyDriftOverlayFields> => ({
  ...value,
  ...coerceDriftOverlayFields(value),
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

const normalizeNarrativeModel = (value: unknown): NarrativeModel => {
  if (!isPlainObject(value) || !hasNarrativeModelCoreShape(value)) {
    throw new Error("Narrative model file did not contain a valid narrative payload.");
  }

  if (typeof value.schemaVersion !== "number" || !Number.isInteger(value.schemaVersion)) {
    const legacyValue = value as Omit<
      NarrativeModel,
      "schemaVersion" | "producerVersion" | "projectionPolicyVersion" | "projectionMode"
    >;
    return {
      schemaVersion: NARRATIVE_MODEL_SCHEMA_VERSION,
      producerVersion: NARRATIVE_MODEL_LEGACY_PRODUCER_VERSION,
      projectionPolicyVersion: NARRATIVE_PROJECTION_POLICY_VERSION,
      projectionMode: NARRATIVE_PROJECTION_MODE,
      ...legacyValue,
      summary: {
        ...legacyValue.summary,
        freshnessCounts: coerceFreshnessCounts((legacyValue.summary as unknown as Record<string, unknown>).freshnessCounts),
      },
      threads: Array.isArray(legacyValue.threads)
        ? (legacyValue.threads.map((thread) => attachDriftOverlayDefaults(thread)) as NarrativeDecisionThread[])
        : [],
      nodes: Array.isArray(legacyValue.nodes)
        ? (legacyValue.nodes.map((node) => attachDriftOverlayDefaults(node)) as NarrativeDecisionNode[])
        : [],
      intentItems: Array.isArray(legacyValue.intentItems)
        ? (legacyValue.intentItems.map((item) => attachDriftOverlayDefaults(item)) as NarrativeIntentItem[])
        : [],
      unassignedIntentItems: Array.isArray(legacyValue.unassignedIntentItems)
        ? (legacyValue.unassignedIntentItems.map((item) => attachDriftOverlayDefaults(item)) as NarrativeIntentItem[])
        : [],
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
  const projectionMode = value.projectionMode === NARRATIVE_PROJECTION_MODE ? value.projectionMode : NARRATIVE_PROJECTION_MODE;

  return {
    ...(value as NarrativeModel),
    producerVersion:
      typeof value.producerVersion === "string" && value.producerVersion.trim().length > 0
        ? value.producerVersion
        : "unknown",
    projectionPolicyVersion,
    projectionMode,
    summary: {
      ...(value.summary as NarrativeSummary),
      freshnessCounts: coerceFreshnessCounts((value.summary as unknown as Record<string, unknown>).freshnessCounts),
    },
    threads: Array.isArray(value.threads) ? value.threads.map((thread) => attachDriftOverlayDefaults(thread)) : [],
    nodes: Array.isArray(value.nodes) ? value.nodes.map((node) => attachDriftOverlayDefaults(node)) : [],
    intentItems: Array.isArray(value.intentItems) ? value.intentItems.map((item) => attachDriftOverlayDefaults(item)) : [],
    unassignedIntentItems: Array.isArray(value.unassignedIntentItems)
      ? value.unassignedIntentItems.map((item) => attachDriftOverlayDefaults(item))
      : [],
  };
};

export const loadNarrativeModel = async (modelPath: string): Promise<NarrativeModel> => {
  const absolutePath = path.resolve(process.cwd(), modelPath);
  const content = await readFile(absolutePath, "utf8");
  const parsed = JSON.parse(content) as unknown;
  return normalizeNarrativeModel(parsed);
};

export const buildThreadViews = (model: NarrativeModel): ExplorerThreadView[] => {
  return model.threads.map((thread) => {
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
      `goals ${thread.binding.goalCount}`,
      `episodes ${thread.binding.episodeCount}`,
      `sessions ${thread.binding.sessionCount}`,
      nodes.map((node) => [node.title, node.summary, node.path, node.changeType, node.relationKind].join(" ")).join(" "),
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
      badges: thread.badges,
      relationKinds,
      searchText,
    };
  });
};

const buildIntentViews = (items: NarrativeModel["intentItems"] | NarrativeModel["unassignedIntentItems"]): ExplorerIntentView[] =>
  items.map((item) => ({
    itemId: item.itemId,
    artifactId: item.artifactId,
    kind: item.kind,
    status: item.status,
    title: item.title,
    summary: item.summary,
    anchorSha: item.anchorSha ?? null,
    relatedPaths: asArray(item.relatedPaths).filter((value) => typeof value === "string"),
    createdAt: item.createdAt,
    threadIds: asArray(item.threadIds).filter((value) => typeof value === "string"),
    binding: item.binding,
    freshnessStatus: item.freshnessStatus,
    driftReasonCodes: item.driftReasonCodes,
    recommendedActions: item.recommendedActions,
    driftSourceRefs: item.driftSourceRefs,
    badges: item.badges,
    searchText: [
      item.title,
      item.summary,
      item.kind,
      item.status,
      item.badges.trust,
      item.badges.sensitivity,
      item.freshnessStatus ?? "",
      item.driftReasonCodes.join(" "),
      item.recommendedActions.join(" "),
      item.driftSourceRefs.join(" "),
      `goals ${item.binding.goalCount}`,
      `episodes ${item.binding.episodeCount}`,
      `sessions ${item.binding.sessionCount}`,
      item.anchorSha ?? "",
      asArray(item.relatedPaths).join(" "),
      asArray(item.threadIds).join(" "),
    ]
      .filter(Boolean)
      .join(" "),
  }));

const buildEventViews = (items: NarrativeModel["timelineEvents"]): ExplorerEventView[] =>
  items.map((event) => ({
    eventId: event.eventId,
    eventType: event.eventType,
    recordedAt: event.recordedAt,
    summary: event.summary,
    sourceHeadSha: event.sourceHeadSha ?? null,
    relatedPaths: asArray(event.relatedPaths).filter((value) => typeof value === "string"),
    threadIds: asArray(event.threadIds).filter((value) => typeof value === "string"),
    binding: event.binding,
    badges: event.badges,
    searchText: [
      event.eventType,
      event.summary,
      event.recordedAt,
      event.sourceHeadSha ?? "",
      event.badges.trust,
      event.badges.sensitivity,
      `goals ${event.binding.goalCount}`,
      `episodes ${event.binding.episodeCount}`,
      `sessions ${event.binding.sessionCount}`,
      asArray(event.relatedPaths).join(" "),
      asArray(event.threadIds).join(" "),
    ]
      .filter(Boolean)
      .join(" "),
  }));

const chooseSelectedThread = (
  threads: ExplorerThreadView[],
  selectedThreadId: string | null,
): ExplorerThreadView | null => {
  if (threads.length === 0) return null;
  const explicit = selectedThreadId ? threads.find((thread) => thread.threadId === selectedThreadId) : null;
  return explicit ?? threads[0] ?? null;
};

const buildThreadDetail = (thread: ExplorerThreadView | null): ExplorerDetail => {
  if (!thread) {
    return {
      kind: "empty",
      title: "No thread selected",
      summary: "Select a thread to inspect its decision evolution and linked intent/event items.",
      path: "none",
      artifactId: "none",
      snapshotSha: "none",
      relationKind: "none",
      confidence: "none",
      freshnessStatus: null,
      driftReasonCodes: [],
      recommendedActions: [],
      driftSourceRefs: [],
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
    extra: [
      `trust: ${thread.badges.trust}`,
      `sensitivity: ${thread.badges.sensitivity}`,
      `freshness: ${thread.freshnessStatus ?? "none"}`,
      `reasons: ${thread.driftReasonCodes.length > 0 ? thread.driftReasonCodes.join(", ") : "none"}`,
      `actions: ${thread.recommendedActions.length > 0 ? thread.recommendedActions.join(", ") : "none"}`,
      `drift sources: ${thread.driftSourceRefs.length}`,
      `bindings: goals=${thread.binding.goalCount}, episodes=${thread.binding.episodeCount}, sessions=${thread.binding.sessionCount}, relatedPaths=${thread.binding.relatedPathCount}`,
    ],
  };
};

const buildItemDetail = (
  kind: "intent" | "event",
  title: string,
  summary: string,
  path: string,
  artifactId: string,
  snapshotSha: string,
  relationKind: string,
  confidence: string,
  freshnessStatus: NarrativeFreshnessStatus | null,
  driftReasonCodes: string[],
  recommendedActions: string[],
  driftSourceRefs: string[],
  extra: string[],
): ExplorerDetail => ({
  kind,
  title,
  summary,
  path,
  artifactId,
  snapshotSha,
  relationKind,
  confidence,
  freshnessStatus,
  driftReasonCodes,
  recommendedActions,
  driftSourceRefs,
  extra,
});

export const isIntentLinkedToThread = (thread: ExplorerThreadView, item: ExplorerIntentView): boolean =>
  item.threadIds.includes(thread.threadId) ||
  arraysIntersect(thread.docPaths, item.relatedPaths) ||
  (item.anchorSha ? thread.snapshotShas.includes(item.anchorSha) : false);

export const isEventLinkedToThread = (thread: ExplorerThreadView, event: ExplorerEventView): boolean =>
  event.threadIds.includes(thread.threadId) ||
  arraysIntersect(thread.docPaths, event.relatedPaths) ||
  (event.sourceHeadSha ? thread.snapshotShas.includes(event.sourceHeadSha) : false);

const arraysIntersect = (left: string[], right: string[]): boolean => {
  const rightSet = new Set(right);
  return left.some((item) => rightSet.has(item));
};

export const buildExplorerView = (model: NarrativeModel, state: ExplorerState): ExplorerView => {
  const threads = buildThreadViews(model);
  const filterThreads = state.scope === "all" || state.scope === "threads" || state.scope === "decisions";
  const filterIntent = state.scope === "all" || state.scope === "intent";
  const filterEvents = state.scope === "all" || state.scope === "events";
  const filteredThreads = threads.filter((thread) => (filterThreads ? matchesQuery(thread.searchText, state.query) : true));
  const selectedThread = chooseSelectedThread(filteredThreads, state.selectedThreadId);
  const assignedIntents = buildIntentViews(model.intentItems);
  const unassignedIntents = buildIntentViews(model.unassignedIntentItems);
  const events = buildEventViews(model.timelineEvents);

  const filteredAssigned = assignedIntents.filter((item) => (filterIntent ? matchesQuery(item.searchText, state.query) : true));
  const filteredUnassigned = unassignedIntents.filter((item) => (filterIntent ? matchesQuery(item.searchText, state.query) : true));
  const filteredEvents = events.filter((event) => (filterEvents ? matchesQuery(event.searchText, state.query) : true));

  const prioritizedAssigned = selectedThread
    ? [
        ...filteredAssigned.filter((item) => isIntentLinkedToThread(selectedThread, item)),
        ...filteredAssigned.filter((item) => !isIntentLinkedToThread(selectedThread, item)),
      ]
    : filteredAssigned;

  const prioritizedUnassigned = selectedThread
    ? [
        ...filteredUnassigned.filter((item) => isIntentLinkedToThread(selectedThread, item)),
        ...filteredUnassigned.filter((item) => !isIntentLinkedToThread(selectedThread, item)),
      ]
    : filteredUnassigned;

  const prioritizedEvents = selectedThread
    ? [
        ...filteredEvents.filter((event) => isEventLinkedToThread(selectedThread, event)),
        ...filteredEvents.filter((event) => !isEventLinkedToThread(selectedThread, event)),
      ]
    : filteredEvents;

  const selectedIntent = [...prioritizedAssigned, ...prioritizedUnassigned].find((item) => item.itemId === state.selectedIntentId) ?? null;
  const selectedEvent = prioritizedEvents.find((event) => event.eventId === state.selectedEventId) ?? null;
  const selectedThreadOverlay = selectedThread
    ? {
        freshnessStatus: selectedThread.freshnessStatus,
        driftReasonCodes: selectedThread.driftReasonCodes,
        recommendedActions: selectedThread.recommendedActions,
        driftSourceRefs: selectedThread.driftSourceRefs,
      }
    : emptyDriftOverlayFields();

  const detail = selectedIntent
    ? buildItemDetail(
        "intent",
        selectedIntent.title,
        selectedIntent.summary,
        selectedIntent.relatedPaths.join(", ") || "none",
        selectedIntent.artifactId ?? "none",
        selectedIntent.anchorSha ?? "none",
        `${selectedIntent.kind} · ${selectedIntent.status}`,
        "n/a",
        selectedIntent.freshnessStatus,
        selectedIntent.driftReasonCodes,
        selectedIntent.recommendedActions,
        selectedIntent.driftSourceRefs,
        [
          `trust: ${selectedIntent.badges.trust}`,
          `sensitivity: ${selectedIntent.badges.sensitivity}`,
          `freshness: ${selectedIntent.freshnessStatus ?? "none"}`,
          `reasons: ${selectedIntent.driftReasonCodes.length > 0 ? selectedIntent.driftReasonCodes.join(", ") : "none"}`,
          `actions: ${selectedIntent.recommendedActions.length > 0 ? selectedIntent.recommendedActions.join(", ") : "none"}`,
          `drift sources: ${selectedIntent.driftSourceRefs.length}`,
          `bindings: goals=${selectedIntent.binding.goalCount}, episodes=${selectedIntent.binding.episodeCount}, sessions=${selectedIntent.binding.sessionCount}, relatedPaths=${selectedIntent.binding.relatedPathCount}`,
          `linked threads: ${selectedIntent.threadIds.length}`,
        ],
      )
    : selectedEvent
      ? buildItemDetail(
          "event",
          selectedEvent.eventType,
          selectedEvent.summary,
          selectedEvent.relatedPaths.join(", ") || "none",
          "none",
          selectedEvent.sourceHeadSha ?? "none",
          "event",
          "n/a",
          selectedThreadOverlay.freshnessStatus,
          selectedThreadOverlay.driftReasonCodes,
          selectedThreadOverlay.recommendedActions,
          selectedThreadOverlay.driftSourceRefs,
          [
            `trust: ${selectedEvent.badges.trust}`,
            `sensitivity: ${selectedEvent.badges.sensitivity}`,
            `freshness: ${selectedThreadOverlay.freshnessStatus ?? "none"}`,
            `reasons: ${selectedThreadOverlay.driftReasonCodes.length > 0 ? selectedThreadOverlay.driftReasonCodes.join(", ") : "none"}`,
            `actions: ${selectedThreadOverlay.recommendedActions.length > 0 ? selectedThreadOverlay.recommendedActions.join(", ") : "none"}`,
            `drift sources: ${selectedThreadOverlay.driftSourceRefs.length}`,
            `bindings: goals=${selectedEvent.binding.goalCount}, episodes=${selectedEvent.binding.episodeCount}, sessions=${selectedEvent.binding.sessionCount}, relatedPaths=${selectedEvent.binding.relatedPathCount}`,
            `linked threads: ${selectedEvent.threadIds.length}`,
          ],
        )
      : selectedThread
        ? buildThreadDetail(selectedThread)
        : {
            kind: "empty" as const,
            title: "No matching thread",
            summary: state.query.trim().length > 0
              ? "The current filter removes every decision thread. Clear the query or switch scope."
              : "No decision thread is available in the selected model window.",
            path: "none",
            artifactId: "none",
            snapshotSha: "none",
            relationKind: "none",
            confidence: "none",
            freshnessStatus: null,
            driftReasonCodes: [],
            recommendedActions: [],
            driftSourceRefs: [],
            extra: [],
          };

  return {
    threads,
    visibleThreads: filteredThreads,
    selectedThread,
    assignedIntentItems: prioritizedAssigned,
    unassignedIntentItems: prioritizedUnassigned,
    timelineEvents: prioritizedEvents,
    detail,
    empty: filteredThreads.length === 0,
  };
};

export const buildThreadOptionDescription = (thread: ExplorerThreadView, selected: boolean): string => {
  const badges = [
    thread.badges.trust,
    thread.badges.sensitivity,
    thread.freshnessStatus ? `freshness:${thread.freshnessStatus}` : "freshness:none",
    thread.driftReasonCodes.length > 0 ? `reasons:${thread.driftReasonCodes.slice(0, 2).join(", ")}` : "reasons:none",
    thread.relationKinds.length > 0 ? thread.relationKinds.join(" · ") : "root",
    `${thread.nodes.length} node(s)`,
    `${thread.snapshotShas.length} snapshot(s)`,
  ];
  if (selected) badges.unshift("selected");
  return `${thread.docType} · ${badges.join(" · ")} · ${thread.docPaths.join(", ")}`;
};

export const buildThreadOptionName = (thread: ExplorerThreadView, _selected: boolean): string =>
  `${buildFreshnessBadgeLabel(thread.freshnessStatus)} ${thread.title}`;

export const buildPlaceholderThreadOption = (): { name: string; description: string; value: string } => ({
  name: "No matching thread",
  description: "Clear the search query or change the filter scope.",
  value: "__empty__",
});

export const buildIntentOptionName = (item: ExplorerIntentView, linked: boolean): string =>
  `${buildFreshnessBadgeLabel(item.freshnessStatus)} ${linked ? "◆ " : ""}${item.title}`;

export const buildIntentOptionDescription = (item: ExplorerIntentView, linked: boolean): string =>
  `${item.kind} · ${item.status} · ${item.badges.trust} · ${item.badges.sensitivity} · ${
    item.freshnessStatus ? `freshness:${item.freshnessStatus}` : "freshness:none"
  }${linked ? " · linked" : ""} · ${
    item.driftReasonCodes.length > 0 ? `reasons:${item.driftReasonCodes.slice(0, 2).join(", ")}` : "reasons:none"
  } · ${item.summary}`;

export const buildEventOptionName = (item: ExplorerEventView, linked: boolean): string =>
  `${linked ? "◆ " : ""}${item.eventType} · ${item.recordedAt}`;

export const buildEventOptionDescription = (item: ExplorerEventView, linked: boolean): string =>
  `${item.badges.trust} · ${item.badges.sensitivity}${linked ? " · linked" : ""} · ${item.summary}`;

const summarizeList = (values: string[], limit = 2): string => {
  const items = uniqueStrings(values);
  if (items.length === 0) return "none";
  if (items.length <= limit) return items.join(", ");
  return `${items.slice(0, limit).join(", ")} +${items.length - limit} more`;
};

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
  `Drift Sources: ${driftSourceRefs.length}`,
];
