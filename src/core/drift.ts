import { access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { listArtifactRecords, loadArtifactRecord } from "./artifacts.js";
import { CliView } from "./cliContract.js";
import { getHeadSha, listChangedFilesSince } from "./git.js";
import { latestSnapshotSha, loadSnapshotManifestIfExists } from "./manifest.js";
import {
  ArtifactRecord,
  ArtifactStatus,
  DriftItem,
  DriftReasonCode,
  DriftResult,
  DriftScope,
  DriftStatus,
  SnapshotManifest,
} from "./types.js";

export interface DriftQueryOptions {
  scope?: DriftScope;
  path?: string;
  goalId?: string;
  sessionId?: string;
  maxCount?: number;
}

type TargetScope = Exclude<DriftScope, "all">;

interface BaselineContext {
  headSha: string | null;
  snapshotSha: string | null;
  manifest: SnapshotManifest | null;
  reasonCodes: DriftReasonCode[];
}

const STALE_REASONS = new Set<DriftReasonCode>([
  "tracked_path_changed",
  "related_path_changed",
  "related_path_missing",
  "source_head_behind",
  "bound_head_behind",
  "failure_evidence_present",
  "dependency_stale",
]);

const SUSPECT_REASONS = new Set<DriftReasonCode>([
  "no_baseline",
  "missing_manifest_anchor",
  "missing_binding",
  "binding_local_only",
]);

const STATUS_PRIORITY: Record<DriftStatus, number> = {
  stale: 0,
  suspect: 1,
  fresh: 2,
};

const normalizeRepoPath = (value: string): string => value.replaceAll("\\", "/");
const shortSha = (value: string | null | undefined): string => (value ? value.slice(0, 7) : "none");

const escapeRegex = (value: string): string => value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");

const compileGlobPattern = (pattern: string): RegExp => {
  const normalized = normalizeRepoPath(pattern.trim());
  let regex = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const current = normalized[index];
    const next = normalized[index + 1];
    const afterNext = normalized[index + 2];
    if (current === "*" && next === "*" && afterNext === "/") {
      regex += "(?:.*/)?";
      index += 2;
      continue;
    }
    if (current === "*" && next === "*") {
      regex += ".*";
      index += 1;
      continue;
    }
    if (current === "*") {
      regex += "[^/]*";
      continue;
    }
    if (current === "?") {
      regex += "[^/]";
      continue;
    }
    regex += escapeRegex(current);
  }
  regex += "$";
  return new RegExp(regex);
};

const createPathMatcher = (globText?: string): ((candidate: string) => boolean) => {
  if (!globText) return () => true;
  const matchers = globText
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(compileGlobPattern);
  if (matchers.length === 0) return () => true;
  return (candidate: string) => matchers.some((matcher) => matcher.test(normalizeRepoPath(candidate)));
};

const pushReason = (reasons: DriftReasonCode[], reason: DriftReasonCode): void => {
  if (!reasons.includes(reason)) {
    reasons.push(reason);
  }
};

const uniqueSorted = (values: string[]): string[] => Array.from(new Set(values.filter(Boolean))).sort((left, right) => left.localeCompare(right));

const deriveStatus = (reasons: DriftReasonCode[]): DriftStatus => {
  if (reasons.some((reason) => STALE_REASONS.has(reason))) return "stale";
  if (reasons.some((reason) => SUSPECT_REASONS.has(reason))) return "suspect";
  return "fresh";
};

const combineOverallStatus = (items: DriftItem[]): DriftStatus => {
  if (items.some((item) => item.status === "stale")) return "stale";
  if (items.some((item) => item.status === "suspect")) return "suspect";
  return "fresh";
};

const safeHeadSha = async (cwd: string): Promise<string | null> => {
  try {
    return await getHeadSha(cwd);
  } catch {
    return null;
  }
};

const safeLatestSnapshotSha = async (cwd: string): Promise<string | null> => {
  try {
    return await latestSnapshotSha(cwd);
  } catch {
    return null;
  }
};

const pathExists = async (cwd: string, repoPath: string): Promise<boolean> => {
  try {
    await access(path.resolve(cwd, repoPath), constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

const resolveBaseline = async (cwd: string): Promise<BaselineContext> => {
  const headSha = await safeHeadSha(cwd);
  const headManifest = await loadSnapshotManifestIfExists(cwd, headSha);
  if (headManifest) {
    return {
      headSha,
      snapshotSha: headSha,
      manifest: headManifest,
      reasonCodes: [],
    };
  }

  const latestSha = await safeLatestSnapshotSha(cwd);
  const latestManifest = await loadSnapshotManifestIfExists(cwd, latestSha);
  if (latestManifest) {
    return {
      headSha,
      snapshotSha: latestSha,
      manifest: latestManifest,
      reasonCodes: ["missing_manifest_anchor"],
    };
  }

  return {
    headSha,
    snapshotSha: null,
    manifest: null,
    reasonCodes: ["no_baseline"],
  };
};

const buildChangedPathCache = () => {
  const cache = new Map<string, Set<string>>();
  return async (cwd: string, anchorSha: string | null): Promise<Set<string>> => {
    if (!anchorSha) return new Set();
    const cached = cache.get(anchorSha);
    if (cached) return cached;
    try {
      const changed = await listChangedFilesSince(cwd, anchorSha);
      const normalized = new Set(changed.map((entry) => normalizeRepoPath(entry)));
      cache.set(anchorSha, normalized);
      return normalized;
    } catch {
      const empty = new Set<string>();
      cache.set(anchorSha, empty);
      return empty;
    }
  };
};

const buildRecommendedActions = (
  scope: TargetScope,
  reasons: DriftReasonCode[],
  artifactStatus?: ArtifactStatus,
): string[] => {
  const actions = new Set<string>();
  if (reasons.includes("no_baseline") || reasons.includes("missing_manifest_anchor") || reasons.includes("tracked_path_changed")) {
    actions.add("ingest");
  }
  if (reasons.includes("related_path_changed") || reasons.includes("related_path_missing")) {
    actions.add("doc refresh");
  }
  if (reasons.includes("missing_binding") || reasons.includes("binding_local_only")) {
    actions.add("artifact review");
    actions.add("ingest");
  }
  if (scope === "memory") {
    if (reasons.some((reason) => ["related_path_changed", "related_path_missing", "source_head_behind", "bound_head_behind"].includes(reason))) {
      actions.add("artifact review");
    }
    if (artifactStatus === "reviewed" && reasons.length > 0) {
      actions.add("memory promote");
    }
  }
  if (scope === "harness") {
    if (reasons.includes("dependency_stale")) {
      actions.add("artifact review");
      actions.add("harness verify");
    }
    if (reasons.includes("failure_evidence_present")) {
      actions.add("harness verify");
      actions.add("harness run");
    }
  }
  return Array.from(actions);
};

const sortItems = (items: DriftItem[]): DriftItem[] =>
  [...items].sort((left, right) => {
    const byStatus = STATUS_PRIORITY[left.status] - STATUS_PRIORITY[right.status];
    if (byStatus !== 0) return byStatus;
    const byScope = left.scope.localeCompare(right.scope);
    if (byScope !== 0) return byScope;
    const byType = left.itemType.localeCompare(right.itemType);
    if (byType !== 0) return byType;
    return left.title.localeCompare(right.title);
  });

const createBaselineItem = (baseline: BaselineContext): DriftItem | null => {
  if (baseline.reasonCodes.length === 0) return null;
  return {
    scope: "durable",
    itemType: "baseline",
    id: "baseline",
    title: baseline.reasonCodes.includes("no_baseline") ? "No searchable snapshot baseline" : "Current HEAD is not indexed",
    status: deriveStatus(baseline.reasonCodes),
    reasonCodes: [...baseline.reasonCodes],
    affectedPaths: [],
    sourceRefs: {
      headSha: baseline.headSha,
      snapshotSha: baseline.snapshotSha,
      anchorSha: baseline.manifest?.commitSha ?? null,
    },
    recommendedActions: buildRecommendedActions("durable", baseline.reasonCodes),
  };
};

const evaluateDurableDocs = async (
  cwd: string,
  baseline: BaselineContext,
  pathMatches: (candidate: string) => boolean,
): Promise<DriftItem[]> => {
  if (!baseline.manifest) return [];
  const changedSinceSnapshot =
    baseline.headSha && baseline.manifest.commitSha !== baseline.headSha
      ? await listChangedFilesSince(cwd, baseline.manifest.commitSha).then((entries) => new Set(entries.map((entry) => normalizeRepoPath(entry)))).catch(() => new Set<string>())
      : new Set<string>();

  return baseline.manifest.docs
    .filter((doc) => pathMatches(doc.path))
    .map((doc) => {
      const reasons: DriftReasonCode[] = [];
      const affectedPaths: string[] = [];
      const normalizedPath = normalizeRepoPath(doc.path);
      if (changedSinceSnapshot.has(normalizedPath)) {
        pushReason(reasons, "tracked_path_changed");
        affectedPaths.push(normalizedPath);
      }
      return {
        scope: "durable",
        itemType: "document",
        id: doc.id,
        title: doc.path,
        status: deriveStatus(reasons),
        reasonCodes: reasons,
        affectedPaths: uniqueSorted(affectedPaths),
        sourceRefs: {
          headSha: baseline.headSha,
          snapshotSha: baseline.snapshotSha,
          anchorSha: baseline.manifest?.commitSha ?? null,
        },
        recommendedActions: buildRecommendedActions("durable", reasons),
      } satisfies DriftItem;
    });
};

const evaluateArtifact = async (
  cwd: string,
  scope: TargetScope,
  artifact: ArtifactRecord,
  currentHeadSha: string | null,
  changedPathSetFor: (cwd: string, anchorSha: string | null) => Promise<Set<string>>,
): Promise<DriftItem> => {
  const reasons: DriftReasonCode[] = [];
  const affectedPaths: string[] = [];
  const anchorSha = artifact.boundHeadSha ?? artifact.sourceHeadSha ?? artifact.captureHeadSha;

  if (!anchorSha || artifact.bindingStatus === "pending") {
    pushReason(reasons, "missing_binding");
  }
  if (artifact.bindingStatus === "local_only") {
    pushReason(reasons, "binding_local_only");
  }

  const changedSinceAnchor = await changedPathSetFor(cwd, anchorSha);
  for (const relatedPath of artifact.relatedPaths) {
    const normalizedPath = normalizeRepoPath(relatedPath);
    const exists = await pathExists(cwd, relatedPath);
    if (!exists) {
      pushReason(reasons, "related_path_missing");
      affectedPaths.push(normalizedPath);
      continue;
    }
    if (changedSinceAnchor.has(normalizedPath)) {
      pushReason(reasons, "related_path_changed");
      affectedPaths.push(normalizedPath);
    }
  }

  if (currentHeadSha && anchorSha && currentHeadSha !== anchorSha && artifact.relatedPaths.length === 0 && changedSinceAnchor.size > 0) {
    if (artifact.boundHeadSha) {
      pushReason(reasons, "bound_head_behind");
    } else {
      pushReason(reasons, "source_head_behind");
    }
  }

  return {
    scope,
    itemType: scope === "memory" ? "memoryArtifact" : "harnessSuite",
    id: artifact.artifactId,
    title: artifact.title,
    status: deriveStatus(reasons),
    reasonCodes: reasons,
    affectedPaths: uniqueSorted(affectedPaths),
    sourceRefs: {
      headSha: currentHeadSha,
      anchorSha,
      sourceHeadSha: artifact.sourceHeadSha,
      boundHeadSha: artifact.boundHeadSha,
      captureHeadSha: artifact.captureHeadSha,
      artifactId: artifact.artifactId,
      goalId: artifact.goalId,
      episodeId: artifact.episodeId,
      sourceSessionId: artifact.sourceSessionId,
    },
    recommendedActions: buildRecommendedActions(scope, reasons, artifact.status),
  };
};

const matchesSharedFilters = (artifact: ArtifactRecord, options: DriftQueryOptions): boolean => {
  if (options.goalId && artifact.goalId !== options.goalId) return false;
  if (options.sessionId && artifact.sourceSessionId !== options.sessionId) return false;
  return true;
};

export const runDrift = async (cwd: string, options: DriftQueryOptions = {}): Promise<DriftResult> => {
  const scope = options.scope ?? "all";
  const maxCount = options.maxCount ?? null;
  const pathMatches = createPathMatcher(options.path);
  const baseline = await resolveBaseline(cwd);
  const changedPathSetFor = buildChangedPathCache();
  const items: DriftItem[] = [];

  if (scope === "all" || scope === "durable") {
    const baselineItem = createBaselineItem(baseline);
    if (baselineItem) items.push(baselineItem);
    items.push(...(await evaluateDurableDocs(cwd, baseline, pathMatches)));
  }

  if (scope === "all" || scope === "memory") {
    const memoryArtifacts = (await listArtifactRecords(cwd, { scope: "session", statuses: ["reviewed", "promoted"] }))
      .filter((artifact) => matchesSharedFilters(artifact, options))
      .filter((artifact) => artifact.relatedPaths.length === 0 || artifact.relatedPaths.some((candidate) => pathMatches(candidate)));

    for (const artifact of memoryArtifacts) {
      items.push(await evaluateArtifact(cwd, "memory", artifact, baseline.headSha, changedPathSetFor));
    }
  }

  if (scope === "all" || scope === "harness") {
    const harnessArtifacts = await listArtifactRecords(cwd, {
      scope: "harness",
      statuses: ["captured", "reviewed", "promoted"],
    });
    const harnessFailures = harnessArtifacts.filter((artifact) => artifact.kind === "failure");
    const suites = harnessArtifacts
      .filter((artifact) => artifact.kind === "suite")
      .filter((artifact) => ["reviewed", "promoted"].includes(artifact.status))
      .filter((artifact) => matchesSharedFilters(artifact, options))
      .filter((artifact) => artifact.relatedPaths.length === 0 || artifact.relatedPaths.some((candidate) => pathMatches(candidate)));

    for (const suite of suites) {
      const base = await evaluateArtifact(cwd, "harness", suite, baseline.headSha, changedPathSetFor);
      const resourceRefs = Array.isArray(suite.payload?.resourceRefs) ? (suite.payload.resourceRefs as string[]) : [];
      const reasons = [...base.reasonCodes];
      const affectedPaths = [...base.affectedPaths];

      for (const resourceRef of resourceRefs) {
        try {
          const dependency = await loadArtifactRecord(cwd, resourceRef);
          if (!dependency) {
            pushReason(reasons, "dependency_stale");
            continue;
          }
          if (!["reviewed", "promoted"].includes(dependency.status)) {
            pushReason(reasons, "dependency_stale");
            affectedPaths.push(...dependency.relatedPaths);
            continue;
          }
          const dependencyItem = await evaluateArtifact(cwd, "memory", dependency, baseline.headSha, changedPathSetFor);
          if (dependencyItem.status !== "fresh") {
            pushReason(reasons, "dependency_stale");
            affectedPaths.push(...dependencyItem.affectedPaths, ...dependency.relatedPaths);
          }
        } catch {
          pushReason(reasons, "dependency_stale");
        }
      }

      const relatedFailures = harnessFailures.filter((artifact) => artifact.payload?.suiteId === suite.artifactId);
      if (relatedFailures.length > 0) {
        pushReason(reasons, "failure_evidence_present");
        for (const failure of relatedFailures) {
          affectedPaths.push(...failure.relatedPaths);
        }
      }

      items.push({
        ...base,
        status: deriveStatus(reasons),
        reasonCodes: reasons,
        affectedPaths: uniqueSorted(affectedPaths),
        recommendedActions: buildRecommendedActions("harness", reasons, suite.status),
      });
    }
  }

  const filtered = sortItems(items);
  const limited = maxCount ? filtered.slice(0, maxCount) : filtered;
  const counts: Record<DriftStatus, number> = {
    fresh: limited.filter((item) => item.status === "fresh").length,
    suspect: limited.filter((item) => item.status === "suspect").length,
    stale: limited.filter((item) => item.status === "stale").length,
  };

  return {
    overallStatus: combineOverallStatus(limited),
    counts,
    filters: {
      scope,
      path: options.path ?? null,
      goalId: options.goalId ?? null,
      sessionId: options.sessionId ?? null,
      maxCount,
    },
    baseline: {
      headSha: baseline.headSha,
      snapshotSha: baseline.snapshotSha,
      snapshotCommitSha: baseline.manifest?.commitSha ?? null,
      reasonCodes: baseline.reasonCodes,
    },
    items: limited,
  };
};

const formatReasons = (reasons: DriftReasonCode[]): string => (reasons.length > 0 ? reasons.join(", ") : "none");
const formatPaths = (paths: string[]): string => (paths.length > 0 ? paths.join(", ") : "none");
const formatActions = (actions: string[]): string => (actions.length > 0 ? actions.join(", ") : "none");

export const formatDriftText = (result: DriftResult, view: CliView): string => {
  const header = [
    "# ragit drift",
    `- overall: ${result.overallStatus}`,
    `- counts: fresh=${result.counts.fresh}, suspect=${result.counts.suspect}, stale=${result.counts.stale}`,
    `- scope: ${result.filters.scope}`,
    `- head: ${shortSha(result.baseline.headSha)}`,
    `- snapshot: ${shortSha(result.baseline.snapshotSha)}`,
    `- baseline_reasons: ${formatReasons(result.baseline.reasonCodes)}`,
  ];

  if (result.items.length === 0) {
    return [...header, "", "- no matching items"].join("\n");
  }

  if (view === "minimal") {
    return [
      ...header,
      "",
      ...result.items.map(
        (item) => `- ${item.status} ${item.scope}/${item.itemType} ${item.id}: ${item.title} (reasons=${formatReasons(item.reasonCodes)})`,
      ),
    ].join("\n");
  }

  const sections = result.items.flatMap((item) => {
    const lines = [
      `- ${item.status.toUpperCase()} ${item.scope}/${item.itemType}: ${item.title}`,
      `  id: ${item.id}`,
      `  reasons: ${formatReasons(item.reasonCodes)}`,
      `  affected_paths: ${formatPaths(item.affectedPaths)}`,
      `  actions: ${formatActions(item.recommendedActions)}`,
    ];
    if (view === "full") {
      lines.push(
        `  source_refs: head=${shortSha(item.sourceRefs.headSha)}, snapshot=${shortSha(item.sourceRefs.snapshotSha)}, anchor=${shortSha(item.sourceRefs.anchorSha)}`,
      );
      lines.push(
        `  artifact_refs: source=${shortSha(item.sourceRefs.sourceHeadSha)}, bound=${shortSha(item.sourceRefs.boundHeadSha)}, capture=${shortSha(item.sourceRefs.captureHeadSha)}`,
      );
      lines.push(
        `  workflow_refs: goal=${item.sourceRefs.goalId ?? "none"}, episode=${item.sourceRefs.episodeId ?? "none"}, session=${item.sourceRefs.sourceSessionId ?? "none"}`,
      );
    }
    return lines;
  });

  return [...header, "", ...sections].join("\n");
};
