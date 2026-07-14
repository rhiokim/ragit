import { isRagitOperationalError, RagitOperationalError } from "./errors.js";
import {
  getCurrentBranch,
  getGitRoot,
  getHeadShaIfExists,
  getParentShaForCommit,
  isAncestorCommit,
  listCommitAncestry,
  listDirtyPathsAgainstHead,
  resolveCommitSha,
} from "./git.js";
import {
  listSnapshotShas,
  loadSnapshotManifest,
  snapshotManifestExists,
} from "./manifest.js";
import type { SnapshotManifest } from "./types.js";

export type SnapshotSelectionMode = "head-exact" | "explicit-exact";
export type SnapshotStatus = "indexed" | "missing" | "invalid" | "store-unavailable" | "unavailable";

export interface RepositoryContext {
  gitRoot: string;
  headSha: string | null;
  branch: string | null;
  detached: boolean;
  worktreeDirty: boolean;
  dirtyPathCount: number;
}

export interface SnapshotMetadata {
  requestedRef: string;
  resolvedSha: string | null;
  selection: SnapshotSelectionMode;
  status: SnapshotStatus;
  branch: string | null;
  detached: boolean;
  worktreeDirty: boolean;
}

export interface SnapshotSelection {
  context: RepositoryContext;
  manifest: SnapshotManifest;
  snapshotSha: string;
  snapshot: SnapshotMetadata;
  warnings: string[];
}

export interface IngestBaseSelection {
  mode: "full" | "since" | "partial-head" | "partial-parent";
  baseSha: string | null;
  manifest: SnapshotManifest | null;
}

export interface SnapshotDependencies {
  resolveRepositoryContext(cwd: string): Promise<RepositoryContext>;
  getHeadShaIfExists(cwd: string): Promise<string | null>;
  resolveCommitSha(cwd: string, ref: string): Promise<string>;
  getParentShaForCommit(cwd: string, sha: string): Promise<string | null>;
  isAncestorCommit(cwd: string, ancestor: string, descendant: string): Promise<boolean>;
  listCommitAncestry(cwd: string, sha: string): Promise<string[]>;
  listSnapshotShas(cwd: string): Promise<string[]>;
  snapshotManifestExists(cwd: string, sha: string): Promise<boolean>;
  loadSnapshotManifest(cwd: string, sha: string): Promise<SnapshotManifest>;
}

export const WORKTREE_DIRTY_SNAPSHOT_WARNING =
  "작업 트리에 커밋되지 않은 변경이 있습니다. 조회 결과에는 해당 변경이 포함되지 않습니다.";

export const resolveRepositoryContext = async (cwd: string): Promise<RepositoryContext> => {
  const gitRoot = await getGitRoot(cwd);
  const [headSha, branch] = await Promise.all([
    getHeadShaIfExists(gitRoot),
    getCurrentBranch(gitRoot),
  ]);
  const dirtyPaths = await listDirtyPathsAgainstHead(gitRoot, headSha);

  return {
    gitRoot,
    headSha,
    branch,
    detached: headSha !== null && branch === null,
    worktreeDirty: dirtyPaths.length > 0,
    dirtyPathCount: dirtyPaths.length,
  };
};

const defaultDependencies: SnapshotDependencies = {
  resolveRepositoryContext,
  getHeadShaIfExists,
  resolveCommitSha,
  getParentShaForCommit,
  isAncestorCommit,
  listCommitAncestry,
  listSnapshotShas,
  snapshotManifestExists,
  loadSnapshotManifest,
};

const missingSnapshotForUnbornHead = (): RagitOperationalError =>
  new RagitOperationalError(
    "SNAPSHOT_NOT_INDEXED",
    "현재 HEAD가 없어 indexed snapshot을 선택할 수 없습니다.",
    {
      details: { resolvedSha: null },
      recovery: { command: "git status" },
    },
  );

const loadExactSnapshot = async (
  cwd: string,
  sha: string,
  dependencies: SnapshotDependencies,
): Promise<SnapshotManifest> => {
  try {
    return await dependencies.loadSnapshotManifest(cwd, sha);
  } catch (error) {
    if (!isRagitOperationalError(error) || error.code !== "SNAPSHOT_NOT_INDEXED") {
      throw error;
    }

    const ancestry = await dependencies.listCommitAncestry(cwd, sha);
    const indexedShas = new Set(await dependencies.listSnapshotShas(cwd));
    const nearestIndexedAncestor = ancestry.find((ancestor) => indexedShas.has(ancestor));

    throw new RagitOperationalError("SNAPSHOT_NOT_INDEXED", error.message, {
      details: {
        ...error.details,
        resolvedSha: sha,
        ...(nearestIndexedAncestor === undefined ? {} : { nearestIndexedAncestor }),
      },
      recovery: {
        command: nearestIndexedAncestor === undefined
          ? "ragit ingest --all"
          : `ragit ingest --since ${nearestIndexedAncestor}`,
      },
      cause: error,
    });
  }
};

const selectedSnapshot = (
  context: RepositoryContext,
  requestedRef: string,
  resolvedSha: string,
  selection: SnapshotSelectionMode,
  selectedManifest: SnapshotManifest,
): SnapshotSelection => ({
  context,
  manifest: selectedManifest,
  snapshotSha: resolvedSha,
  snapshot: {
    requestedRef,
    resolvedSha,
    selection,
    status: "indexed",
    branch: context.branch,
    detached: context.detached,
    worktreeDirty: context.worktreeDirty,
  },
  warnings: context.worktreeDirty ? [WORKTREE_DIRTY_SNAPSHOT_WARNING] : [],
});

export const selectSnapshot = async (
  cwd: string,
  at?: string,
  dependencies: SnapshotDependencies = defaultDependencies,
): Promise<SnapshotSelection> => {
  if (at !== undefined) {
    const context = await dependencies.resolveRepositoryContext(cwd);
    const resolvedSha = await dependencies.resolveCommitSha(context.gitRoot, at);
    const selectedManifest = await loadExactSnapshot(context.gitRoot, resolvedSha, dependencies);
    return selectedSnapshot(context, at, resolvedSha, "explicit-exact", selectedManifest);
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const context = await dependencies.resolveRepositoryContext(cwd);
    const selectedHead = context.headSha;
    let selectedManifest: SnapshotManifest | null = null;
    let selectionError: unknown;

    try {
      if (selectedHead === null) {
        throw missingSnapshotForUnbornHead();
      }
      selectedManifest = await loadExactSnapshot(context.gitRoot, selectedHead, dependencies);
    } catch (error) {
      selectionError = error;
    }

    const finalHead = await dependencies.getHeadShaIfExists(context.gitRoot);
    if (finalHead !== selectedHead) {
      if (attempt === 0) continue;
      throw new RagitOperationalError(
        "REPOSITORY_STATE_CHANGED",
        "snapshot 선택 중 HEAD가 반복해서 변경되었습니다.",
        {
          details: { selectedHead, finalHead, attempts: 2 },
          recovery: { command: "git status" },
        },
      );
    }

    if (selectionError !== undefined) throw selectionError;
    return selectedSnapshot(context, "HEAD", selectedHead!, "head-exact", selectedManifest!);
  }

  throw new Error("snapshot selection retry loop completed unexpectedly");
};

const ingestBaseNotIndexed = (
  details: Record<string, unknown>,
  cause?: unknown,
): RagitOperationalError =>
  new RagitOperationalError(
    "INGEST_BASE_NOT_INDEXED",
    "증분 ingest에 필요한 정확한 base snapshot이 없습니다.",
    {
      details,
      recovery: { command: "ragit ingest --all" },
      cause,
    },
  );

const loadRequiredIngestBase = async (
  cwd: string,
  baseSha: string,
  headSha: string | null,
  dependencies: SnapshotDependencies,
): Promise<SnapshotManifest> => {
  try {
    return await dependencies.loadSnapshotManifest(cwd, baseSha);
  } catch (error) {
    if (isRagitOperationalError(error) && error.code === "SNAPSHOT_NOT_INDEXED") {
      throw ingestBaseNotIndexed({ baseSha, headSha }, error);
    }
    throw error;
  }
};

const loadIngestBaseIfPresent = async (
  cwd: string,
  sha: string,
  dependencies: SnapshotDependencies,
): Promise<SnapshotManifest | null> => {
  if (!(await dependencies.snapshotManifestExists(cwd, sha))) return null;
  try {
    return await dependencies.loadSnapshotManifest(cwd, sha);
  } catch (error) {
    if (isRagitOperationalError(error) && error.code === "SNAPSHOT_NOT_INDEXED") return null;
    throw error;
  }
};

export const selectIngestBase = async (
  _cwd: string,
  request: { fullSnapshot: boolean; since?: string },
  context: RepositoryContext,
  dependencies: SnapshotDependencies = defaultDependencies,
): Promise<IngestBaseSelection> => {
  if (request.fullSnapshot) {
    return { mode: "full", baseSha: null, manifest: null };
  }

  const gitRoot = context.gitRoot;
  if (request.since !== undefined) {
    const baseSha = await dependencies.resolveCommitSha(gitRoot, request.since);
    if (context.headSha === null || !(await dependencies.isAncestorCommit(gitRoot, baseSha, context.headSha))) {
      throw new RagitOperationalError(
        "INGEST_BASE_NOT_ANCESTOR",
        "--since commit은 현재 HEAD의 조상이어야 합니다.",
        {
          details: { baseSha, headSha: context.headSha },
          recovery: { command: "ragit ingest --all" },
        },
      );
    }
    const baseManifest = await loadRequiredIngestBase(
      gitRoot,
      baseSha,
      context.headSha,
      dependencies,
    );
    return { mode: "since", baseSha, manifest: baseManifest };
  }

  if (context.headSha === null) {
    throw ingestBaseNotIndexed({ headSha: null, parentSha: null });
  }

  const headManifest = await loadIngestBaseIfPresent(gitRoot, context.headSha, dependencies);
  if (headManifest !== null) {
    return { mode: "partial-head", baseSha: context.headSha, manifest: headManifest };
  }

  const parentSha = await dependencies.getParentShaForCommit(gitRoot, context.headSha);
  if (parentSha !== null) {
    const parentManifest = await loadIngestBaseIfPresent(gitRoot, parentSha, dependencies);
    if (parentManifest !== null) {
      return { mode: "partial-parent", baseSha: parentSha, manifest: parentManifest };
    }
  }

  throw ingestBaseNotIndexed({ headSha: context.headSha, parentSha });
};

export const snapshotMetadataForUnavailable = (
  context: RepositoryContext,
  requestedRef?: string,
): SnapshotMetadata => ({
  requestedRef: requestedRef ?? "HEAD",
  resolvedSha: requestedRef === undefined ? context.headSha : null,
  selection: requestedRef === undefined ? "head-exact" : "explicit-exact",
  status: "unavailable",
  branch: context.branch,
  detached: context.detached,
  worktreeDirty: context.worktreeDirty,
});
