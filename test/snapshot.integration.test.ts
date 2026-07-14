import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSnapshotManifest,
  writeSnapshotManifest,
} from "../src/core/manifest.js";
import {
  resolveRepositoryContext,
  selectSnapshot,
} from "../src/core/snapshot.js";

const cleanupPaths: string[] = [];

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const createTemporaryDirectory = async (prefix: string): Promise<string> => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanupPaths.push(cwd);
  return cwd;
};

const createRepository = async (): Promise<string> => {
  const cwd = await createTemporaryDirectory("ragit-snapshot-");
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.email", "ragit@example.com"]);
  git(cwd, ["config", "user.name", "ragit-test"]);
  return cwd;
};

const commitFile = async (
  cwd: string,
  fileName: string,
  contents: string,
  message: string,
): Promise<string> => {
  const target = path.join(cwd, fileName);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents, "utf8");
  git(cwd, ["add", "--", fileName]);
  git(cwd, ["commit", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]).toLowerCase();
};

const publishManifest = async (
  cwd: string,
  sha: string,
  parentSha: string | null,
): Promise<void> => {
  await writeSnapshotManifest(cwd, buildSnapshotManifest(sha, parentSha, [], []));
};

const findMissingCommitPrefix = (cwd: string): string => {
  for (let index = 0; index <= 0xffff; index += 1) {
    const prefix = index.toString(16).padStart(4, "0");
    const candidates = git(cwd, ["rev-parse", `--disambiguate=${prefix}`])
      .split(/\r?\n/)
      .filter(Boolean);
    const hasCommit = candidates.some((candidate) => {
      try {
        return git(cwd, ["cat-file", "-t", candidate]) === "commit";
      } catch {
        return false;
      }
    });
    if (!hasCommit) return prefix;
  }
  throw new Error("commit과 일치하지 않는 4자리 SHA prefix를 찾지 못했습니다.");
};

afterEach(async () => {
  for (const target of cleanupPaths.splice(0).reverse()) {
    await rm(target, { recursive: true, force: true });
  }
});

describe("snapshot selection with real Git repositories", () => {
  it("resolves nested cwd and represents named, dirty, detached, and unborn repository contexts", async () => {
    const unbornRepository = await createRepository();
    const unborn = await resolveRepositoryContext(unbornRepository);
    const unbornRoot = git(unbornRepository, ["rev-parse", "--show-toplevel"]);

    expect(unborn).toMatchObject({
      gitRoot: unbornRoot,
      headSha: null,
      branch: "main",
      detached: false,
      worktreeDirty: false,
      dirtyPathCount: 0,
    });
    await expect(selectSnapshot(unbornRepository)).rejects.toMatchObject({
      code: "SNAPSHOT_NOT_INDEXED",
      details: { resolvedSha: null },
    });

    const repository = await createRepository();
    const repositoryRoot = git(repository, ["rev-parse", "--show-toplevel"]);
    const headSha = await commitFile(repository, "README.md", "base\n", "base");
    const nested = path.join(repository, "packages", "docs");
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(repository, "dirty.txt"), "dirty\n", "utf8");

    expect(await resolveRepositoryContext(nested)).toMatchObject({
      gitRoot: repositoryRoot,
      headSha,
      branch: "main",
      detached: false,
      worktreeDirty: true,
      dirtyPathCount: 1,
    });

    git(repository, ["checkout", "--detach", headSha]);
    expect(await resolveRepositoryContext(nested)).toMatchObject({
      gitRoot: repositoryRoot,
      headSha,
      branch: null,
      detached: true,
      worktreeDirty: true,
    });
  });

  it("selects exact HEAD, full SHA, and a unique prefix while rejecting a nonexistent prefix", async () => {
    const repository = await createRepository();
    const repositoryRoot = git(repository, ["rev-parse", "--show-toplevel"]);
    const firstSha = await commitFile(repository, "one.md", "one\n", "one");
    const headSha = await commitFile(repository, "two.md", "two\n", "two");
    await publishManifest(repository, firstSha, null);
    await publishManifest(repository, headSha, firstSha);
    const nested = path.join(repository, "apps", "docs");
    await mkdir(nested, { recursive: true });

    await expect(selectSnapshot(nested)).resolves.toMatchObject({
      snapshotSha: headSha,
      snapshot: {
        requestedRef: "HEAD",
        resolvedSha: headSha,
        selection: "head-exact",
      },
      context: { gitRoot: repositoryRoot },
    });
    await expect(selectSnapshot(repository, firstSha)).resolves.toMatchObject({
      snapshotSha: firstSha,
      snapshot: { selection: "explicit-exact" },
    });
    await expect(selectSnapshot(repository, firstSha.slice(0, 8))).resolves.toMatchObject({
      snapshotSha: firstSha,
      snapshot: {
        requestedRef: firstSha.slice(0, 8),
        selection: "explicit-exact",
      },
    });
    await expect(selectSnapshot(repository, findMissingCommitPrefix(repository))).rejects.toMatchObject({
      code: "SNAPSHOT_REF_INVALID",
      exitCode: 2,
    });
  });

  it("does not select a manifest from a divergent branch and reports only the nearest indexed ancestor", async () => {
    const repository = await createRepository();
    const baseSha = await commitFile(repository, "base.md", "base\n", "base");
    await publishManifest(repository, baseSha, null);

    git(repository, ["checkout", "-b", "feature"]);
    const featureSha = await commitFile(repository, "feature.md", "feature\n", "feature");

    git(repository, ["checkout", "main"]);
    const mainSha = await commitFile(repository, "main.md", "main\n", "main");
    await publishManifest(repository, mainSha, baseSha);

    git(repository, ["checkout", "feature"]);
    await expect(selectSnapshot(repository)).rejects.toMatchObject({
      code: "SNAPSHOT_NOT_INDEXED",
      details: { resolvedSha: featureSha, nearestIndexedAncestor: baseSha },
      recovery: { command: `ragit ingest --since ${baseSha}` },
    });

    await expect(selectSnapshot(repository, mainSha)).resolves.toMatchObject({
      snapshotSha: mainSha,
      snapshot: { selection: "explicit-exact" },
    });
  });

  it("keeps .ragit manifests local to each linked worktree", async () => {
    const repository = await createRepository();
    const headSha = await commitFile(repository, "README.md", "base\n", "base");
    await publishManifest(repository, headSha, null);

    const linkedParent = await createTemporaryDirectory("ragit-linked-parent-");
    const linkedWorktree = path.join(linkedParent, "linked");
    git(repository, ["worktree", "add", "-b", "linked", linkedWorktree]);

    await expect(selectSnapshot(repository)).resolves.toMatchObject({ snapshotSha: headSha });
    await expect(selectSnapshot(linkedWorktree)).rejects.toMatchObject({
      code: "SNAPSHOT_NOT_INDEXED",
      details: { resolvedSha: headSha },
    });

    await publishManifest(linkedWorktree, headSha, null);
    const linkedRoot = git(linkedWorktree, ["rev-parse", "--show-toplevel"]);
    await expect(selectSnapshot(linkedWorktree)).resolves.toMatchObject({
      snapshotSha: headSha,
      context: { gitRoot: linkedRoot, branch: "linked" },
    });
  });

  it("ignores a temporary manifest until its final atomic rename", async () => {
    const repository = await createRepository();
    const headSha = await commitFile(repository, "README.md", "base\n", "base");
    const directory = path.join(repository, ".ragit", "manifest");
    await mkdir(directory, { recursive: true });
    const finalPath = path.join(directory, `${headSha}.json`);
    const temporaryPath = `${finalPath}.${process.pid}.manual.tmp`;
    const manifest = buildSnapshotManifest(headSha, null, [], []);
    await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    await expect(selectSnapshot(repository)).rejects.toMatchObject({
      code: "SNAPSHOT_NOT_INDEXED",
      details: { resolvedSha: headSha },
    });

    await rename(temporaryPath, finalPath);
    await expect(selectSnapshot(repository)).resolves.toMatchObject({
      snapshotSha: headSha,
      manifest: { commitSha: headSha },
    });
  });
});
