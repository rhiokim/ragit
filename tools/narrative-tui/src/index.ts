import {
  BoxRenderable,
  createCliRenderer,
  InputRenderable,
  InputRenderableEvents,
  type KeyEvent,
  SelectRenderable,
  SelectRenderableEvents,
  TabSelectRenderable,
  TabSelectRenderableEvents,
  TextRenderable,
} from "@opentui/core";
import {
  buildEventOptionDescription,
  buildEventOptionName,
  buildExplorerView,
  buildIntentOptionDescription,
  buildIntentOptionName,
  buildPlaceholderThreadOption,
  buildThreadOptionDescription,
  buildThreadOptionName,
  isEventLinkedToThread,
  isIntentLinkedToThread,
  loadNarrativeModel,
  type ExplorerDetail,
  type ExplorerEventView,
  type ExplorerIntentView,
  type ExplorerState,
  type ExplorerThreadView,
  type FilterScope,
  type NarrativeModel,
} from "./model";

interface ParsedArgs {
  modelPath: string | null;
  help: boolean;
}

interface NamedOption {
  name: string;
  description: string;
  value: string;
}

const parseArgs = (argv: string[]): ParsedArgs => {
  let modelPath: string | null = null;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--model") {
      modelPath = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (value.startsWith("--model=")) {
      modelPath = value.slice("--model=".length) || null;
      continue;
    }
    if (value === "--help" || value === "-h") {
      help = true;
      continue;
    }
    throw new Error(`Unsupported argument: ${value}`);
  }

  return { modelPath, help };
};

const formatScopeLabel = (scope: FilterScope): string => {
  switch (scope) {
    case "threads":
      return "threads";
    case "decisions":
      return "decisions";
    case "intent":
      return "intent";
    case "events":
      return "events";
    default:
      return "all";
  }
};

const createPanel = (
  renderer: Awaited<ReturnType<typeof createCliRenderer>>,
  id: string,
  title: string,
  options: Partial<ConstructorParameters<typeof BoxRenderable>[1]> = {},
): BoxRenderable =>
  new BoxRenderable(renderer, {
    id,
    title,
    border: true,
    shouldFill: true,
    width: "100%",
    ...options,
  });

const formatSummary = (
  model: NarrativeModel,
  state: ExplorerState,
  selectedThread: ExplorerThreadView | null,
): string => {
  const warningLines =
    model.warnings.length > 0
      ? model.warnings.map((warning) => `- ${warning}`).join("\n")
      : "- none";

  return [
    `${model.repoName} · HEAD ${model.headSha}`,
    `schema=${model.schemaVersion} · projection=${model.projectionMode} · policy=${model.projectionPolicyVersion}`,
    `window: ${model.window.selectedSnapshotShas.length} snapshot(s), ${model.window.missingSnapshotCommits} missing manifest commit(s)`,
    `threads=${model.summary.decisionThreads} · nodes=${model.summary.decisionNodes} · intent=${model.summary.intentItems} · events=${model.summary.timelineEvents}`,
    `filter: ${formatScopeLabel(state.scope)} · query=${state.query.trim().length > 0 ? state.query : "(none)"}`,
    `selected: ${selectedThread ? `${selectedThread.title} [${selectedThread.docType}]` : "(none)"}`,
    "",
    "Tab focus · arrows move · Enter select · Esc clears search · q quits",
    "",
    "warnings:",
    warningLines,
  ].join("\n");
};

const formatDecisionEvolution = (thread: ExplorerThreadView | null): string => {
  if (!thread) {
    return [
      "No decision thread is visible in the current filter.",
      "",
      "Clear the query or switch the scope back to `all`, `threads`, or `decisions`.",
    ].join("\n");
  }

  const lines: string[] = [
    `${thread.title}`,
    `${thread.docType} thread · ${thread.nodes.length} node(s) · ${thread.snapshotShas.length} snapshot(s)`,
    `paths: ${thread.docPaths.join(", ")}`,
    `trust: ${thread.badges.trust} · sensitivity: ${thread.badges.sensitivity}`,
    `bindings: goals=${thread.binding.goalCount}, episodes=${thread.binding.episodeCount}, sessions=${thread.binding.sessionCount}, relatedPaths=${thread.binding.relatedPathCount}`,
    "",
  ];

  const orderedNodes = [...thread.nodes].sort((left, right) => {
    const byTime = left.authoredAt.localeCompare(right.authoredAt);
    if (byTime !== 0) return byTime;
    return left.path.localeCompare(right.path);
  });

  orderedNodes.forEach((node, index) => {
    const badge = node.relationKind === "root" ? "root" : node.relationKind;
    lines.push(
      `${index + 1}. ${node.commitSha.slice(0, 7)} · ${node.changeType} · [${badge}]`,
      `   ${node.title}`,
      `   ${node.path}`,
      `   ${node.summary}`,
      `   artifact=${node.sourceArtifactId ?? "none"} · confidence=${node.confidence.toFixed(2)}`,
      `   trust=${node.badges.trust} · sensitivity=${node.badges.sensitivity}`,
      `   bindings=goals=${node.binding.goalCount}, episodes=${node.binding.episodeCount}, sessions=${node.binding.sessionCount}, relatedPaths=${node.binding.relatedPathCount}`,
    );
    if (node.predecessorNodeId) {
      lines.push(`   predecessor=${node.predecessorNodeId}`);
    }
    if (node.relatedPaths && node.relatedPaths.length > 0) {
      lines.push(`   related=${node.relatedPaths.join(", ")}`);
    }
    lines.push("");
  });

  return lines.join("\n").trimEnd();
};

const formatDetail = (detail: ExplorerDetail): string => {
  const lines = [
    detail.title,
    "",
    detail.summary,
    "",
    `path: ${detail.path}`,
    `artifact: ${detail.artifactId}`,
    `snapshot: ${detail.snapshotSha}`,
    `relation: ${detail.relationKind}`,
    `confidence: ${detail.confidence}`,
  ];

  if (detail.extra.length > 0) {
    lines.push("", "extra:");
    lines.push(...detail.extra.map((value) => `- ${value}`));
  }

  return lines.join("\n");
};

const buildIntentOptions = (
  selectedThread: ExplorerThreadView | null,
  assigned: ExplorerIntentView[],
  unassigned: ExplorerIntentView[],
): NamedOption[] => {
  const assignedOptions = assigned.map((item) => {
    const linked = selectedThread ? isIntentLinkedToThread(selectedThread, item) : false;
    return {
      name: buildIntentOptionName(item, linked),
      description: `${buildIntentOptionDescription(item, linked)} · assigned`,
      value: item.itemId,
    };
  });

  const unassignedOptions = unassigned.map((item) => {
    const linked = selectedThread ? isIntentLinkedToThread(selectedThread, item) : false;
    return {
      name: `○ ${buildIntentOptionName(item, linked)}`,
      description: `${buildIntentOptionDescription(item, linked)} · unassigned`,
      value: item.itemId,
    };
  });

  return [...assignedOptions, ...unassignedOptions];
};

const buildEventOptions = (
  selectedThread: ExplorerThreadView | null,
  events: ExplorerEventView[],
): NamedOption[] =>
  events.map((event) => {
    const linked = selectedThread ? isEventLinkedToThread(selectedThread, event) : false;
    return {
      name: buildEventOptionName(event, linked),
      description: buildEventOptionDescription(event, linked),
      value: event.eventId,
    };
  });

const optionIndexForValue = (options: NamedOption[], value: string | null): number => {
  if (!value) return 0;
  const index = options.findIndex((option) => option.value === value);
  return index >= 0 ? index : 0;
};

const scopeOptions: NamedOption[] = [
  { name: "All", description: "Search every narrative panel", value: "all" },
  { name: "Threads", description: "Apply the query to decision threads", value: "threads" },
  { name: "Decisions", description: "Apply the query to decision evolution nodes", value: "decisions" },
  { name: "Intent", description: "Apply the query to reviewed/promoted intent items", value: "intent" },
  { name: "Events", description: "Apply the query to operational timeline events", value: "events" },
];

const buildPlaceholderOption = (name: string, description: string): NamedOption => ({
  name,
  description,
  value: "__empty__",
});

const renderModel = async (modelPath: string): Promise<void> => {
  const model = await loadNarrativeModel(modelPath);
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    autoFocus: true,
    screenMode: "alternate-screen",
  });

  renderer.root.flexDirection = "column";
  renderer.root.padding = 1;
  renderer.root.gap = 1;

  const state: ExplorerState = {
    query: "",
    scope: "all",
    selectedThreadId: null,
    selectedIntentId: null,
    selectedEventId: null,
  };

  const summaryPanel = createPanel(renderer, "summary-panel", "Narrative Explorer", {
    height: 9,
    padding: 1,
  });
  const summaryText = new TextRenderable(renderer, {
    id: "summary-text",
    width: "100%",
    content: "",
  });
  summaryPanel.add(summaryText);

  const controlsRow = createPanel(renderer, "controls-row", "Controls", {
    flexDirection: "row",
    height: 6,
    gap: 1,
  });

  const searchPanel = createPanel(renderer, "search-panel", "Search", {
    width: "42%",
    padding: 1,
  });
  const searchInput = new InputRenderable(renderer, {
    id: "search-input",
    width: "100%",
    placeholder: "Filter threads, intent, and events",
    value: "",
  });
  searchPanel.add(searchInput);

  const scopePanel = createPanel(renderer, "scope-panel", "Filter Scope", {
    width: "58%",
    padding: 1,
  });
  const scopeTabs = new TabSelectRenderable(renderer, {
    id: "scope-tabs",
    width: "100%",
    options: scopeOptions,
    showDescription: true,
    wrapSelection: true,
  });
  scopePanel.add(scopeTabs);
  controlsRow.add(searchPanel);
  controlsRow.add(scopePanel);

  const mainRow = createPanel(renderer, "main-row", "Explorer", {
    flexDirection: "row",
    flexGrow: 1,
    gap: 1,
  });

  const threadPanel = createPanel(renderer, "thread-panel", "Decision Threads", {
    width: "28%",
  });
  const threadSelect = new SelectRenderable(renderer, {
    id: "thread-select",
    width: "100%",
    height: "100%",
    showDescription: true,
    wrapSelection: true,
    options: [buildPlaceholderThreadOption()],
  });
  threadPanel.add(threadSelect);

  const decisionPanel = createPanel(renderer, "decision-panel", "Decision Evolution", {
    width: "34%",
    padding: 1,
  });
  const decisionText = new TextRenderable(renderer, {
    id: "decision-text",
    width: "100%",
    content: "",
  });
  decisionPanel.add(decisionText);

  const rightColumn = createPanel(renderer, "right-column", "Context", {
    width: "38%",
    flexDirection: "column",
    gap: 1,
  });

  const intentPanel = createPanel(renderer, "intent-panel", "Intent Panel", {
    height: "40%",
  });
  const intentSelect = new SelectRenderable(renderer, {
    id: "intent-select",
    width: "100%",
    height: "100%",
    showDescription: true,
    wrapSelection: true,
    options: [buildPlaceholderOption("No intent item", "The current model has no visible reviewed/promoted intent item.")],
  });
  intentPanel.add(intentSelect);

  const eventPanel = createPanel(renderer, "event-panel", "Operational Timeline", {
    height: "28%",
  });
  const eventSelect = new SelectRenderable(renderer, {
    id: "event-select",
    width: "100%",
    height: "100%",
    showDescription: true,
    wrapSelection: true,
    options: [buildPlaceholderOption("No event", "The current model has no visible event in the selected filter.")],
  });
  eventPanel.add(eventSelect);

  const detailPanel = createPanel(renderer, "detail-panel", "Detail", {
    flexGrow: 1,
    padding: 1,
  });
  const detailText = new TextRenderable(renderer, {
    id: "detail-text",
    width: "100%",
    content: "",
  });
  detailPanel.add(detailText);

  rightColumn.add(intentPanel);
  rightColumn.add(eventPanel);
  rightColumn.add(detailPanel);

  mainRow.add(threadPanel);
  mainRow.add(decisionPanel);
  mainRow.add(rightColumn);

  renderer.root.add(summaryPanel);
  renderer.root.add(controlsRow);
  renderer.root.add(mainRow);

  const focusables = [searchInput, scopeTabs, threadSelect, intentSelect, eventSelect];
  const cycleFocus = (currentIndex: number, direction: -1 | 1): void => {
    const nextIndex = (currentIndex + direction + focusables.length) % focusables.length;
    focusables[nextIndex]?.focus();
  };

  const bindSharedKeys = (currentIndex: number, clearSearch = false): ((key: KeyEvent) => void) => {
    return (key: KeyEvent) => {
      if (key.name === "tab") {
        key.preventDefault();
        key.stopPropagation();
        cycleFocus(currentIndex, key.shift ? -1 : 1);
        return;
      }
      if (!key.ctrl && !key.meta && key.name === "q") {
        key.preventDefault();
        key.stopPropagation();
        renderer.destroy();
        return;
      }
      if (clearSearch && key.name === "escape") {
        key.preventDefault();
        key.stopPropagation();
        searchInput.value = "";
        state.query = "";
        refresh();
      }
    };
  };

  searchInput.onKeyDown = bindSharedKeys(0, true);
  scopeTabs.onKeyDown = bindSharedKeys(1);
  threadSelect.onKeyDown = bindSharedKeys(2);
  intentSelect.onKeyDown = bindSharedKeys(3);
  eventSelect.onKeyDown = bindSharedKeys(4);

  let isRefreshing = false;

  const refresh = (): void => {
    if (isRefreshing) return;
    isRefreshing = true;

    let view = buildExplorerView(model, state);
    const validIntentIds = new Set(
      [...view.assignedIntentItems, ...view.unassignedIntentItems].map((item) => item.itemId),
    );
    const validEventIds = new Set(view.timelineEvents.map((event) => event.eventId));

    state.selectedThreadId = view.selectedThread?.threadId ?? null;
    if (state.selectedIntentId && !validIntentIds.has(state.selectedIntentId)) {
      state.selectedIntentId = null;
    }
    if (state.selectedEventId && !validEventIds.has(state.selectedEventId)) {
      state.selectedEventId = null;
    }
    view = buildExplorerView(model, state);

    const threadOptions =
      view.visibleThreads.length > 0
        ? view.visibleThreads.map((thread) => ({
            name: buildThreadOptionName(thread, thread.threadId === view.selectedThread?.threadId),
            description: buildThreadOptionDescription(thread, thread.threadId === view.selectedThread?.threadId),
            value: thread.threadId,
          }))
        : [buildPlaceholderThreadOption()];

    const intentOptions = buildIntentOptions(
      view.selectedThread,
      view.assignedIntentItems,
      view.unassignedIntentItems,
    );
    const safeIntentOptions =
      intentOptions.length > 0
        ? intentOptions
        : [buildPlaceholderOption("No intent item", "No reviewed/promoted intent item matches the current filter.")];

    const eventOptions = buildEventOptions(view.selectedThread, view.timelineEvents);
    const safeEventOptions =
      eventOptions.length > 0
        ? eventOptions
        : [buildPlaceholderOption("No event", "No operational timeline event matches the current filter.")];

    summaryText.content = formatSummary(model, state, view.selectedThread);
    decisionText.content = formatDecisionEvolution(view.selectedThread);
    detailText.content = formatDetail(view.detail);

    summaryPanel.title = model.empty ? "Narrative Explorer · empty state" : "Narrative Explorer";
    threadPanel.title = `Decision Threads (${view.visibleThreads.length}/${view.threads.length})`;
    decisionPanel.title = view.selectedThread
      ? `Decision Evolution · ${view.selectedThread.title}`
      : "Decision Evolution";
    intentPanel.title = `Intent Panel (${view.assignedIntentItems.length + view.unassignedIntentItems.length})`;
    eventPanel.title = `Operational Timeline (${view.timelineEvents.length})`;
    detailPanel.title = `Detail · ${view.detail.kind}`;

    threadSelect.options = threadOptions;
    threadSelect.setSelectedIndex(optionIndexForValue(threadOptions, state.selectedThreadId));

    intentSelect.options = safeIntentOptions;
    intentSelect.setSelectedIndex(optionIndexForValue(safeIntentOptions, state.selectedIntentId));

    eventSelect.options = safeEventOptions;
    eventSelect.setSelectedIndex(optionIndexForValue(safeEventOptions, state.selectedEventId));

    const scopeIndex = optionIndexForValue(scopeOptions, state.scope);
    scopeTabs.setSelectedIndex(scopeIndex);

    isRefreshing = false;
  };

  searchInput.on(InputRenderableEvents.INPUT, () => {
    if (isRefreshing) return;
    state.query = searchInput.value;
    refresh();
  });

  scopeTabs.on(TabSelectRenderableEvents.SELECTION_CHANGED, () => {
    if (isRefreshing) return;
    const selected = scopeTabs.getSelectedOption();
    state.scope = (selected?.value as FilterScope | undefined) ?? "all";
    refresh();
  });

  threadSelect.on(SelectRenderableEvents.SELECTION_CHANGED, () => {
    if (isRefreshing) return;
    const selected = threadSelect.getSelectedOption();
    state.selectedThreadId = typeof selected?.value === "string" && selected.value !== "__empty__" ? selected.value : null;
    state.selectedIntentId = null;
    state.selectedEventId = null;
    refresh();
  });

  intentSelect.on(SelectRenderableEvents.SELECTION_CHANGED, () => {
    if (isRefreshing) return;
    const selected = intentSelect.getSelectedOption();
    state.selectedIntentId =
      typeof selected?.value === "string" && selected.value !== "__empty__" ? selected.value : null;
    state.selectedEventId = null;
    refresh();
  });

  eventSelect.on(SelectRenderableEvents.SELECTION_CHANGED, () => {
    if (isRefreshing) return;
    const selected = eventSelect.getSelectedOption();
    state.selectedEventId =
      typeof selected?.value === "string" && selected.value !== "__empty__" ? selected.value : null;
    state.selectedIntentId = null;
    refresh();
  });

  refresh();
  renderer.start();
  searchInput.focus();

  if (process.env.NARRATIVE_TUI_SMOKE === "1") {
    await new Promise((resolve) => setTimeout(resolve, 500));
    renderer.destroy();
  }
};

const printHelp = (): void => {
  console.log("Usage: bun run src/index.ts --model <path>");
  console.log("");
  console.log("The viewer consumes only sanitized JSON exported by `ragit narrative --emit-model <path>`.");
};

const main = async (): Promise<void> => {
  const { modelPath, help } = parseArgs(process.argv.slice(2));
  if (help) {
    printHelp();
    return;
  }
  if (!modelPath) {
    printHelp();
    process.exitCode = 1;
    return;
  }
  await renderModel(modelPath);
};

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown narrative viewer error";
  console.error(`narrative-tui: ${message}`);
  process.exitCode = 1;
}
