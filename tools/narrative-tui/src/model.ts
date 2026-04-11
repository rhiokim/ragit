import { readFile } from "node:fs/promises";
import path from "node:path";

export type FilterScope = "all" | "threads" | "decisions" | "intent" | "events";

export interface NarrativeModel {
  repoName: string;
  headSha: string;
  generatedAt: string;
  summary: {
    decisionThreads: number;
    decisionNodes: number;
    intentItems: number;
    timelineEvents: number;
    heuristicEdges: number;
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
    goalIds?: string[];
    episodeIds?: string[];
    sessionIds?: string[];
    snapshotShas: string[];
    nodeIds: string[];
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
    goalId?: string | null;
    episodeId?: string | null;
    sourceSessionId?: string | null;
    relatedPaths?: string[];
    sourceArtifactId?: string | null;
    predecessorNodeId?: string | null;
  }>;
  intentItems: Array<{
    itemId: string;
    artifactId?: string;
    kind: string;
    status: string;
    title: string;
    summary: string;
    goalId?: string | null;
    episodeId?: string | null;
    sourceSessionId?: string | null;
    anchorSha?: string | null;
    relatedPaths?: string[];
    createdAt: string;
    threadIds?: string[];
  }>;
  unassignedIntentItems: Array<{
    itemId: string;
    artifactId?: string;
    kind: string;
    status: string;
    title: string;
    summary: string;
    goalId?: string | null;
    episodeId?: string | null;
    sourceSessionId?: string | null;
    anchorSha?: string | null;
    relatedPaths?: string[];
    createdAt: string;
    threadIds?: string[];
  }>;
  timelineEvents: Array<{
    eventId: string;
    eventType: string;
    recordedAt: string;
    summary: string;
    sourceHeadSha?: string | null;
    goalId?: string | null;
    episodeId?: string | null;
    sessionId?: string | null;
    relatedPaths?: string[];
    threadIds?: string[];
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
  goalIds: string[];
  episodeIds: string[];
  sessionIds: string[];
  snapshotShas: string[];
  nodeIds: string[];
  nodes: NarrativeModel["nodes"];
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
  goalId?: string | null;
  episodeId?: string | null;
  sourceSessionId?: string | null;
  anchorSha?: string | null;
  relatedPaths: string[];
  createdAt: string;
  threadIds: string[];
  searchText: string;
}

export interface ExplorerEventView {
  eventId: string;
  eventType: string;
  recordedAt: string;
  summary: string;
  sourceHeadSha?: string | null;
  goalId?: string | null;
  episodeId?: string | null;
  sessionId?: string | null;
  relatedPaths: string[];
  threadIds: string[];
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

export const loadNarrativeModel = async (modelPath: string): Promise<NarrativeModel> => {
  const absolutePath = path.resolve(process.cwd(), modelPath);
  const content = await readFile(absolutePath, "utf8");
  const parsed = JSON.parse(content) as NarrativeModel;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Narrative model file did not contain an object.");
  }
  return parsed;
};

export const buildThreadViews = (model: NarrativeModel): ExplorerThreadView[] => {
  return model.threads.map((thread) => {
    const nodes = model.nodes.filter((node) => node.threadId === thread.threadId);
    const relationKinds = uniqueStrings(nodes.map((node) => node.relationKind));
    const searchText = [
      thread.title,
      thread.docType,
      thread.docPaths.join(" "),
      thread.goalIds?.join(" ") ?? "",
      thread.episodeIds?.join(" ") ?? "",
      thread.sessionIds?.join(" ") ?? "",
      thread.snapshotShas.join(" "),
      nodes.map((node) => [node.title, node.summary, node.path, node.changeType, node.relationKind].join(" ")).join(" "),
    ]
      .filter(Boolean)
      .join(" ");
    return {
      threadId: thread.threadId,
      title: thread.title,
      docType: thread.docType,
      docPaths: thread.docPaths,
      goalIds: uniqueStrings(thread.goalIds ?? []),
      episodeIds: uniqueStrings(thread.episodeIds ?? []),
      sessionIds: uniqueStrings(thread.sessionIds ?? []),
      snapshotShas: thread.snapshotShas,
      nodeIds: thread.nodeIds,
      nodes,
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
    goalId: item.goalId ?? null,
    episodeId: item.episodeId ?? null,
    sourceSessionId: item.sourceSessionId ?? null,
    anchorSha: item.anchorSha ?? null,
    relatedPaths: asArray(item.relatedPaths).filter((value) => typeof value === "string"),
    createdAt: item.createdAt,
    threadIds: asArray(item.threadIds).filter((value) => typeof value === "string"),
    searchText: [
      item.title,
      item.summary,
      item.kind,
      item.status,
      item.goalId ?? "",
      item.episodeId ?? "",
      item.sourceSessionId ?? "",
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
    goalId: event.goalId ?? null,
    episodeId: event.episodeId ?? null,
    sessionId: event.sessionId ?? null,
    relatedPaths: asArray(event.relatedPaths).filter((value) => typeof value === "string"),
    threadIds: asArray(event.threadIds).filter((value) => typeof value === "string"),
    searchText: [
      event.eventType,
      event.summary,
      event.recordedAt,
      event.sourceHeadSha ?? "",
      event.goalId ?? "",
      event.episodeId ?? "",
      event.sessionId ?? "",
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
    extra: [
      `goalIds: ${thread.goalIds.length > 0 ? thread.goalIds.join(", ") : "none"}`,
      `episodeIds: ${thread.episodeIds.length > 0 ? thread.episodeIds.join(", ") : "none"}`,
      `sessionIds: ${thread.sessionIds.length > 0 ? thread.sessionIds.join(", ") : "none"}`,
      `nodeIds: ${thread.nodeIds.join(", ")}`,
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
  extra,
});

export const isIntentLinkedToThread = (thread: ExplorerThreadView, item: ExplorerIntentView): boolean =>
  item.threadIds.includes(thread.threadId) ||
  arraysIntersect(thread.docPaths, item.relatedPaths) ||
  (item.goalId ? thread.goalIds.includes(item.goalId) : false) ||
  (item.episodeId ? thread.episodeIds.includes(item.episodeId) : false) ||
  (item.anchorSha ? thread.snapshotShas.includes(item.anchorSha) : false);

export const isEventLinkedToThread = (thread: ExplorerThreadView, event: ExplorerEventView): boolean =>
  event.threadIds.includes(thread.threadId) ||
  arraysIntersect(thread.docPaths, event.relatedPaths) ||
  (event.goalId ? thread.goalIds.includes(event.goalId) : false) ||
  (event.sessionId ? thread.sessionIds.includes(event.sessionId) : false) ||
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
        [
          `goalId: ${selectedIntent.goalId ?? "none"}`,
          `episodeId: ${selectedIntent.episodeId ?? "none"}`,
          `sessionId: ${selectedIntent.sourceSessionId ?? "none"}`,
          `threadIds: ${selectedIntent.threadIds.join(", ") || "none"}`,
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
          [
            `goalId: ${selectedEvent.goalId ?? "none"}`,
            `episodeId: ${selectedEvent.episodeId ?? "none"}`,
            `sessionId: ${selectedEvent.sessionId ?? "none"}`,
            `threadIds: ${selectedEvent.threadIds.join(", ") || "none"}`,
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
    thread.relationKinds.length > 0 ? thread.relationKinds.join(" · ") : "root",
    `${thread.nodes.length} node(s)`,
    `${thread.snapshotShas.length} snapshot(s)`,
  ];
  if (selected) badges.unshift("selected");
  return `${thread.docType} · ${badges.join(" · ")} · ${thread.docPaths.join(", ")}`;
};

export const buildThreadOptionName = (thread: ExplorerThreadView, _selected: boolean): string => thread.title;

export const buildPlaceholderThreadOption = (): { name: string; description: string; value: string } => ({
  name: "No matching thread",
  description: "Clear the search query or change the filter scope.",
  value: "__empty__",
});

export const buildIntentOptionName = (item: ExplorerIntentView, linked: boolean): string =>
  `${linked ? "◆ " : ""}${item.title}`;

export const buildIntentOptionDescription = (item: ExplorerIntentView, linked: boolean): string =>
  `${item.kind} · ${item.status}${linked ? " · linked" : ""} · ${item.summary}`;

export const buildEventOptionName = (item: ExplorerEventView, linked: boolean): string =>
  `${linked ? "◆ " : ""}${item.eventType} · ${item.recordedAt}`;

export const buildEventOptionDescription = (item: ExplorerEventView, linked: boolean): string =>
  `${linked ? "linked · " : ""}${item.summary}`;
