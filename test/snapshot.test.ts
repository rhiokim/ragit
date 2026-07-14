import { describe, expect, it, vi } from "vitest";
import { RagitOperationalError } from "../src/core/errors.js";
import { buildSnapshotManifest } from "../src/core/manifest.js";
import {
  selectIngestBase,
  selectSnapshot,
  snapshotMetadataForUnavailable,
  WORKTREE_DIRTY_SNAPSHOT_WARNING,
  type RepositoryContext,
  type SnapshotDependencies,
} from "../src/core/snapshot.js";

const HEAD_SHA = "a".repeat(40);
const NEXT_SHA = "b".repeat(40);
const PARENT_SHA = "c".repeat(40);
const OTHER_SHA = "d".repeat(40);

const context = (overrides: Partial<RepositoryContext> = {}): RepositoryContext => ({
  gitRoot: "/repo",
  headSha: HEAD_SHA,
  branch: "main",
  detached: false,
  worktreeDirty: false,
  dirtyPathCount: 0,
  ...overrides,
});

const manifest = (sha = HEAD_SHA, parentSha: string | null = PARENT_SHA) =>
  buildSnapshotManifest(sha, parentSha, [], []);

const operationalError = (
  code: "SNAPSHOT_NOT_INDEXED" | "SNAPSHOT_MANIFEST_INVALID" | "SNAPSHOT_SCHEMA_UNSUPPORTED",
  sha: string,
): RagitOperationalError =>
  new RagitOperationalError(code, `${code}: ${sha}`, {
    details: { resolvedSha: sha, manifestPath: `/repo/.ragit/manifest/${sha}.json` },
    recovery: { command: "ragit ingest --all" },
  });

const makeDependencies = (
  overrides: Partial<SnapshotDependencies> = {},
): SnapshotDependencies => ({
  resolveRepositoryContext: vi.fn(async () => context()),
  getHeadShaIfExists: vi.fn(async () => HEAD_SHA),
  resolveCommitSha: vi.fn(async (_cwd, ref) => ref),
  getParentShaForCommit: vi.fn(async () => PARENT_SHA),
  isAncestorCommit: vi.fn(async () => true),
  listCommitAncestry: vi.fn(async (cwd, sha) => [sha]),
  listSnapshotShas: vi.fn(async () => []),
  snapshotManifestExists: vi.fn(async () => false),
  loadSnapshotManifest: vi.fn(async (_cwd, sha) => manifest(sha)),
  ...overrides,
});

describe("snapshot selection policy", () => {
  it("selects only the exact stable HEAD manifest and reports dirty worktree context", async () => {
    const dirtyContext = context({
      worktreeDirty: true,
      dirtyPathCount: 2,
    });
    const headManifest = manifest();
    const dependencies = makeDependencies({
      resolveRepositoryContext: vi.fn(async () => dirtyContext),
      loadSnapshotManifest: vi.fn(async () => headManifest),
    });

    await expect(selectSnapshot("/repo/nested", undefined, dependencies)).resolves.toEqual({
      context: dirtyContext,
      manifest: headManifest,
      snapshotSha: HEAD_SHA,
      snapshot: {
        requestedRef: "HEAD",
        resolvedSha: HEAD_SHA,
        selection: "head-exact",
        status: "indexed",
        branch: "main",
        detached: false,
        worktreeDirty: true,
      },
      warnings: [WORKTREE_DIRTY_SNAPSHOT_WARNING],
    });
    expect(dependencies.loadSnapshotManifest).toHaveBeenCalledWith("/repo", HEAD_SHA);
    expect(dependencies.getHeadShaIfExists).toHaveBeenCalledOnce();
  });

  it("delegates explicit full SHA and unique-prefix resolution and never rereads HEAD", async () => {
    const dependencies = makeDependencies({
      resolveCommitSha: vi.fn(async (_cwd, ref) => {
        expect([HEAD_SHA, HEAD_SHA.slice(0, 8)]).toContain(ref);
        return HEAD_SHA;
      }),
      getHeadShaIfExists: vi.fn(async () => NEXT_SHA),
    });

    const full = await selectSnapshot("/repo", HEAD_SHA, dependencies);
    const prefix = await selectSnapshot("/repo", HEAD_SHA.slice(0, 8), dependencies);

    expect(full.snapshot.selection).toBe("explicit-exact");
    expect(full.snapshot.requestedRef).toBe(HEAD_SHA);
    expect(prefix.snapshot.selection).toBe("explicit-exact");
    expect(prefix.snapshot.requestedRef).toBe(HEAD_SHA.slice(0, 8));
    expect(dependencies.resolveCommitSha).toHaveBeenNthCalledWith(1, "/repo", HEAD_SHA);
    expect(dependencies.resolveCommitSha).toHaveBeenNthCalledWith(2, "/repo", HEAD_SHA.slice(0, 8));
    expect(dependencies.getHeadShaIfExists).not.toHaveBeenCalled();
  });

  it("treats an explicitly supplied HEAD as explicit and ignores subsequent movement", async () => {
    const dependencies = makeDependencies({
      resolveCommitSha: vi.fn(async () => HEAD_SHA),
      getHeadShaIfExists: vi.fn(async () => NEXT_SHA),
    });

    const selected = await selectSnapshot("/repo", "HEAD", dependencies);

    expect(selected.snapshot).toMatchObject({
      requestedRef: "HEAD",
      resolvedSha: HEAD_SHA,
      selection: "explicit-exact",
    });
    expect(dependencies.getHeadShaIfExists).not.toHaveBeenCalled();
  });

  it("reports the nearest indexed ancestor as a recovery hint without selecting it", async () => {
    const dependencies = makeDependencies({
      loadSnapshotManifest: vi.fn(async (_cwd, sha) => {
        throw operationalError("SNAPSHOT_NOT_INDEXED", sha);
      }),
      listCommitAncestry: vi.fn(async () => [HEAD_SHA, PARENT_SHA, OTHER_SHA]),
      listSnapshotShas: vi.fn(async () => [OTHER_SHA, PARENT_SHA]),
    });

    await expect(selectSnapshot("/repo", undefined, dependencies)).rejects.toMatchObject({
      code: "SNAPSHOT_NOT_INDEXED",
      details: {
        resolvedSha: HEAD_SHA,
        nearestIndexedAncestor: PARENT_SHA,
      },
      recovery: { command: `ragit ingest --since ${PARENT_SHA}` },
    });
    expect(dependencies.loadSnapshotManifest).toHaveBeenCalledTimes(1);
    expect(dependencies.loadSnapshotManifest).not.toHaveBeenCalledWith("/repo", PARENT_SHA);
  });

  it("recommends a full ingest when no indexed ancestor exists", async () => {
    const dependencies = makeDependencies({
      loadSnapshotManifest: vi.fn(async (_cwd, sha) => {
        throw operationalError("SNAPSHOT_NOT_INDEXED", sha);
      }),
      listCommitAncestry: vi.fn(async () => [HEAD_SHA, PARENT_SHA]),
      listSnapshotShas: vi.fn(async () => [OTHER_SHA]),
    });

    const failure = selectSnapshot("/repo", undefined, dependencies);
    await expect(failure).rejects.toMatchObject({
      code: "SNAPSHOT_NOT_INDEXED",
      details: { resolvedSha: HEAD_SHA },
      recovery: { command: "ragit ingest --all" },
    });
    await expect(failure).rejects.not.toMatchObject({
      details: { nearestIndexedAncestor: expect.anything() },
    });
  });

  it.each(["SNAPSHOT_MANIFEST_INVALID", "SNAPSHOT_SCHEMA_UNSUPPORTED"] as const)(
    "rereads HEAD and preserves %s when repository state is stable",
    async (code) => {
      const failure = operationalError(code, HEAD_SHA);
      const dependencies = makeDependencies({
        loadSnapshotManifest: vi.fn(async () => {
          throw failure;
        }),
      });

      await expect(selectSnapshot("/repo", undefined, dependencies)).rejects.toBe(failure);
      expect(dependencies.getHeadShaIfExists).toHaveBeenCalledWith("/repo");
    },
  );

  it("discards a failed first attempt and succeeds after one HEAD movement", async () => {
    const contexts = [context(), context({ headSha: NEXT_SHA })];
    const rereads = [NEXT_SHA, NEXT_SHA];
    const dependencies = makeDependencies({
      resolveRepositoryContext: vi.fn(async () => contexts.shift()!),
      getHeadShaIfExists: vi.fn(async () => rereads.shift()!),
      loadSnapshotManifest: vi.fn(async (_cwd, sha) => {
        if (sha === HEAD_SHA) throw operationalError("SNAPSHOT_NOT_INDEXED", sha);
        return manifest(sha, HEAD_SHA);
      }),
    });

    const selected = await selectSnapshot("/repo", undefined, dependencies);

    expect(selected.snapshotSha).toBe(NEXT_SHA);
    expect(dependencies.resolveRepositoryContext).toHaveBeenCalledTimes(2);
    expect(dependencies.loadSnapshotManifest).toHaveBeenNthCalledWith(1, "/repo", HEAD_SHA);
    expect(dependencies.loadSnapshotManifest).toHaveBeenNthCalledWith(2, "/repo", NEXT_SHA);
  });

  it("throws a retryable typed error after HEAD moves on both attempts", async () => {
    const contexts = [context(), context({ headSha: NEXT_SHA })];
    const rereads = [NEXT_SHA, OTHER_SHA];
    const dependencies = makeDependencies({
      resolveRepositoryContext: vi.fn(async () => contexts.shift()!),
      getHeadShaIfExists: vi.fn(async () => rereads.shift()!),
    });

    await expect(selectSnapshot("/repo", undefined, dependencies)).rejects.toMatchObject({
      code: "REPOSITORY_STATE_CHANGED",
      exitCode: 3,
      retryable: true,
    });
    expect(dependencies.resolveRepositoryContext).toHaveBeenCalledTimes(2);
    expect(dependencies.getHeadShaIfExists).toHaveBeenCalledTimes(2);
  });

  it("returns a typed missing-snapshot failure for a stable unborn HEAD", async () => {
    const unborn = context({
      headSha: null,
      branch: "main",
      detached: false,
    });
    const dependencies = makeDependencies({
      resolveRepositoryContext: vi.fn(async () => unborn),
      getHeadShaIfExists: vi.fn(async () => null),
    });

    await expect(selectSnapshot("/repo", undefined, dependencies)).rejects.toMatchObject({
      code: "SNAPSHOT_NOT_INDEXED",
      exitCode: 3,
      details: { resolvedSha: null },
    });
    expect(dependencies.loadSnapshotManifest).not.toHaveBeenCalled();
  });

  it("builds unavailable metadata without claiming snapshot backing", () => {
    const detached = context({ branch: null, detached: true, worktreeDirty: true });

    expect(snapshotMetadataForUnavailable(detached)).toEqual({
      requestedRef: "HEAD",
      resolvedSha: HEAD_SHA,
      selection: "head-exact",
      status: "unavailable",
      branch: null,
      detached: true,
      worktreeDirty: true,
    });
    expect(snapshotMetadataForUnavailable(detached, HEAD_SHA.slice(0, 8))).toMatchObject({
      requestedRef: HEAD_SHA.slice(0, 8),
      resolvedSha: null,
      selection: "explicit-exact",
      status: "unavailable",
    });
  });
});

describe("ingest base policy", () => {
  it("returns no base for full mode without consulting Git or manifests", async () => {
    const dependencies = makeDependencies();

    await expect(
      selectIngestBase("/repo", { fullSnapshot: true }, context(), dependencies),
    ).resolves.toEqual({
      mode: "full",
      baseSha: null,
      manifest: null,
    });
    expect(dependencies.resolveCommitSha).not.toHaveBeenCalled();
    expect(dependencies.snapshotManifestExists).not.toHaveBeenCalled();
    expect(dependencies.loadSnapshotManifest).not.toHaveBeenCalled();
  });

  it("uses an exact resolved --since manifest after proving ancestry", async () => {
    const baseManifest = manifest(PARENT_SHA, null);
    const dependencies = makeDependencies({
      resolveCommitSha: vi.fn(async () => PARENT_SHA),
      loadSnapshotManifest: vi.fn(async () => baseManifest),
    });

    await expect(
      selectIngestBase(
        "/repo/nested",
        { fullSnapshot: false, since: PARENT_SHA.slice(0, 8) },
        context(),
        dependencies,
      ),
    ).resolves.toEqual({
      mode: "since",
      baseSha: PARENT_SHA,
      manifest: baseManifest,
    });
    expect(dependencies.resolveCommitSha).toHaveBeenCalledWith("/repo", PARENT_SHA.slice(0, 8));
    expect(dependencies.isAncestorCommit).toHaveBeenCalledWith("/repo", PARENT_SHA, HEAD_SHA);
    expect(dependencies.loadSnapshotManifest).toHaveBeenCalledWith("/repo", PARENT_SHA);
  });

  it("rejects a non-ancestor --since commit before loading a manifest", async () => {
    const dependencies = makeDependencies({
      resolveCommitSha: vi.fn(async () => OTHER_SHA),
      isAncestorCommit: vi.fn(async () => false),
    });

    await expect(
      selectIngestBase(
        "/repo",
        { fullSnapshot: false, since: OTHER_SHA },
        context(),
        dependencies,
      ),
    ).rejects.toMatchObject({
      code: "INGEST_BASE_NOT_ANCESTOR",
      exitCode: 2,
      details: { baseSha: OTHER_SHA, headSha: HEAD_SHA },
    });
    expect(dependencies.loadSnapshotManifest).not.toHaveBeenCalled();
  });

  it("maps only a missing exact --since base to INGEST_BASE_NOT_INDEXED", async () => {
    const dependencies = makeDependencies({
      resolveCommitSha: vi.fn(async () => PARENT_SHA),
      loadSnapshotManifest: vi.fn(async () => {
        throw operationalError("SNAPSHOT_NOT_INDEXED", PARENT_SHA);
      }),
    });

    await expect(
      selectIngestBase(
        "/repo",
        { fullSnapshot: false, since: PARENT_SHA },
        context(),
        dependencies,
      ),
    ).rejects.toMatchObject({
      code: "INGEST_BASE_NOT_INDEXED",
      exitCode: 3,
      details: { baseSha: PARENT_SHA, headSha: HEAD_SHA },
      recovery: { command: "ragit ingest --all" },
    });
  });

  it.each(["SNAPSHOT_MANIFEST_INVALID", "SNAPSHOT_SCHEMA_UNSUPPORTED"] as const)(
    "preserves %s for an exact --since base",
    async (code) => {
      const failure = operationalError(code, PARENT_SHA);
      const dependencies = makeDependencies({
        resolveCommitSha: vi.fn(async () => PARENT_SHA),
        loadSnapshotManifest: vi.fn(async () => {
          throw failure;
        }),
      });

      await expect(
        selectIngestBase(
          "/repo",
          { fullSnapshot: false, since: PARENT_SHA },
          context(),
          dependencies,
        ),
      ).rejects.toBe(failure);
    },
  );

  it("prefers the exact current-HEAD manifest for partial ingest", async () => {
    const headManifest = manifest();
    const dependencies = makeDependencies({
      snapshotManifestExists: vi.fn(async (_cwd, sha) => sha === HEAD_SHA),
      loadSnapshotManifest: vi.fn(async () => headManifest),
    });

    await expect(
      selectIngestBase("/repo", { fullSnapshot: false }, context(), dependencies),
    ).resolves.toEqual({
      mode: "partial-head",
      baseSha: HEAD_SHA,
      manifest: headManifest,
    });
    expect(dependencies.getParentShaForCommit).not.toHaveBeenCalled();
  });

  it("uses only the exact parent manifest when current HEAD is not indexed", async () => {
    const parentManifest = manifest(PARENT_SHA, null);
    const dependencies = makeDependencies({
      snapshotManifestExists: vi.fn(async (_cwd, sha) => sha === PARENT_SHA),
      loadSnapshotManifest: vi.fn(async (_cwd, sha) => {
        expect(sha).toBe(PARENT_SHA);
        return parentManifest;
      }),
    });

    await expect(
      selectIngestBase("/repo", { fullSnapshot: false }, context(), dependencies),
    ).resolves.toEqual({
      mode: "partial-parent",
      baseSha: PARENT_SHA,
      manifest: parentManifest,
    });
    expect(dependencies.snapshotManifestExists).toHaveBeenNthCalledWith(1, "/repo", HEAD_SHA);
    expect(dependencies.snapshotManifestExists).toHaveBeenNthCalledWith(2, "/repo", PARENT_SHA);
  });

  it("rejects partial ingest when neither exact HEAD nor exact parent is indexed", async () => {
    const dependencies = makeDependencies();

    await expect(
      selectIngestBase("/repo", { fullSnapshot: false }, context(), dependencies),
    ).rejects.toMatchObject({
      code: "INGEST_BASE_NOT_INDEXED",
      exitCode: 3,
      details: { headSha: HEAD_SHA, parentSha: PARENT_SHA },
      recovery: { command: "ragit ingest --all" },
    });
    expect(dependencies.loadSnapshotManifest).not.toHaveBeenCalled();
  });

  it.each(["SNAPSHOT_MANIFEST_INVALID", "SNAPSHOT_SCHEMA_UNSUPPORTED"] as const)(
    "preserves %s for an exact partial HEAD base",
    async (code) => {
      const failure = operationalError(code, HEAD_SHA);
      const dependencies = makeDependencies({
        snapshotManifestExists: vi.fn(async (_cwd, sha) => sha === HEAD_SHA),
        loadSnapshotManifest: vi.fn(async () => {
          throw failure;
        }),
      });

      await expect(
        selectIngestBase("/repo", { fullSnapshot: false }, context(), dependencies),
      ).rejects.toBe(failure);
      expect(dependencies.getParentShaForCommit).not.toHaveBeenCalled();
    },
  );

  it.each(["SNAPSHOT_MANIFEST_INVALID", "SNAPSHOT_SCHEMA_UNSUPPORTED"] as const)(
    "preserves %s for an exact partial parent base",
    async (code) => {
      const failure = operationalError(code, PARENT_SHA);
      const dependencies = makeDependencies({
        snapshotManifestExists: vi.fn(async (_cwd, sha) => sha === PARENT_SHA),
        loadSnapshotManifest: vi.fn(async () => {
          throw failure;
        }),
      });

      await expect(
        selectIngestBase("/repo", { fullSnapshot: false }, context(), dependencies),
      ).rejects.toBe(failure);
    },
  );
});
