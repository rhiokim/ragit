import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { listArtifactRecords } from "./artifacts.js";
import { runDrift } from "./drift.js";
import { resolveRagitPaths } from "./project.js";
import {
  buildNarrativeViewModel,
  NARRATIVE_MODEL_SCHEMA_VERSION,
  NARRATIVE_PROJECTION_MODE,
  NARRATIVE_PROJECTION_POLICY_VERSION,
  NarrativeFreshnessStatus,
  NarrativeEventItem,
  NarrativeIntentItem,
  NarrativeOptions,
  NarrativeResult,
  NarrativeViewModel,
  NarrativeValidationStatus,
} from "./narrative-model.js";
import type { ArtifactRecord, DriftItem, DriftResult, DriftStatus } from "./types.js";

export type {
  NarrativeBuildResult,
  NarrativeChangeType,
  NarrativeEventItem,
  NarrativeIntentItem,
  NarrativeOptions,
  NarrativeRelationKind,
  NarrativeResult,
  NarrativeSummary,
  NarrativeViewModel,
  NarrativeWindowSummary,
} from "./narrative-model.js";
export { buildNarrativeViewModel } from "./narrative-model.js";

const shortSha = (value: string): string => value.slice(0, 7);

const resolveNarrativeModelOutput = (
  cwd: string,
  output: string,
): { absolutePath: string; displayPath: string } => {
  if (path.isAbsolute(output)) {
    return { absolutePath: output, displayPath: output };
  }
  return {
    absolutePath: path.resolve(cwd, output),
    displayPath: output.replaceAll("\\", "/"),
  };
};

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const serializeForScript = (value: unknown): string =>
  JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");

const renderBadge = (label: string, tone: string): string =>
  `<span class="badge badge-${escapeHtml(tone)}">${escapeHtml(label)}</span>`;

const renderBadgeRow = (badges: string[]): string =>
  badges.length > 0 ? `<div class="badge-row">${badges.join("")}</div>` : "";

const renderFreshnessBadge = (status: NarrativeFreshnessStatus | null): string =>
  status ? renderBadge(status, `freshness-${status}`) : "";

const renderDriftSummary = (status: NarrativeFreshnessStatus | null, reasons: string[], actions: string[]): string => {
  const parts: string[] = [];
  if (status && status !== "fresh") parts.push(status);
  if (reasons.length > 0) parts.push(`reason: ${reasons[0]}`);
  if (actions.length > 0) parts.push(`action: ${actions[0]}`);
  return parts.length > 0 ? `<span class="drift-summary">${escapeHtml(parts.join(" · "))}</span>` : "";
};

const renderValidationBadge = (status: NarrativeValidationStatus | null): string =>
  status ? renderBadge(status, `validation-${status}`) : "";

const renderValidationSummary = (
  status: NarrativeValidationStatus | null,
  reasons: string[],
  evidenceRefs: string[],
  actions: string[],
): string => {
  const parts: string[] = [];
  if (status) parts.push(`validation: ${status}`);
  if (reasons.length > 0) parts.push(`reason: ${reasons[0]}`);
  if (evidenceRefs.length > 0) parts.push(`evidence: ${evidenceRefs[0]}`);
  if (actions.length > 0) parts.push(`action: ${actions[0]}`);
  return parts.length > 0 ? `<span class="validation-summary">${escapeHtml(parts.join(" · "))}</span>` : "";
};

const normalizeRepoPath = (value: string): string => value.replaceAll("\\", "/");

const uniqueStrings = (values: Array<string | null | undefined>): string[] =>
  Array.from(new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0)));

const sortedUniqueStrings = (values: Array<string | null | undefined>): string[] =>
  uniqueStrings(values).sort((left, right) => left.localeCompare(right));

const aggregateFreshness = (statuses: Array<DriftStatus | null>): DriftStatus | null => {
  const filtered = statuses.filter((status): status is DriftStatus => status !== null);
  if (filtered.length === 0) return "fresh";
  if (filtered.includes("stale")) return "stale";
  if (filtered.includes("suspect")) return "suspect";
  return "fresh";
};

const sourceRefStringsForItem = (item: DriftItem): string[] =>
  sortedUniqueStrings([
    item.sourceRefs.headSha ? `head:${item.sourceRefs.headSha.slice(0, 7)}` : null,
    item.sourceRefs.snapshotSha ? `snapshot:${item.sourceRefs.snapshotSha.slice(0, 7)}` : null,
    item.sourceRefs.anchorSha ? `anchor:${item.sourceRefs.anchorSha.slice(0, 7)}` : null,
    item.sourceRefs.sourceHeadSha ? `source:${item.sourceRefs.sourceHeadSha.slice(0, 7)}` : null,
    item.sourceRefs.boundHeadSha ? `bound:${item.sourceRefs.boundHeadSha.slice(0, 7)}` : null,
    item.sourceRefs.captureHeadSha ? `capture:${item.sourceRefs.captureHeadSha.slice(0, 7)}` : null,
    item.sourceRefs.artifactId ? `artifact:${item.sourceRefs.artifactId}` : null,
    item.sourceRefs.goalId ? `goal:${item.sourceRefs.goalId}` : null,
    item.sourceRefs.episodeId ? `episode:${item.sourceRefs.episodeId}` : null,
    item.sourceRefs.sourceSessionId ? `session:${item.sourceRefs.sourceSessionId}` : null,
    `drift:${item.scope}:${item.itemType}:${item.id}`,
  ]);

const baselineSourceRefStrings = (drift: DriftResult): string[] =>
  sortedUniqueStrings([
    drift.baseline.headSha ? `head:${drift.baseline.headSha.slice(0, 7)}` : null,
    drift.baseline.snapshotSha ? `snapshot:${drift.baseline.snapshotSha.slice(0, 7)}` : null,
    drift.baseline.snapshotCommitSha ? `anchor:${drift.baseline.snapshotCommitSha.slice(0, 7)}` : null,
    ...drift.baseline.reasonCodes.map((reason) => `baseline:${reason}`),
  ]);

const collectDriftAffectedPaths = (item: DriftItem): string[] => sortedUniqueStrings(item.affectedPaths.map(normalizeRepoPath));

const itemMatchesNode = (item: DriftItem, node: NarrativeViewModel["nodes"][number]): boolean => {
  if (item.itemType !== "document" && item.itemType !== "baseline") return false;
  if (item.itemType === "baseline") return true;
  const affectedPaths = new Set(collectDriftAffectedPaths(item));
  return (
    affectedPaths.has(normalizeRepoPath(node.path)) ||
    item.sourceRefs.snapshotSha === node.commitSha ||
    item.sourceRefs.anchorSha === node.commitSha ||
    item.sourceRefs.boundHeadSha === node.commitSha ||
    item.sourceRefs.headSha === node.commitSha
  );
};

const itemMatchesIntent = (item: DriftItem, intent: NarrativeViewModel["intentItems"][number]): boolean => {
  if (item.itemType !== "memoryArtifact" && item.itemType !== "baseline") return false;
  if (item.itemType === "baseline") return true;
  const affectedPaths = new Set(collectDriftAffectedPaths(item));
  const relatedPaths = intent.relatedPaths.map(normalizeRepoPath);
  return (
    (item.sourceRefs.artifactId ? item.sourceRefs.artifactId === intent.artifactId : false) ||
    relatedPaths.some((relatedPath) => affectedPaths.has(relatedPath)) ||
    relatedPaths.some((relatedPath) => item.affectedPaths.map(normalizeRepoPath).includes(relatedPath)) ||
    (item.sourceRefs.snapshotSha ? item.sourceRefs.snapshotSha === intent.anchorSha : false) ||
    (item.sourceRefs.anchorSha ? item.sourceRefs.anchorSha === intent.anchorSha : false)
  );
};

const collectAppliedDriftItems = (
  drift: DriftResult,
  node: NarrativeViewModel["nodes"][number] | NarrativeViewModel["threads"][number] | NarrativeViewModel["intentItems"][number],
  kind: "node" | "thread" | "intent",
  publicNodes: NarrativeViewModel["nodes"],
  publicIntentItems: NarrativeViewModel["intentItems"],
  publicUnassignedIntentItems: NarrativeViewModel["unassignedIntentItems"],
): DriftItem[] => {
  return drift.items.filter((item) => {
    if (item.itemType === "baseline") return false;
    if (kind === "node") return itemMatchesNode(item, node as NarrativeViewModel["nodes"][number]);
    if (kind === "intent") return itemMatchesIntent(item, node as NarrativeViewModel["intentItems"][number]);

    const thread = node as NarrativeViewModel["threads"][number];
    const threadNodes = publicNodes.filter((candidate) => candidate.threadId === thread.threadId);
    const threadIntentItems = [
      ...publicIntentItems,
      ...publicUnassignedIntentItems,
    ].filter((candidate) => candidate.threadIds.includes(thread.threadId));
    return (
      threadNodes.some((candidate) => itemMatchesNode(item, candidate)) ||
      threadIntentItems.some((candidate) => itemMatchesIntent(item, candidate))
    );
  });
};

const applyDriftOverlay = (viewModel: NarrativeViewModel, drift: DriftResult): NarrativeViewModel => {
  const allNodes = viewModel.nodes;
  const allThreads = viewModel.threads;
  const allIntentItems = [...viewModel.intentItems, ...viewModel.unassignedIntentItems];

  const updateOverlay = <T extends { freshnessStatus: NarrativeViewModel["threads"][number]["freshnessStatus"]; driftReasonCodes: string[]; recommendedActions: string[]; driftSourceRefs: string[] }>(
    current: T,
    statuses: DriftStatus[],
    reasonCodes: string[],
    recommendedActions: string[],
    sourceRefs: string[],
  ): T => {
    const freshnessStatus = aggregateFreshness(statuses);
    return {
      ...current,
      freshnessStatus,
      driftReasonCodes: sortedUniqueStrings(reasonCodes),
      recommendedActions: sortedUniqueStrings(recommendedActions),
      driftSourceRefs: sortedUniqueStrings(sourceRefs),
    };
  };

  const baselineReasonCodes = drift.baseline.reasonCodes;
  const baselineSourceRefs = baselineSourceRefStrings(drift);

  const refreshedNodes = allNodes.map((node) => {
    const hits = collectAppliedDriftItems(drift, node, "node", allNodes, viewModel.intentItems, viewModel.unassignedIntentItems);
    const statuses = [
      ...(baselineReasonCodes.length > 0 ? ["suspect" as const] : []),
      ...hits.map((item) => item.status),
    ];
    return updateOverlay(
      node,
      statuses,
      [...baselineReasonCodes, ...hits.flatMap((item) => item.reasonCodes)],
      hits.flatMap((item) => item.recommendedActions),
      [...baselineSourceRefs, ...hits.flatMap((item) => sourceRefStringsForItem(item))],
    );
  });

  const refreshedThreads = allThreads.map((thread) => {
    const threadNodes = refreshedNodes.filter((candidate) => candidate.threadId === thread.threadId);
    const threadIntentItems = allIntentItems.filter((candidate) => candidate.threadIds.includes(thread.threadId));
    const hits = drift.items.filter((item) => {
      if (item.itemType === "baseline") return false;
      return (
        threadNodes.some((candidate) => itemMatchesNode(item, candidate)) ||
        threadIntentItems.some((candidate) => itemMatchesIntent(item, candidate))
      );
    });
    const statuses = [
      ...(baselineReasonCodes.length > 0 ? ["suspect" as const] : []),
      ...hits.map((item) => item.status),
    ];
    return updateOverlay(
      thread,
      statuses,
      [...baselineReasonCodes, ...hits.flatMap((item) => item.reasonCodes)],
      hits.flatMap((item) => item.recommendedActions),
      [...baselineSourceRefs, ...hits.flatMap((item) => sourceRefStringsForItem(item))],
    );
  });

  const refreshedIntentItems = allIntentItems.map((item) => {
    const hits = drift.items.filter((candidate) => {
      if (candidate.itemType === "baseline") return false;
      return itemMatchesIntent(candidate, item);
    });
    const statuses = [
      ...(baselineReasonCodes.length > 0 ? ["suspect" as const] : []),
      ...hits.map((candidate) => candidate.status),
    ];
    return updateOverlay(
      item,
      statuses,
      [...baselineReasonCodes, ...hits.flatMap((candidate) => candidate.reasonCodes)],
      hits.flatMap((candidate) => candidate.recommendedActions),
      [...baselineSourceRefs, ...hits.flatMap((candidate) => sourceRefStringsForItem(candidate))],
    );
  });

  const freshnessCounts = refreshedNodes
    .flatMap((node) => [node.freshnessStatus])
    .concat(refreshedThreads.map((thread) => thread.freshnessStatus))
    .concat(refreshedIntentItems.map((item) => item.freshnessStatus))
    .reduce(
      (acc, status) => {
        if (status === "fresh") acc.fresh += 1;
        if (status === "suspect") acc.suspect += 1;
        if (status === "stale") acc.stale += 1;
        return acc;
      },
      { fresh: 0, suspect: 0, stale: 0 },
    );

  return {
    ...viewModel,
    summary: {
      ...viewModel.summary,
      freshnessCounts,
    },
    threads: refreshedThreads,
    nodes: refreshedNodes,
    intentItems: refreshedIntentItems.filter((item) => viewModel.intentItems.some((candidate) => candidate.itemId === item.itemId)),
    unassignedIntentItems: refreshedIntentItems.filter((item) =>
      viewModel.unassignedIntentItems.some((candidate) => candidate.itemId === item.itemId),
    ),
  };
};

type ValidationContext = {
  relatedPaths: string[];
  goalIds: string[];
  episodeIds: string[];
  snapshotAnchors: string[];
};

type ValidationAttachment = {
  status: NarrativeValidationStatus;
  reasonCodes: string[];
  evidenceRefs: string[];
  recommendedActions: string[];
};

type HarnessArtifactIndex = {
  artifactsById: Map<string, ArtifactRecord>;
  suitesById: Map<string, ArtifactRecord>;
  failuresBySuiteId: Map<string, ArtifactRecord[]>;
};

const uniqueOrderedStrings = (values: Array<string | null | undefined>): string[] =>
  Array.from(new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0)));

const EMPTY_VALIDATION_CONTEXT: ValidationContext = {
  relatedPaths: [],
  goalIds: [],
  episodeIds: [],
  snapshotAnchors: [],
};

const collectValidationContext = (
  artifactIds: string[],
  artifactIndex: HarnessArtifactIndex["artifactsById"],
): ValidationContext => {
  const relatedPaths: string[] = [];
  const goalIds: string[] = [];
  const episodeIds: string[] = [];
  const snapshotAnchors: string[] = [];

  for (const artifactId of artifactIds) {
    const artifact = artifactIndex.get(artifactId);
    if (!artifact) continue;
    if (Array.isArray(artifact.relatedPaths)) relatedPaths.push(...artifact.relatedPaths);
    if (typeof artifact.payload?.goalId === "string") goalIds.push(artifact.payload.goalId);
    if (typeof artifact.payload?.episodeId === "string") episodeIds.push(artifact.payload.episodeId);
    if (typeof artifact.boundHeadSha === "string") snapshotAnchors.push(artifact.boundHeadSha);
    if (typeof artifact.sourceHeadSha === "string") snapshotAnchors.push(artifact.sourceHeadSha);
    if (typeof artifact.captureHeadSha === "string") snapshotAnchors.push(artifact.captureHeadSha);
  }

  return {
    relatedPaths: uniqueOrderedStrings(relatedPaths),
    goalIds: uniqueOrderedStrings(goalIds),
    episodeIds: uniqueOrderedStrings(episodeIds),
    snapshotAnchors: uniqueOrderedStrings(snapshotAnchors),
  };
};

const createHarnessArtifactIndex = async (cwd: string): Promise<HarnessArtifactIndex> => {
  const records = await listArtifactRecords(cwd);
  const artifactsById = new Map(records.map((artifact) => [artifact.artifactId, artifact]));
  const suitesById = new Map<string, ArtifactRecord>();
  const failuresBySuiteId = new Map<string, ArtifactRecord[]>();
  for (const artifact of records) {
    if (artifact.artifactScope !== "harness") continue;
    if (artifact.kind === "suite") {
      suitesById.set(artifact.artifactId, artifact);
      continue;
    }
    if (artifact.kind === "failure") {
      const suiteId = typeof artifact.payload?.suiteId === "string" ? artifact.payload.suiteId : null;
      if (!suiteId) continue;
      const bucket = failuresBySuiteId.get(suiteId) ?? [];
      bucket.push(artifact);
      failuresBySuiteId.set(suiteId, bucket);
    }
  }
  return { artifactsById, suitesById, failuresBySuiteId };
};

const candidateAnchors = (item: DriftItem): string[] =>
  uniqueOrderedStrings([
    item.sourceRefs.anchorSha,
    item.sourceRefs.snapshotSha,
    item.sourceRefs.headSha,
    item.sourceRefs.boundHeadSha,
    item.sourceRefs.captureHeadSha,
  ]);

const contextMatchesRelatedPaths = (context: ValidationContext, item: DriftItem): boolean => {
  const affectedPaths = new Set(collectDriftAffectedPaths(item));
  return context.relatedPaths.some((relatedPath) => affectedPaths.has(normalizeRepoPath(relatedPath)));
};

const contextMatchesGoal = (context: ValidationContext, item: DriftItem): boolean =>
  item.sourceRefs.goalId ? context.goalIds.includes(item.sourceRefs.goalId) : false;

const contextMatchesEpisode = (context: ValidationContext, item: DriftItem): boolean =>
  item.sourceRefs.episodeId ? context.episodeIds.includes(item.sourceRefs.episodeId) : false;

const contextMatchesSnapshotAnchor = (context: ValidationContext, item: DriftItem): boolean =>
  candidateAnchors(item).some((anchor) => context.snapshotAnchors.includes(anchor));

const findValidationCandidate = (
  context: ValidationContext,
  items: DriftItem[],
): DriftItem | null => {
  const rules: Array<(item: DriftItem) => boolean> = [
    (item) => contextMatchesRelatedPaths(context, item),
    (item) => contextMatchesGoal(context, item),
    (item) => contextMatchesEpisode(context, item),
    (item) => contextMatchesSnapshotAnchor(context, item),
  ];

  for (const rule of rules) {
    const matches = items.filter(rule);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return null;
  }
  return null;
};

const buildValidationEvidenceRefs = (
  candidate: DriftItem,
  artifactIndex: HarnessArtifactIndex,
): string[] => {
  const refs = new Set<string>();
  if (candidate.sourceRefs.artifactId) {
    refs.add(`suite:${candidate.sourceRefs.artifactId}`);
    const suite = artifactIndex.suitesById.get(candidate.sourceRefs.artifactId);
    if (suite && Array.isArray(suite.payload?.resourceRefs)) {
      for (const resourceRef of suite.payload.resourceRefs as string[]) {
        refs.add(`resource:${resourceRef}`);
      }
      for (const failure of artifactIndex.failuresBySuiteId.get(candidate.sourceRefs.artifactId) ?? []) {
        refs.add(`failure:${failure.artifactId}`);
        for (const evidence of failure.evidenceRefs ?? []) {
          refs.add(`evidence:${evidence.evidenceId}`);
        }
      }
    }
  }
  refs.add(`drift:${candidate.scope}/${candidate.itemType}:${candidate.id}`);
  return Array.from(refs).sort((left, right) => left.localeCompare(right));
};

const buildValidationAttachment = (
  candidate: DriftItem | null,
  artifactIndex: HarnessArtifactIndex,
): ValidationAttachment => {
  if (!candidate) {
    return {
      status: "unverified",
      reasonCodes: [],
      evidenceRefs: [],
      recommendedActions: [],
    };
  }
  return {
    status: candidate.status === "fresh" ? "verified" : "attention",
    reasonCodes: uniqueOrderedStrings(candidate.reasonCodes),
    evidenceRefs: buildValidationEvidenceRefs(candidate, artifactIndex),
    recommendedActions: uniqueOrderedStrings(candidate.recommendedActions),
  };
};

const combineValidationStatuses = (statuses: Array<NarrativeValidationStatus | null | undefined>): NarrativeValidationStatus => {
  const filtered = statuses.filter((status): status is NarrativeValidationStatus => status !== null && status !== undefined);
  if (filtered.includes("attention")) return "attention";
  if (filtered.includes("verified")) return "verified";
  return "unverified";
};

const mergeValidationAttachments = (attachments: ValidationAttachment[]): ValidationAttachment => ({
  status: combineValidationStatuses(attachments.map((attachment) => attachment.status)),
  reasonCodes: uniqueOrderedStrings(attachments.flatMap((attachment) => attachment.reasonCodes)),
  evidenceRefs: uniqueOrderedStrings(attachments.flatMap((attachment) => attachment.evidenceRefs)),
  recommendedActions: uniqueOrderedStrings(attachments.flatMap((attachment) => attachment.recommendedActions)),
});

const applyValidationOverlay = async (cwd: string, viewModel: NarrativeViewModel, drift: DriftResult): Promise<NarrativeViewModel> => {
  const harnessDriftItems = drift.items.filter((item) => item.scope === "harness" && item.itemType === "harnessSuite");
  const artifactIndex = await createHarnessArtifactIndex(cwd);
  const threadContexts = new Map<string, ValidationContext>();

  for (const thread of viewModel.threads) {
    const relatedArtifactIds = uniqueOrderedStrings([
      ...viewModel.nodes.filter((node) => node.threadId === thread.threadId).flatMap((node) => (node.sourceArtifactId ? [node.sourceArtifactId] : [])),
      ...[...viewModel.intentItems, ...viewModel.unassignedIntentItems]
        .filter((item) => item.threadIds.includes(thread.threadId))
        .map((item) => item.artifactId),
    ]);
    threadContexts.set(thread.threadId, collectValidationContext(relatedArtifactIds, artifactIndex.artifactsById));
  }

  const resolveEntity = (context: ValidationContext): ValidationAttachment => {
    const candidate = findValidationCandidate(context, harnessDriftItems);
    return buildValidationAttachment(candidate, artifactIndex);
  };

  const validationThreadContextByThreadId = new Map<string, ValidationContext>();
  for (const thread of viewModel.threads) {
    const threadContext = threadContexts.get(thread.threadId) ?? EMPTY_VALIDATION_CONTEXT;
    validationThreadContextByThreadId.set(thread.threadId, {
      relatedPaths: uniqueOrderedStrings([...thread.docPaths, ...threadContext.relatedPaths]),
      goalIds: uniqueOrderedStrings([...threadContext.goalIds]),
      episodeIds: uniqueOrderedStrings([...threadContext.episodeIds]),
      snapshotAnchors: uniqueOrderedStrings([...thread.snapshotShas, ...threadContext.snapshotAnchors]),
    });
  }

  const nodeValidationByNodeId = new Map<string, ValidationAttachment>();
  const refreshedNodes = viewModel.nodes.map((node) => {
    const threadContext = validationThreadContextByThreadId.get(node.threadId);
    const artifact = node.sourceArtifactId ? artifactIndex.artifactsById.get(node.sourceArtifactId) : null;
    const nodeRelatedPaths = Array.isArray(artifact?.relatedPaths) ? artifact?.relatedPaths : [];
    const context: ValidationContext = {
      relatedPaths: uniqueOrderedStrings([
        node.path,
        ...node.relatedPaths,
        ...nodeRelatedPaths,
        ...(threadContext?.relatedPaths ?? []),
      ]),
      goalIds: uniqueOrderedStrings([
        ...(artifact?.goalId ? [artifact.goalId] : []),
        ...(threadContext?.goalIds ?? []),
      ]),
      episodeIds: uniqueOrderedStrings([
        ...(artifact?.episodeId ? [artifact.episodeId] : []),
        ...(threadContext?.episodeIds ?? []),
      ]),
      snapshotAnchors: uniqueOrderedStrings([
        node.commitSha,
        ...(artifact?.boundHeadSha ? [artifact.boundHeadSha] : []),
        ...(artifact?.sourceHeadSha ? [artifact.sourceHeadSha] : []),
        ...(artifact?.captureHeadSha ? [artifact.captureHeadSha] : []),
        ...(threadContext?.snapshotAnchors ?? []),
      ]),
    };
    const attachment = resolveEntity(context);
    nodeValidationByNodeId.set(node.nodeId, attachment);
    return {
      ...node,
      validationStatus: attachment.status,
      validationReasonCodes: attachment.reasonCodes,
      validationEvidenceRefs: attachment.evidenceRefs,
      validationRecommendedActions: attachment.recommendedActions,
    };
  });

  const intentValidationByItemId = new Map<string, ValidationAttachment>();
  const buildIntentContext = (item: NarrativeViewModel["intentItems"][number]): ValidationContext => {
    const artifact = artifactIndex.artifactsById.get(item.artifactId);
    const threadContextsForItem = item.threadIds
      .map((threadId) => threadContexts.get(threadId))
      .filter((entry): entry is ValidationContext => Boolean(entry));
    const artifactRelatedPaths = Array.isArray(artifact?.relatedPaths) ? artifact.relatedPaths : [];
    return {
      relatedPaths: uniqueOrderedStrings([
        ...item.relatedPaths,
        ...artifactRelatedPaths,
        ...threadContextsForItem.flatMap((entry) => entry.relatedPaths),
      ]),
      goalIds: uniqueOrderedStrings([
        ...(artifact?.goalId ? [artifact.goalId] : []),
        ...threadContextsForItem.flatMap((entry) => entry.goalIds),
      ]),
      episodeIds: uniqueOrderedStrings([
        ...(artifact?.episodeId ? [artifact.episodeId] : []),
        ...threadContextsForItem.flatMap((entry) => entry.episodeIds),
      ]),
      snapshotAnchors: uniqueOrderedStrings([
        ...(item.anchorSha ? [item.anchorSha] : []),
        ...(artifact?.boundHeadSha ? [artifact.boundHeadSha] : []),
        ...(artifact?.sourceHeadSha ? [artifact.sourceHeadSha] : []),
        ...(artifact?.captureHeadSha ? [artifact.captureHeadSha] : []),
        ...threadContextsForItem.flatMap((entry) => entry.snapshotAnchors),
      ]),
    };
  };

  const refreshedIntentItems = viewModel.intentItems.map((item) => {
    const attachment = resolveEntity(buildIntentContext(item));
    intentValidationByItemId.set(item.itemId, attachment);
    return {
      ...item,
      validationStatus: attachment.status,
      validationReasonCodes: attachment.reasonCodes,
      validationEvidenceRefs: attachment.evidenceRefs,
      validationRecommendedActions: attachment.recommendedActions,
    };
  });

  const unassignedValidationByItemId = new Map<string, ValidationAttachment>();
  const refreshedUnassignedIntentItems = viewModel.unassignedIntentItems.map((item) => {
    const attachment = resolveEntity(buildIntentContext(item));
    unassignedValidationByItemId.set(item.itemId, attachment);
    return {
      ...item,
      validationStatus: attachment.status,
      validationReasonCodes: attachment.reasonCodes,
      validationEvidenceRefs: attachment.evidenceRefs,
      validationRecommendedActions: attachment.recommendedActions,
    };
  });

  const refreshedThreads = viewModel.threads.map((thread) => {
    const threadContext = threadContexts.get(thread.threadId) ?? EMPTY_VALIDATION_CONTEXT;
    const directAttachment = resolveEntity({
      relatedPaths: uniqueOrderedStrings([
        ...thread.docPaths,
        ...viewModel.nodes.filter((node) => node.threadId === thread.threadId).flatMap((node) => node.relatedPaths),
        ...[...viewModel.intentItems, ...viewModel.unassignedIntentItems]
          .filter((item) => item.threadIds.includes(thread.threadId))
          .flatMap((item) => item.relatedPaths),
        ...threadContext.relatedPaths,
      ]),
      goalIds: uniqueOrderedStrings([...threadContext.goalIds]),
      episodeIds: uniqueOrderedStrings([...threadContext.episodeIds]),
      snapshotAnchors: uniqueOrderedStrings([
        ...thread.snapshotShas,
        ...threadContext.snapshotAnchors,
      ]),
    });

    const childAttachments = [
      ...viewModel.nodes
        .filter((node) => node.threadId === thread.threadId)
        .map((node) => nodeValidationByNodeId.get(node.nodeId))
        .filter((attachment): attachment is ValidationAttachment => Boolean(attachment)),
      ...viewModel.intentItems
        .filter((item) => item.threadIds.includes(thread.threadId))
        .map((item) => intentValidationByItemId.get(item.itemId))
        .filter((attachment): attachment is ValidationAttachment => Boolean(attachment)),
      ...viewModel.unassignedIntentItems
        .filter((item) => item.threadIds.includes(thread.threadId))
        .map((item) => unassignedValidationByItemId.get(item.itemId))
        .filter((attachment): attachment is ValidationAttachment => Boolean(attachment)),
    ];

    const attachment = childAttachments.length > 0 ? mergeValidationAttachments([directAttachment, ...childAttachments]) : directAttachment;
    return {
      ...thread,
      validationStatus: attachment.status,
      validationReasonCodes: attachment.reasonCodes,
      validationEvidenceRefs: attachment.evidenceRefs,
      validationRecommendedActions: attachment.recommendedActions,
    };
  });

  const validationCounts = [...refreshedThreads, ...refreshedNodes, ...refreshedIntentItems, ...refreshedUnassignedIntentItems].reduce(
    (acc, item) => {
      if (item.validationStatus === "verified") acc.verified += 1;
      else if (item.validationStatus === "attention") acc.attention += 1;
      else acc.unverified += 1;
      return acc;
    },
    { verified: 0, attention: 0, unverified: 0 },
  );

  return {
    ...viewModel,
    summary: {
      ...viewModel.summary,
      validationCounts,
    },
    threads: refreshedThreads,
    nodes: refreshedNodes,
    intentItems: refreshedIntentItems,
    unassignedIntentItems: refreshedUnassignedIntentItems,
  };
};

const buildDetailPayload = (payload: {
  type: "thread" | "decision" | "intent" | "event";
  title: string;
  summary: string;
  path: string;
  artifactId: string | null;
  snapshotSha: string | null;
  relationKind: string | null;
  confidence: number | null;
  changeType: string | null;
  trust: string;
  sensitivity: string;
  validationStatus: NarrativeValidationStatus | null;
  validationReasonCodes: string[];
  validationEvidenceRefs: string[];
  validationRecommendedActions: string[];
  freshnessStatus: NarrativeFreshnessStatus | null;
  driftReasonCodes: string[];
  recommendedActions: string[];
  driftSourceRefs: string[];
  binding: {
    goalCount: number;
    episodeCount: number;
    sessionCount: number;
    relatedPathCount: number;
  };
}) =>
  JSON.stringify({
    ...payload,
    bindingSummary: [
      `goals=${payload.binding.goalCount}`,
      `episodes=${payload.binding.episodeCount}`,
      `sessions=${payload.binding.sessionCount}`,
      `relatedPaths=${payload.binding.relatedPathCount}`,
    ].join(" · "),
  });

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
                      data-freshness-status="${escapeHtml(node.freshnessStatus ?? "")}"
                      data-detail='${escapeHtml(
                        buildDetailPayload({
                          type: "decision",
                          title: node.title,
                          summary: node.summary,
                          path: node.path,
                          artifactId: node.sourceArtifactId,
                          snapshotSha: node.commitSha,
                          relationKind: node.relationKind,
                          confidence: node.confidence,
                          changeType: node.changeType,
                          trust: node.badges.trust,
                          sensitivity: node.badges.sensitivity,
                          validationStatus: node.validationStatus,
                          validationReasonCodes: node.validationReasonCodes,
                          validationEvidenceRefs: node.validationEvidenceRefs,
                          validationRecommendedActions: node.validationRecommendedActions,
                          freshnessStatus: node.freshnessStatus,
                          driftReasonCodes: node.driftReasonCodes,
                          recommendedActions: node.recommendedActions,
                          driftSourceRefs: node.driftSourceRefs,
                          binding: node.binding,
                        }),
                      )}'
                    >
                      <span class="node-badge">${escapeHtml(node.changeType)}</span>
                      <span class="node-title">${escapeHtml(node.title)}</span>
                      ${renderBadgeRow([
                        renderFreshnessBadge(node.freshnessStatus),
                        renderValidationBadge(node.validationStatus),
                        renderBadge(node.badges.trust, "trust"),
                        renderBadge(node.badges.lineage, node.badges.lineage.startsWith("heuristic") ? "heuristic" : "lineage"),
                        renderBadge(node.badges.sensitivity, node.badges.sensitivity === "standard" ? "muted" : "sensitivity"),
                      ])}
                      <span class="node-meta">${escapeHtml(node.relationKind)}</span>
                      ${renderDriftSummary(node.freshnessStatus, node.driftReasonCodes, node.recommendedActions)}
                      ${renderValidationSummary(
                        node.validationStatus,
                        node.validationReasonCodes,
                        node.validationEvidenceRefs,
                        node.validationRecommendedActions,
                      )}
                    </button>
                  `,
                )
                .join("")}
            </div>
          `;
        })
        .join("");
      const labelDetail = escapeHtml(
        buildDetailPayload({
          type: "thread",
          title: thread.title,
          summary: `${thread.docType} thread across ${thread.snapshotShas.length} snapshot(s)`,
          path: thread.docPaths.join(", "),
          artifactId: null,
          snapshotSha: thread.snapshotShas.at(-1) ?? null,
          relationKind: thread.badges.lineageKinds.join(", "),
          confidence: null,
          changeType: null,
          trust: thread.badges.trust,
          sensitivity: thread.badges.sensitivity,
          validationStatus: thread.validationStatus,
          validationReasonCodes: thread.validationReasonCodes,
          validationEvidenceRefs: thread.validationEvidenceRefs,
          validationRecommendedActions: thread.validationRecommendedActions,
          freshnessStatus: thread.freshnessStatus,
          driftReasonCodes: thread.driftReasonCodes,
          recommendedActions: thread.recommendedActions,
          driftSourceRefs: thread.driftSourceRefs,
          binding: thread.binding,
        }),
      );
      return `
        <div class="thread-row" style="grid-template-columns: 220px repeat(${viewModel.snapshots.length}, minmax(160px, 1fr));">
          <button
            type="button"
            class="thread-label"
            data-thread-focus="${escapeHtml(thread.threadId)}"
            data-thread-ref="${escapeHtml(thread.threadId)}"
            data-freshness-status="${escapeHtml(thread.freshnessStatus ?? "")}"
            data-detail='${labelDetail}'
          >
            <span class="thread-title">${escapeHtml(thread.title)}</span>
            ${renderBadgeRow([
              renderFreshnessBadge(thread.freshnessStatus),
              renderValidationBadge(thread.validationStatus),
              renderBadge(thread.badges.trust, "trust"),
              renderBadge(thread.badges.sensitivity, thread.badges.sensitivity === "standard" ? "muted" : "sensitivity"),
              ...thread.badges.lineageKinds.map((lineage) =>
                renderBadge(lineage, lineage.startsWith("heuristic") ? "heuristic" : "lineage"),
              ),
            ])}
            <span class="thread-meta">${escapeHtml(thread.docType)} · ${thread.nodeIds.length} node(s)</span>
            ${renderDriftSummary(thread.freshnessStatus, thread.driftReasonCodes, thread.recommendedActions)}
            ${renderValidationSummary(
              thread.validationStatus,
              thread.validationReasonCodes,
              thread.validationEvidenceRefs,
              thread.validationRecommendedActions,
            )}
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
        buildDetailPayload({
          type: "intent",
          title: item.title,
          summary: item.summary,
          path: item.relatedPaths.join(", "),
          artifactId: item.artifactId,
          snapshotSha: item.anchorSha,
          relationKind: item.kind,
          confidence: null,
          changeType: item.status,
          trust: item.badges.trust,
          sensitivity: item.badges.sensitivity,
          validationStatus: item.validationStatus,
          validationReasonCodes: item.validationReasonCodes,
          validationEvidenceRefs: item.validationEvidenceRefs,
          validationRecommendedActions: item.validationRecommendedActions,
          freshnessStatus: item.freshnessStatus,
          driftReasonCodes: item.driftReasonCodes,
          recommendedActions: item.recommendedActions,
          driftSourceRefs: item.driftSourceRefs,
          binding: item.binding,
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
            data-freshness-status="${escapeHtml(item.freshnessStatus ?? "")}"
            data-detail='${detail}'
          >
            <span class="intent-kind">${escapeHtml(item.kind)}</span>
            <span class="intent-title">${escapeHtml(item.title)}</span>
            ${renderBadgeRow([
              renderFreshnessBadge(item.freshnessStatus),
              renderValidationBadge(item.validationStatus),
              renderBadge(item.badges.trust, "trust"),
              renderBadge(item.badges.sensitivity, item.badges.sensitivity === "standard" ? "muted" : "sensitivity"),
            ])}
            <span class="intent-summary">${escapeHtml(item.summary)}</span>
            ${renderDriftSummary(item.freshnessStatus, item.driftReasonCodes, item.recommendedActions)}
            ${renderValidationSummary(
              item.validationStatus,
              item.validationReasonCodes,
              item.validationEvidenceRefs,
              item.validationRecommendedActions,
            )}
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
        buildDetailPayload({
          type: "event",
          title: event.eventType,
          summary: event.summary,
          path: event.relatedPaths.join(", "),
          artifactId: null,
          snapshotSha: event.sourceHeadSha,
          relationKind: "event",
          confidence: null,
          changeType: null,
          trust: event.badges.trust,
          sensitivity: event.badges.sensitivity,
          validationStatus: null,
          validationReasonCodes: [],
          validationEvidenceRefs: [],
          validationRecommendedActions: [],
          freshnessStatus: null,
          driftReasonCodes: [],
          recommendedActions: [],
          driftSourceRefs: [],
          binding: event.binding,
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
            ${renderBadgeRow([
              renderBadge(event.badges.trust, "trust"),
              renderBadge(event.badges.sensitivity, event.badges.sensitivity === "standard" ? "muted" : "sensitivity"),
            ])}
            <span class="timeline-summary">${escapeHtml(event.summary)}</span>
          </button>
        </article>
      `;
    })
    .join("");
};

const renderValidationSection = (viewModel: NarrativeViewModel): string => {
  const renderGroup = (
    title: string,
    items: Array<{
      label: string;
      summary: string;
      status: NarrativeValidationStatus | null;
      reasonCodes: string[];
      evidenceRefs: string[];
      recommendedActions: string[];
      threadId: string;
      detail: string;
    }>,
  ): string => {
    if (items.length === 0) {
      return `<div class="empty-state"><p>No ${escapeHtml(title.toLowerCase())} validation in the selected window.</p></div>`;
    }
    return items
      .map(
        (item) => `
          <article class="validation-item">
            <button
              type="button"
              class="validation-button"
              data-thread-focus="${escapeHtml(item.threadId)}"
              data-detail='${escapeHtml(item.detail)}'
            >
              <span class="validation-kind">${escapeHtml(title)}</span>
              <span class="validation-title">${escapeHtml(item.label)}</span>
              ${renderBadgeRow([renderValidationBadge(item.status)])}
              <span class="validation-summary-text">${escapeHtml(item.summary)}</span>
              ${renderValidationSummary(item.status, item.reasonCodes, item.evidenceRefs, item.recommendedActions)}
            </button>
          </article>
        `,
      )
      .join("");
  };

  const threadItems = viewModel.threads.map((thread) => ({
    label: thread.title,
    summary: `${thread.docType} thread · ${thread.nodeIds.length} node(s)`,
    status: thread.validationStatus,
    reasonCodes: thread.validationReasonCodes,
    evidenceRefs: thread.validationEvidenceRefs,
    recommendedActions: thread.validationRecommendedActions,
    threadId: thread.threadId,
    detail: buildDetailPayload({
      type: "thread",
      title: thread.title,
      summary: `${thread.docType} thread across ${thread.snapshotShas.length} snapshot(s)`,
      path: thread.docPaths.join(", "),
      artifactId: null,
      snapshotSha: thread.snapshotShas.at(-1) ?? null,
      relationKind: thread.badges.lineageKinds.join(", "),
      confidence: null,
      changeType: null,
      trust: thread.badges.trust,
      sensitivity: thread.badges.sensitivity,
      validationStatus: thread.validationStatus,
      validationReasonCodes: thread.validationReasonCodes,
      validationEvidenceRefs: thread.validationEvidenceRefs,
      validationRecommendedActions: thread.validationRecommendedActions,
      freshnessStatus: thread.freshnessStatus,
      driftReasonCodes: thread.driftReasonCodes,
      recommendedActions: thread.recommendedActions,
      driftSourceRefs: thread.driftSourceRefs,
      binding: thread.binding,
    }),
  }));

  const nodeItems = viewModel.nodes.map((node) => ({
    label: node.title,
    summary: `${node.docType} · ${node.changeType} · ${normalizeRepoPath(node.path)}`,
    status: node.validationStatus,
    reasonCodes: node.validationReasonCodes,
    evidenceRefs: node.validationEvidenceRefs,
    recommendedActions: node.validationRecommendedActions,
    threadId: node.threadId,
    detail: buildDetailPayload({
      type: "decision",
      title: node.title,
      summary: node.summary,
      path: node.path,
      artifactId: node.sourceArtifactId,
      snapshotSha: node.commitSha,
      relationKind: node.relationKind,
      confidence: node.confidence,
      changeType: node.changeType,
      trust: node.badges.trust,
      sensitivity: node.badges.sensitivity,
      validationStatus: node.validationStatus,
      validationReasonCodes: node.validationReasonCodes,
      validationEvidenceRefs: node.validationEvidenceRefs,
      validationRecommendedActions: node.validationRecommendedActions,
      freshnessStatus: node.freshnessStatus,
      driftReasonCodes: node.driftReasonCodes,
      recommendedActions: node.recommendedActions,
      driftSourceRefs: node.driftSourceRefs,
      binding: node.binding,
    }),
  }));

  const intentItems = [...viewModel.intentItems, ...viewModel.unassignedIntentItems].map((item) => ({
    label: item.title,
    summary: `${item.kind} · ${item.status} · ${item.relatedPaths.length} related path(s)`,
    status: item.validationStatus,
    reasonCodes: item.validationReasonCodes,
    evidenceRefs: item.validationEvidenceRefs,
    recommendedActions: item.validationRecommendedActions,
    threadId: item.threadIds[0] ?? "",
    detail: buildDetailPayload({
      type: "intent",
      title: item.title,
      summary: item.summary,
      path: item.relatedPaths.join(", "),
      artifactId: item.artifactId,
      snapshotSha: item.anchorSha,
      relationKind: item.kind,
      confidence: null,
      changeType: item.status,
      trust: item.badges.trust,
      sensitivity: item.badges.sensitivity,
      validationStatus: item.validationStatus,
      validationReasonCodes: item.validationReasonCodes,
      validationEvidenceRefs: item.validationEvidenceRefs,
      validationRecommendedActions: item.validationRecommendedActions,
      freshnessStatus: item.freshnessStatus,
      driftReasonCodes: item.driftReasonCodes,
      recommendedActions: item.recommendedActions,
      driftSourceRefs: item.driftSourceRefs,
      binding: item.binding,
    }),
  }));

  return `
    <section id="validation-panel">
      <h2>Validation Panel</h2>
      <div class="summary-grid validation-summary-grid">
        <div class="summary-card validation-card validation-verified"><div class="summary-label">Verified</div><div class="summary-value">${viewModel.summary.validationCounts.verified}</div></div>
        <div class="summary-card validation-card validation-attention"><div class="summary-label">Attention</div><div class="summary-value">${viewModel.summary.validationCounts.attention}</div></div>
        <div class="summary-card validation-card validation-unverified"><div class="summary-label">Unverified</div><div class="summary-value">${viewModel.summary.validationCounts.unverified}</div></div>
      </div>
      <div class="intent-group">
        <h3>Threads</h3>
        <div class="validation-list">${renderGroup("Thread", threadItems)}</div>
      </div>
      <div class="intent-group">
        <h3>Decision Nodes</h3>
        <div class="validation-list">${renderGroup("Node", nodeItems)}</div>
      </div>
      <div class="intent-group">
        <h3>Intent Items</h3>
        <div class="validation-list">${renderGroup("Intent", intentItems)}</div>
      </div>
    </section>
  `;
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
      .badge-row {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .badge {
        display: inline-flex;
        align-items: center;
        min-height: 22px;
        padding: 0 8px;
        border-radius: 999px;
        border: 1px solid transparent;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.01em;
      }
      .badge-trust {
        background: rgba(14, 107, 80, 0.12);
        border-color: rgba(14, 107, 80, 0.24);
        color: #0e6b50;
      }
      .badge-freshness {
        background: rgba(15, 92, 142, 0.12);
        border-color: rgba(15, 92, 142, 0.24);
        color: #0f5c8e;
      }
      .badge-freshness-fresh {
        background: rgba(84, 182, 125, 0.12);
        border-color: rgba(84, 182, 125, 0.24);
        color: #2f7f51;
      }
      .badge-freshness-suspect {
        background: rgba(211, 166, 40, 0.16);
        border-color: rgba(211, 166, 40, 0.28);
        color: #8b6200;
      }
      .badge-freshness-stale {
        background: rgba(196, 93, 74, 0.14);
        border-color: rgba(196, 93, 74, 0.24);
        color: #8b2f1f;
      }
      .badge-lineage {
        background: rgba(20, 61, 89, 0.08);
        border-color: rgba(20, 61, 89, 0.18);
        color: #143d59;
      }
      .badge-heuristic {
        background: rgba(211, 166, 40, 0.16);
        border-color: rgba(211, 166, 40, 0.28);
        color: #8b6200;
      }
      .badge-sensitivity {
        background: rgba(196, 93, 74, 0.14);
        border-color: rgba(196, 93, 74, 0.24);
        color: #8b2f1f;
      }
      .badge-validation {
        background: rgba(15, 92, 142, 0.12);
        border-color: rgba(15, 92, 142, 0.24);
        color: #0f5c8e;
      }
      .badge-validation-verified {
        background: rgba(84, 182, 125, 0.12);
        border-color: rgba(84, 182, 125, 0.24);
        color: #2f7f51;
      }
      .badge-validation-attention {
        background: rgba(211, 166, 40, 0.16);
        border-color: rgba(211, 166, 40, 0.28);
        color: #8b6200;
      }
      .badge-validation-unverified {
        background: rgba(107, 101, 92, 0.08);
        border-color: rgba(107, 101, 92, 0.18);
        color: var(--muted);
      }
      .badge-muted {
        background: rgba(107, 101, 92, 0.08);
        border-color: rgba(107, 101, 92, 0.18);
        color: var(--muted);
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
      .drift-summary {
        font-size: 12px;
        line-height: 1.45;
        color: var(--muted);
      }
      .validation-summary {
        font-size: 12px;
        line-height: 1.45;
        color: #325d85;
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
      .validation-list {
        display: grid;
        gap: 10px;
        margin-top: 12px;
      }
      .validation-item {
        border: 1px solid var(--line);
        border-radius: 14px;
        background: rgba(255,255,255,0.72);
      }
      .validation-button {
        width: 100%;
        appearance: none;
        border: 0;
        background: transparent;
        text-align: left;
        cursor: pointer;
        color: inherit;
        padding: 14px;
        display: grid;
        gap: 6px;
      }
      .validation-kind {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--muted);
      }
      .validation-title {
        font-weight: 700;
      }
      .validation-summary-text {
        font-size: 13px;
        line-height: 1.45;
        color: #3f392f;
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
          <div class="summary-card freshness-card freshness-fresh"><div class="summary-label">Fresh</div><div class="summary-value">${viewModel.summary.freshnessCounts.fresh}</div></div>
          <div class="summary-card freshness-card freshness-suspect"><div class="summary-label">Suspect</div><div class="summary-value">${viewModel.summary.freshnessCounts.suspect}</div></div>
          <div class="summary-card freshness-card freshness-stale"><div class="summary-label">Stale</div><div class="summary-value">${viewModel.summary.freshnessCounts.stale}</div></div>
          <div class="summary-card validation-card validation-verified"><div class="summary-label">Verified</div><div class="summary-value">${viewModel.summary.validationCounts.verified}</div></div>
          <div class="summary-card validation-card validation-attention"><div class="summary-label">Attention</div><div class="summary-value">${viewModel.summary.validationCounts.attention}</div></div>
          <div class="summary-card validation-card validation-unverified"><div class="summary-label">Unverified</div><div class="summary-value">${viewModel.summary.validationCounts.unverified}</div></div>
        </div>
        <div class="detail-list">
          <div><strong>Window</strong>: ${escapeHtml(viewModel.window.revRange ?? "HEAD")} · max ${viewModel.window.maxCommits} selected snapshot commit(s)</div>
          <div><strong>Generated at</strong>: ${escapeHtml(viewModel.generatedAt)}</div>
          <div><strong>Projection</strong>: ${escapeHtml(viewModel.projectionMode)} · policy v${viewModel.projectionPolicyVersion}</div>
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

          ${renderValidationSection(viewModel)}

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
          ["Freshness", payload.freshnessStatus || "none"],
          ["Validation", payload.validationStatus || "none"],
          [
            "Validation Reasons",
            Array.isArray(payload.validationReasonCodes) && payload.validationReasonCodes.length > 0
              ? payload.validationReasonCodes.join(", ")
              : "none",
          ],
          [
            "Validation Evidence",
            Array.isArray(payload.validationEvidenceRefs) && payload.validationEvidenceRefs.length > 0
              ? payload.validationEvidenceRefs.join(", ")
              : "none",
          ],
          [
            "Validation Recommended Action",
            Array.isArray(payload.validationRecommendedActions) && payload.validationRecommendedActions.length > 0
              ? payload.validationRecommendedActions.join(", ")
              : "none",
          ],
          ["Reasons", Array.isArray(payload.driftReasonCodes) && payload.driftReasonCodes.length > 0 ? payload.driftReasonCodes.join(", ") : "none"],
          [
            "Recommended Action",
            Array.isArray(payload.recommendedActions) && payload.recommendedActions.length > 0 ? payload.recommendedActions.join(", ") : "none",
          ],
          ["Drift Sources", Array.isArray(payload.driftSourceRefs) && payload.driftSourceRefs.length > 0 ? payload.driftSourceRefs.join(", ") : "none"],
          ["Trust", payload.trust || "none"],
          ["Sensitivity", payload.sensitivity || "none"],
          ["Bindings", payload.bindingSummary || "none"],
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

export const runNarrativeReport = async (cwd: string, options: NarrativeOptions = {}): Promise<NarrativeResult> => {
  const paths = resolveRagitPaths(cwd);
  const built = await buildNarrativeViewModel(cwd, options);
  const drift = await runDrift(cwd);
  const viewModelWithFreshness = applyDriftOverlay(built.viewModel, drift);
  const viewModel = await applyValidationOverlay(cwd, viewModelWithFreshness, drift);
  const modelOutput = options.emitModel ? resolveNarrativeModelOutput(cwd, options.emitModel) : null;
  if (!options.dryRun) {
    await mkdir(path.dirname(built.absoluteReportPath), { recursive: true });
    await writeFile(built.absoluteReportPath, renderNarrativeReport(viewModel), "utf8");
    if (modelOutput) {
      await mkdir(path.dirname(modelOutput.absolutePath), { recursive: true });
      await writeFile(modelOutput.absolutePath, `${JSON.stringify(viewModel, null, 2)}\n`, "utf8");
    }
  }
  if (!options.output && built.result.reportPath.startsWith(".ragit/")) {
    await mkdir(paths.narrativeReportsDir, { recursive: true });
  }
  return {
    ...built.result,
    summary: viewModel.summary,
    modelPath: modelOutput?.displayPath ?? null,
  };
};

export const formatNarrativeText = (
  result: NarrativeResult & { schemaVersion?: number; projectionPolicyVersion?: number; projectionMode?: string },
): string =>
  [
    "# ragit narrative",
    `- dry_run: ${result.dryRun}`,
    `- report_path: ${result.reportPath}`,
    ...(result.modelPath ? [`- model_path: ${result.modelPath}`] : []),
    `- schema_version: ${result.schemaVersion ?? NARRATIVE_MODEL_SCHEMA_VERSION}`,
    `- projection_policy_version: ${result.projectionPolicyVersion ?? NARRATIVE_PROJECTION_POLICY_VERSION}`,
    `- projection_mode: ${result.projectionMode ?? NARRATIVE_PROJECTION_MODE}`,
    `- head: ${result.headSha}`,
    `- window_rev_range: ${result.window.revRange ?? "HEAD"}`,
    `- selected_snapshots: ${result.window.selectedSnapshotShas.length}`,
    `- missing_snapshot_commits: ${result.window.missingSnapshotCommits}`,
    `- decision_threads: ${result.summary.decisionThreads}`,
    `- decision_nodes: ${result.summary.decisionNodes}`,
    `- intent_items: ${result.summary.intentItems}`,
    `- timeline_events: ${result.summary.timelineEvents}`,
    `- heuristic_edges: ${result.summary.heuristicEdges}`,
    `- freshness_counts: fresh=${result.summary.freshnessCounts.fresh} suspect=${result.summary.freshnessCounts.suspect} stale=${result.summary.freshnessCounts.stale}`,
    `- validation_counts: verified=${result.summary.validationCounts.verified} attention=${result.summary.validationCounts.attention} unverified=${result.summary.validationCounts.unverified}`,
    ...(result.warnings.length === 0 ? [] : ["", ...result.warnings.map((warning) => `- warning ${warning}`)]),
  ].join("\n");
