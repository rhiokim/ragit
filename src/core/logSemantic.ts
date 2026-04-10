import { loadArtifactRecord } from "./artifacts.js";
import {
  ArtifactAuthority,
  ArtifactRecord,
  KnownDocType,
  RagitLogSemanticArtifactSupport,
  RagitLogSemanticCounts,
  RagitLogSemanticEvidence,
  RagitLogSemanticOverlay,
  RagitLogSemanticStatement,
  SnapshotManifest,
} from "./types.js";

export interface DeriveLogSemanticOverlayOptions {
  docType?: KnownDocType | null;
  pathMatcher?: ((candidate: string) => boolean) | null;
  hasPathFilter?: boolean;
  artifactCache?: Map<string, ArtifactRecord | null>;
}

type LoadedArtifactSupport = {
  support: RagitLogSemanticArtifactSupport;
  record: ArtifactRecord | null;
  updatedAt: string | null;
};

const BELIEF_KINDS = new Set(["feedback", "constraint", "insight", "oracle", "checker", "rubric", "envAssumption"]);
const OPEN_LOOP_KINDS = new Set(["openLoop", "failure"]);

const emptyCounts = (): RagitLogSemanticCounts => ({
  beliefs: 0,
  openLoops: 0,
  evidence: 0,
  artifacts: 0,
});

const emptyOverlay = (headline: string, available: boolean): RagitLogSemanticOverlay => ({
  available,
  headline,
  counts: emptyCounts(),
  beliefs: [],
  openLoops: [],
  evidence: [],
  artifacts: [],
});

const normalizeRepoPath = (value: string): string => value.replaceAll("\\", "/");

const authorityRank = (authority: ArtifactAuthority | null | undefined): number => {
  if (authority === "promoted_durable") return 4;
  if (authority === "reviewed_harness") return 3;
  if (authority === "user_asserted") return 2;
  if (authority === "assistant_inferred") return 1;
  return 0;
};

const compareIsoDesc = (left: string | null | undefined, right: string | null | undefined): number => {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  return right.localeCompare(left);
};

const compareStatements = (
  left: RagitLogSemanticStatement,
  leftUpdatedAt: string | null,
  right: RagitLogSemanticStatement,
  rightUpdatedAt: string | null,
): number =>
  authorityRank(right.authority) - authorityRank(left.authority) ||
  compareIsoDesc(leftUpdatedAt, rightUpdatedAt) ||
  left.artifactId.localeCompare(right.artifactId);

const compareSupport = (left: RagitLogSemanticArtifactSupport, right: RagitLogSemanticArtifactSupport): number => {
  const leftStatusRank = left.status === "reviewed" ? 0 : left.status === "captured" ? 1 : 2;
  const rightStatusRank = right.status === "reviewed" ? 0 : right.status === "captured" ? 1 : 2;
  return leftStatusRank - rightStatusRank || left.scope.localeCompare(right.scope) || left.artifactId.localeCompare(right.artifactId);
};

const toStatement = (record: ArtifactRecord): RagitLogSemanticStatement => ({
  artifactId: record.artifactId,
  kind: record.kind,
  scope: record.artifactScope,
  status: record.status,
  title: record.title,
  summary: record.summary,
  authority: record.authority,
  confidence: record.confidence,
  sourceSessionId: record.sourceSessionId,
  goalId: record.goalId,
  episodeId: record.episodeId,
});

const matchesFilters = (
  record: ArtifactRecord | null,
  manifest: SnapshotManifest,
  options: DeriveLogSemanticOverlayOptions,
): boolean => {
  const requiresFilter = Boolean(options.docType) || Boolean(options.hasPathFilter);
  if (!requiresFilter) return true;
  if (!record) return false;
  const relatedPaths = record.relatedPaths.map(normalizeRepoPath);
  if (options.hasPathFilter && options.pathMatcher && !relatedPaths.some((candidate) => options.pathMatcher?.(candidate))) {
    return false;
  }
  if (!options.docType) return true;
  const docTypeByPath = new Map(manifest.docs.map((doc) => [normalizeRepoPath(doc.path), doc.docType]));
  return relatedPaths.some((candidate) => docTypeByPath.get(candidate) === options.docType);
};

const headlineForOverlay = (overlay: RagitLogSemanticOverlay): string => {
  if (!overlay.available) return overlay.headline;
  if (overlay.counts.artifacts === 0) return "No artifact-backed semantic overlays in this snapshot.";
  return `beliefs=${overlay.counts.beliefs} open_loops=${overlay.counts.openLoops} evidence=${overlay.counts.evidence} artifacts=${overlay.counts.artifacts}`;
};

const loadArtifactCached = async (
  cwd: string,
  artifactId: string,
  cache: Map<string, ArtifactRecord | null>,
): Promise<ArtifactRecord | null> => {
  if (!cache.has(artifactId)) {
    cache.set(artifactId, await loadArtifactRecord(cwd, artifactId));
  }
  return cache.get(artifactId) ?? null;
};

export const deriveLogSemanticOverlay = async (
  cwd: string,
  manifest: SnapshotManifest | null,
  options: DeriveLogSemanticOverlayOptions = {},
): Promise<RagitLogSemanticOverlay> => {
  if (!manifest) {
    return emptyOverlay("No semantic overlay available because this commit has no indexed snapshot.", false);
  }
  if (manifest.indexVersion < 3) {
    return emptyOverlay(`Artifact-aware semantic overlay unavailable for snapshot format v${manifest.indexVersion}.`, false);
  }
  const cache = options.artifactCache ?? new Map<string, ArtifactRecord | null>();
  const supports: LoadedArtifactSupport[] = [];
  for (const entry of manifest.artifactEntries ?? []) {
    const record = await loadArtifactCached(cwd, entry.artifactId, cache);
    if (!matchesFilters(record, manifest, options)) continue;
    supports.push({
      support: {
        artifactId: entry.artifactId,
        kind: entry.kind,
        scope: entry.artifactScope,
        status: entry.status,
        tier: entry.tier,
        bindingStatus: entry.bindingStatus,
        searchPolicy: entry.searchPolicy,
        sourceSessionId: entry.sourceSessionId,
        goalId: entry.goalId,
        episodeId: entry.episodeId,
        sourceHeadSha: entry.sourceHeadSha,
        path: entry.path,
        loaded: Boolean(record),
        title: record?.title ?? null,
        summary: record?.summary ?? null,
        authority: record?.authority ?? null,
        confidence: record?.confidence ?? null,
      },
      record,
      updatedAt: record?.updatedAt ?? null,
    });
  }

  const beliefSupports = supports.filter(
    ({ record }) => record && record.status === "reviewed" && BELIEF_KINDS.has(record.kind),
  );
  const openLoopSupports = supports.filter(
    ({ record }) => record && (record.status === "captured" || record.status === "reviewed") && OPEN_LOOP_KINDS.has(record.kind),
  );

  const beliefs = beliefSupports
    .map(({ record }) => toStatement(record!))
    .sort((left, right) => {
      const leftUpdatedAt = beliefSupports.find((item) => item.record?.artifactId === left.artifactId)?.updatedAt ?? null;
      const rightUpdatedAt = beliefSupports.find((item) => item.record?.artifactId === right.artifactId)?.updatedAt ?? null;
      return compareStatements(left, leftUpdatedAt, right, rightUpdatedAt);
    });

  const openLoops = openLoopSupports
    .map(({ record }) => toStatement(record!))
    .sort((left, right) => {
      const leftUpdatedAt = openLoopSupports.find((item) => item.record?.artifactId === left.artifactId)?.updatedAt ?? null;
      const rightUpdatedAt = openLoopSupports.find((item) => item.record?.artifactId === right.artifactId)?.updatedAt ?? null;
      return compareStatements(left, leftUpdatedAt, right, rightUpdatedAt);
    });

  const selectedArtifactIds = new Set([...beliefs, ...openLoops].map((item) => item.artifactId));
  const evidence = supports
    .filter(({ record }) => record && selectedArtifactIds.has(record.artifactId))
    .sort((left, right) => compareSupport(left.support, right.support))
    .flatMap(({ record }) =>
      (record?.evidenceRefs ?? []).map<RagitLogSemanticEvidence>((evidenceRef) => ({
        artifactId: record!.artifactId,
        artifactKind: record!.kind,
        artifactScope: record!.artifactScope,
        artifactStatus: record!.status,
        evidenceId: evidenceRef.evidenceId,
        excerpt: evidenceRef.excerpt,
        authority: record!.authority,
        confidence: record!.confidence,
        sourceSessionId: record!.sourceSessionId,
        goalId: record!.goalId,
        episodeId: record!.episodeId,
      })),
    )
    .sort(
      (left, right) =>
        beliefs.findIndex((item) => item.artifactId === left.artifactId) - beliefs.findIndex((item) => item.artifactId === right.artifactId) ||
        openLoops.findIndex((item) => item.artifactId === left.artifactId) - openLoops.findIndex((item) => item.artifactId === right.artifactId) ||
        left.evidenceId.localeCompare(right.evidenceId),
    );

  const artifacts = supports.map(({ support }) => support).sort(compareSupport);
  const overlay: RagitLogSemanticOverlay = {
    available: true,
    headline: "",
    counts: {
      beliefs: beliefs.length,
      openLoops: openLoops.length,
      evidence: evidence.length,
      artifacts: artifacts.length,
    },
    beliefs,
    openLoops,
    evidence,
    artifacts,
  };
  overlay.headline = headlineForOverlay(overlay);
  return overlay;
};
