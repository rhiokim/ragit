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
  buildExplorerView,
  buildFormationOptionDescription,
  buildFormationOptionName,
  buildFreshnessBadgeLabel,
  buildFreshnessDetailLines,
  buildFreshnessSummary,
  buildRecoveryOptionDescription,
  buildRecoveryOptionName,
  buildTrustOptionDescription,
  buildTrustOptionName,
  buildValidationBadgeLabel,
  buildValidationDetailLines,
  buildValidationSummary,
  loadNarrativeModel,
  type ExplorerDetail,
  type ExplorerFormationStepView,
  type ExplorerRecoveryItemView,
  type ExplorerState,
  type ExplorerTrustItemView,
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
    case "recover":
      return "recover";
    case "trust":
      return "trust";
    case "formation":
      return "formation";
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
  selectedRecoveryItem: ExplorerRecoveryItemView | null,
): string => {
  const warningLines =
    model.warnings.length > 0 ? model.warnings.map((warning) => `- ${warning}`).join("\n") : "- none";

  return [
    `${model.repoName} · HEAD ${model.headSha}`,
    `schema=${model.schemaVersion} · projection=${model.projectionMode} · policy=${model.projectionPolicyVersion}`,
    `recovery: source=${model.recovery.recoverNow.source} · goal=${model.recovery.recoverNow.currentGoal ?? "none"}`,
    `recover=${model.recovery.recoverNow.items.length} · trust=${model.recovery.whatToTrust.items.length} · formation=${model.recovery.howWeGotHere.steps.length}`,
    `freshness: fresh=${model.recovery.whatToTrust.freshnessCounts.fresh} · suspect=${model.recovery.whatToTrust.freshnessCounts.suspect} · stale=${model.recovery.whatToTrust.freshnessCounts.stale}`,
    `validation: verified=${model.recovery.whatToTrust.validationCounts.verified} · attention=${model.recovery.whatToTrust.validationCounts.attention} · unverified=${model.recovery.whatToTrust.validationCounts.unverified}`,
    `filter: ${formatScopeLabel(state.scope)} · query=${state.query.trim().length > 0 ? state.query : "(none)"}`,
    `selected: ${selectedRecoveryItem ? selectedRecoveryItem.title : "(none)"}`,
    "",
    "Tab focus · arrows move · Enter select · Esc clears search · q quits",
    "",
    "warnings:",
    warningLines,
  ].join("\n");
};

const formatRecoverNow = (
  model: NarrativeModel,
  selectedRecoveryItem: ExplorerRecoveryItemView | null,
): string => {
  const lines = [
    `Goal: ${model.recovery.recoverNow.currentGoal ?? "none"}`,
    `Summary: ${model.recovery.recoverNow.currentSummary ?? "none"}`,
    `Source: ${model.recovery.recoverNow.source}`,
    `Latest Session: ${model.recovery.recoverNow.latestSessionId ?? "none"}`,
    `Open Loops: ${model.recovery.recoverNow.openLoopCount}`,
    `Next Actions: ${model.recovery.recoverNow.nextActionCount}`,
    `Stable Decisions: ${model.recovery.recoverNow.stableDecisionCount}`,
    "",
  ];

  if (!selectedRecoveryItem) {
    lines.push("No recovery item is visible in the current filter.");
    return lines.join("\n");
  }

  lines.push(
    `Selected: #${selectedRecoveryItem.rank} ${selectedRecoveryItem.title}`,
    `Kind: ${selectedRecoveryItem.kind} · source=${selectedRecoveryItem.source} · status=${selectedRecoveryItem.status ?? "none"}`,
    `Summary: ${selectedRecoveryItem.summary}`,
    `Source Ref: ${selectedRecoveryItem.sourceRef}`,
    `Snapshot: ${selectedRecoveryItem.snapshotSha ?? "none"}`,
    `Related Paths: ${selectedRecoveryItem.relatedPaths.length > 0 ? selectedRecoveryItem.relatedPaths.join(", ") : "none"}`,
    `Linked Thread: ${selectedRecoveryItem.linkedThread?.title ?? "none"}`,
  );

  if (selectedRecoveryItem.linkedThread) {
    lines.push(
      "",
      `Thread Freshness: ${buildFreshnessSummary(
        selectedRecoveryItem.linkedThread.freshnessStatus,
        selectedRecoveryItem.linkedThread.driftReasonCodes,
        selectedRecoveryItem.linkedThread.recommendedActions,
      )}`,
      `Thread Validation: ${buildValidationSummary(
        selectedRecoveryItem.linkedThread.validationStatus,
        selectedRecoveryItem.linkedThread.validationReasonCodes,
        selectedRecoveryItem.linkedThread.validationEvidenceRefs,
        selectedRecoveryItem.linkedThread.validationRecommendedActions,
      )}`,
    );
  }

  return lines.join("\n");
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

  lines.push(
    "",
    ...buildFreshnessDetailLines(detail.freshnessStatus, detail.driftReasonCodes, detail.recommendedActions, detail.driftSourceRefs),
  );
  lines.push(
    "",
    ...buildValidationDetailLines(
      detail.validationStatus,
      detail.validationReasonCodes,
      detail.validationEvidenceRefs,
      detail.validationRecommendedActions,
    ),
  );

  if (detail.extra.length > 0) {
    lines.push("", "extra:");
    lines.push(...detail.extra.map((value) => `- ${value}`));
  }

  return lines.join("\n");
};

const formatTrustPanel = (selectedTrustItem: ExplorerTrustItemView | null): string => {
  if (!selectedTrustItem) {
    return [
      "No trust item selected.",
      "",
      "Select a trust item to inspect its freshness, validation, and source posture.",
    ].join("\n");
  }

  return [
    `${buildFreshnessBadgeLabel(selectedTrustItem.freshnessStatus)} ${buildValidationBadgeLabel(selectedTrustItem.validationStatus)} ${selectedTrustItem.title}`,
    "",
    buildFreshnessSummary(
      selectedTrustItem.freshnessStatus,
      selectedTrustItem.reasonCodes,
      selectedTrustItem.recommendedActions,
    ),
    buildValidationSummary(
      selectedTrustItem.validationStatus,
      selectedTrustItem.reasonCodes,
      selectedTrustItem.evidenceRefs,
      selectedTrustItem.recommendedActions,
    ),
    "",
    `trust=${selectedTrustItem.trustBadge ?? "none"} · sensitivity=${selectedTrustItem.sensitivity ?? "standard"}`,
    `lineage=${selectedTrustItem.lineageKinds.length > 0 ? selectedTrustItem.lineageKinds.join(", ") : "none"}`,
    `source ref=${selectedTrustItem.sourceRef}`,
    `linked thread=${selectedTrustItem.linkedThread?.title ?? "none"}`,
  ].join("\n");
};

const formatFormationPanel = (selectedFormationStep: ExplorerFormationStepView | null): string => {
  if (!selectedFormationStep) {
    return [
      "No formation step selected.",
      "",
      "Select a formation step to inspect how the current recovery state was shaped.",
    ].join("\n");
  }

  return [
    `#${selectedFormationStep.rank} ${selectedFormationStep.kind} · ${selectedFormationStep.title}`,
    "",
    selectedFormationStep.summary,
    "",
    `when=${selectedFormationStep.when ?? "none"}`,
    `ref=${selectedFormationStep.refId}`,
    `paths=${selectedFormationStep.relatedPaths.length > 0 ? selectedFormationStep.relatedPaths.join(", ") : "none"}`,
    `linked thread=${selectedFormationStep.linkedThread?.title ?? "none"}`,
  ].join("\n");
};

const optionIndexForValue = (options: NamedOption[], value: string | null): number => {
  if (!value) return 0;
  const index = options.findIndex((option) => option.value === value);
  return index >= 0 ? index : 0;
};

const buildPlaceholderOption = (name: string, description: string): NamedOption => ({
  name,
  description,
  value: "__empty__",
});

const scopeOptions: NamedOption[] = [
  { name: "All", description: "Search every recovery panel", value: "all" },
  { name: "Recover", description: "Apply the query to Recover Now items", value: "recover" },
  { name: "Trust", description: "Apply the query to What To Trust items", value: "trust" },
  { name: "Formation", description: "Apply the query to How We Got Here steps", value: "formation" },
];

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
    selectedRecoveryItemId: null,
    selectedTrustItemId: null,
    selectedFormationStepId: null,
  };

  const summaryPanel = createPanel(renderer, "summary-panel", "Recovery Explorer", {
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
    placeholder: "Filter recovery, trust, and formation",
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

  const mainRow = createPanel(renderer, "main-row", "Recovery View", {
    flexDirection: "row",
    flexGrow: 1,
    gap: 1,
  });

  const recoverPanel = createPanel(renderer, "recover-panel", "Recover Now", {
    width: "30%",
  });
  const recoverSelect = new SelectRenderable(renderer, {
    id: "recover-select",
    width: "100%",
    height: "100%",
    showDescription: true,
    wrapSelection: true,
    options: [buildPlaceholderOption("No recovery item", "No recovery packet item matches the current filter.")],
  });
  recoverPanel.add(recoverSelect);

  const centerColumn = createPanel(renderer, "center-column", "Recover Now · Current Packet", {
    width: "34%",
    flexDirection: "column",
    gap: 1,
  });
  const recoverTextPanel = createPanel(renderer, "recover-text-panel", "Recover Now", {
    height: "50%",
    padding: 1,
  });
  const recoverText = new TextRenderable(renderer, {
    id: "recover-text",
    width: "100%",
    content: "",
  });
  recoverTextPanel.add(recoverText);

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
  centerColumn.add(recoverTextPanel);
  centerColumn.add(detailPanel);

  const rightColumn = createPanel(renderer, "right-column", "What To Trust · How We Got Here", {
    width: "36%",
    flexDirection: "column",
    gap: 1,
  });

  const trustPanel = createPanel(renderer, "trust-panel", "What To Trust", {
    height: "38%",
  });
  const trustSelect = new SelectRenderable(renderer, {
    id: "trust-select",
    width: "100%",
    height: "100%",
    showDescription: true,
    wrapSelection: true,
    options: [buildPlaceholderOption("No trust item", "No trust item matches the current filter.")],
  });
  trustPanel.add(trustSelect);

  const trustSummaryPanel = createPanel(renderer, "trust-summary-panel", "Trust Summary", {
    height: "20%",
    padding: 1,
  });
  const trustSummaryText = new TextRenderable(renderer, {
    id: "trust-summary-text",
    width: "100%",
    content: "",
  });
  trustSummaryPanel.add(trustSummaryText);

  const formationPanel = createPanel(renderer, "formation-panel", "How We Got Here", {
    flexGrow: 1,
  });
  const formationSelect = new SelectRenderable(renderer, {
    id: "formation-select",
    width: "100%",
    height: "100%",
    showDescription: true,
    wrapSelection: true,
    options: [buildPlaceholderOption("No formation step", "No formation step matches the current filter.")],
  });
  formationPanel.add(formationSelect);

  rightColumn.add(trustPanel);
  rightColumn.add(trustSummaryPanel);
  rightColumn.add(formationPanel);

  mainRow.add(recoverPanel);
  mainRow.add(centerColumn);
  mainRow.add(rightColumn);

  renderer.root.add(summaryPanel);
  renderer.root.add(controlsRow);
  renderer.root.add(mainRow);

  const focusables = [searchInput, scopeTabs, recoverSelect, trustSelect, formationSelect];
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
  recoverSelect.onKeyDown = bindSharedKeys(2);
  trustSelect.onKeyDown = bindSharedKeys(3);
  formationSelect.onKeyDown = bindSharedKeys(4);

  let isRefreshing = false;

  const refresh = (): void => {
    if (isRefreshing) return;
    isRefreshing = true;

    let view = buildExplorerView(model, state);
    const validRecoveryIds = new Set(view.visibleRecoveryItems.map((item) => item.itemId));
    const validTrustIds = new Set(view.visibleTrustItems.map((item) => item.itemId));
    const validFormationIds = new Set(view.visibleFormationSteps.map((item) => item.itemId));

    if (state.selectedRecoveryItemId && !validRecoveryIds.has(state.selectedRecoveryItemId)) {
      state.selectedRecoveryItemId = null;
    }
    if (state.selectedTrustItemId && !validTrustIds.has(state.selectedTrustItemId)) {
      state.selectedTrustItemId = null;
    }
    if (state.selectedFormationStepId && !validFormationIds.has(state.selectedFormationStepId)) {
      state.selectedFormationStepId = null;
    }
    view = buildExplorerView(model, state);

    const recoveryOptions =
      view.visibleRecoveryItems.length > 0
        ? view.visibleRecoveryItems.map((item) => ({
            name: buildRecoveryOptionName(item, item.itemId === view.selectedRecoveryItem?.itemId),
            description: buildRecoveryOptionDescription(item),
            value: item.itemId,
          }))
        : [buildPlaceholderOption("No recovery item", "No recovery packet item matches the current filter.")];

    const trustOptions =
      view.visibleTrustItems.length > 0
        ? view.visibleTrustItems.map((item) => ({
            name: buildTrustOptionName(item, item.itemId === view.selectedTrustItem?.itemId),
            description: buildTrustOptionDescription(item),
            value: item.itemId,
          }))
        : [buildPlaceholderOption("No trust item", "No trust item matches the current filter.")];

    const formationOptions =
      view.visibleFormationSteps.length > 0
        ? view.visibleFormationSteps.map((item) => ({
            name: buildFormationOptionName(item, item.itemId === view.selectedFormationStep?.itemId),
            description: buildFormationOptionDescription(item),
            value: item.itemId,
          }))
        : [buildPlaceholderOption("No formation step", "No formation step matches the current filter.")];

    summaryText.content = formatSummary(model, state, view.selectedRecoveryItem);
    recoverText.content = formatRecoverNow(model, view.selectedRecoveryItem);
    trustSummaryText.content = formatTrustPanel(view.selectedTrustItem);
    detailText.content = formatDetail(view.detail);

    summaryPanel.title = model.empty || model.recovery.empty ? "Recovery Explorer · empty state" : "Recovery Explorer";
    recoverPanel.title = `Recover Now (${view.visibleRecoveryItems.length}/${view.recoveryItems.length})`;
    trustPanel.title = `What To Trust (${view.visibleTrustItems.length}/${view.trustItems.length})`;
    formationPanel.title = `How We Got Here (${view.visibleFormationSteps.length}/${view.formationSteps.length})`;
    detailPanel.title = `Detail · ${view.detail.kind}`;

    recoverSelect.options = recoveryOptions;
    recoverSelect.setSelectedIndex(optionIndexForValue(recoveryOptions, state.selectedRecoveryItemId));

    trustSelect.options = trustOptions;
    trustSelect.setSelectedIndex(optionIndexForValue(trustOptions, state.selectedTrustItemId));

    formationSelect.options = formationOptions;
    formationSelect.setSelectedIndex(optionIndexForValue(formationOptions, state.selectedFormationStepId));

    scopeTabs.setSelectedIndex(optionIndexForValue(scopeOptions, state.scope));

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

  recoverSelect.on(SelectRenderableEvents.SELECTION_CHANGED, () => {
    if (isRefreshing) return;
    const selected = recoverSelect.getSelectedOption();
    state.selectedRecoveryItemId =
      typeof selected?.value === "string" && selected.value !== "__empty__" ? selected.value : null;
    state.selectedTrustItemId = null;
    state.selectedFormationStepId = null;
    refresh();
  });

  trustSelect.on(SelectRenderableEvents.SELECTION_CHANGED, () => {
    if (isRefreshing) return;
    const selected = trustSelect.getSelectedOption();
    state.selectedTrustItemId =
      typeof selected?.value === "string" && selected.value !== "__empty__" ? selected.value : null;
    state.selectedFormationStepId = null;
    refresh();
  });

  formationSelect.on(SelectRenderableEvents.SELECTION_CHANGED, () => {
    if (isRefreshing) return;
    const selected = formationSelect.getSelectedOption();
    state.selectedFormationStepId =
      typeof selected?.value === "string" && selected.value !== "__empty__" ? selected.value : null;
    state.selectedTrustItemId = null;
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
