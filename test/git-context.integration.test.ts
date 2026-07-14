import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  currentBranch,
  getCurrentBranch,
  getHeadSha,
  getHeadShaIfExists,
  getGitRoot,
  getParentShaForCommit,
  isAncestorCommit,
  listChangedFilesBetween,
  listChangedFilesSince,
  listCommitAncestry,
  listDirtyPathsAgainstHead,
  resolveCommitSha,
} from "../src/core/git.js";

const git = (
  cwd: string,
  args: string[],
  options: { input?: string; env?: NodeJS.ProcessEnv } = {},
): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    input: options.input,
    env: options.env,
  }).trim();

const createRepository = async (): Promise<string> => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "ragit-git-context-"));
  git(cwd, ["init"]);
  git(cwd, ["config", "user.email", "ragit@example.com"]);
  git(cwd, ["config", "user.name", "ragit-test"]);
  return cwd;
};

const commitFile = async (cwd: string, fileName: string, contents: string, message: string): Promise<string> => {
  await writeFile(path.join(cwd, fileName), contents, "utf8");
  git(cwd, ["add", "--", fileName]);
  git(cwd, ["commit", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
};

const findCommitPrefixCollision = (cwd: string): { prefix: string; shas: [string, string] } => {
  const tree = git(cwd, ["write-tree"]);
  const byPrefix = new Map<string, string>();
  const fixedEnv: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "ragit-test",
    GIT_AUTHOR_EMAIL: "ragit@example.com",
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
    GIT_COMMITTER_NAME: "ragit-test",
    GIT_COMMITTER_EMAIL: "ragit@example.com",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
  };

  for (let index = 0; index < 65_537; index += 1) {
    const sha = git(cwd, ["commit-tree", tree, "-m", `collision-${index}`], { env: fixedEnv });
    const prefix = sha.slice(0, 4);
    const previous = byPrefix.get(prefix);
    if (previous) {
      return { prefix, shas: [previous, sha] };
    }
    byPrefix.set(prefix, sha);
  }

  throw new Error("4자리 commit SHA 충돌을 만들지 못했습니다.");
};

const findMissingCommitPrefix = (cwd: string): string => {
  for (let index = 0; index <= 0xffff; index += 1) {
    const prefix = index.toString(16).padStart(4, "0");
    const candidates = git(cwd, ["rev-parse", `--disambiguate=${prefix}`]).split(/\r?\n/).filter(Boolean);
    const hasCommit = candidates.some((candidate) => git(cwd, ["cat-file", "-t", candidate]) === "commit");
    if (!hasCommit) {
      return prefix;
    }
  }
  throw new Error("commit과 일치하지 않는 4자리 SHA prefix를 찾지 못했습니다.");
};

describe("Git repository and commit context", () => {
  it("resolves the worktree root from a nested directory and represents named, detached, and unborn HEADs", async () => {
    const cwd = await createRepository();
    const nested = path.join(cwd, "apps", "docs");
    await mkdir(nested, { recursive: true });
    const headSha = await commitFile(cwd, "README.md", "# fixture\n", "initial");

    expect(await getGitRoot(nested)).toBe(git(cwd, ["rev-parse", "--show-toplevel"]));
    expect(await getHeadShaIfExists(nested)).toBe(headSha);
    expect(await getCurrentBranch(nested)).toBe(git(cwd, ["symbolic-ref", "--short", "HEAD"]));

    git(cwd, ["checkout", "--detach", headSha]);
    expect(await getCurrentBranch(cwd)).toBeNull();
    expect(await currentBranch(cwd)).toBe("HEAD");
    expect(await getHeadSha(cwd)).toBe(headSha);

    const unborn = await createRepository();
    expect(await getHeadShaIfExists(unborn)).toBeNull();
    expect(await getCurrentBranch(unborn)).toBe(git(unborn, ["symbolic-ref", "--short", "HEAD"]));
    await expect(resolveCommitSha(unborn, "HEAD")).rejects.toMatchObject({
      code: "SNAPSHOT_REF_INVALID",
    });
  });

  it("resolves HEAD, full SHA, and a unique hexadecimal prefix to a lowercase full commit SHA", async () => {
    const cwd = await createRepository();
    const headSha = await commitFile(cwd, "one.txt", "one\n", "one");
    await commitFile(cwd, "two.txt", "two\n", "two");

    expect(await resolveCommitSha(cwd, "HEAD")).toBe((await getHeadSha(cwd)).toLowerCase());
    expect(await resolveCommitSha(cwd, headSha.toUpperCase())).toBe(headSha.toLowerCase());
    expect(await resolveCommitSha(cwd, headSha.slice(0, 8).toUpperCase())).toBe(headSha.toLowerCase());
  });

  it("rejects invalid forms, missing objects, blob objects, and ambiguous commit prefixes with typed errors", async () => {
    const cwd = await createRepository();
    await commitFile(cwd, "fixture.txt", "fixture\n", "fixture");
    const blobSha = git(cwd, ["hash-object", "-w", "--stdin"], { input: "blob-only\n" });
    const { prefix, shas } = findCommitPrefixCollision(cwd);
    const missingPrefix = findMissingCommitPrefix(cwd);

    expect(git(cwd, ["cat-file", "-t", shas[0]])).toBe("commit");
    expect(git(cwd, ["cat-file", "-t", shas[1]])).toBe("commit");
    await expect(resolveCommitSha(cwd, "main")).rejects.toMatchObject({ code: "SNAPSHOT_REF_INVALID" });
    await expect(resolveCommitSha(cwd, missingPrefix)).rejects.toMatchObject({ code: "SNAPSHOT_REF_INVALID" });
    await expect(resolveCommitSha(cwd, blobSha)).rejects.toMatchObject({ code: "SNAPSHOT_REF_INVALID" });
    await expect(resolveCommitSha(cwd, prefix)).rejects.toMatchObject({ code: "SNAPSHOT_REF_AMBIGUOUS" });
  });

  it("reports parents, ancestry, and changed paths between exact commits", async () => {
    const cwd = await createRepository();
    const first = await commitFile(cwd, "one.txt", "one\n", "one");
    const second = await commitFile(cwd, "two.txt", "two\n", "two");
    const third = await commitFile(cwd, "three.txt", "three\n", "three");

    expect(await getParentShaForCommit(cwd, first)).toBeNull();
    expect(await getParentShaForCommit(cwd, third)).toBe(second);
    expect(await isAncestorCommit(cwd, first, third)).toBe(true);
    expect(await isAncestorCommit(cwd, third, first)).toBe(false);
    await expect(isAncestorCommit(cwd, "not-a-commit", third)).rejects.toThrow();
    expect(await listCommitAncestry(cwd, third)).toEqual([third, second, first]);
    expect(await listChangedFilesBetween(cwd, first, third)).toEqual(["three.txt", "two.txt"]);
    expect(await listChangedFilesSince(cwd, first)).toEqual(["three.txt", "two.txt"]);
  });

  it("preserves boundary whitespace in paths changed between exact commits", async () => {
    const cwd = await createRepository();
    const base = await commitFile(cwd, "README.md", "base\n", "base");
    const fileName = " edge name.txt ";
    const target = await commitFile(cwd, fileName, "changed\n", "add whitespace path");

    expect(await listChangedFilesBetween(cwd, base, target)).toEqual([fileName]);
  });

  it("reports modified, deleted, renamed, and untracked paths once without trimming valid filename whitespace", async () => {
    const cwd = await createRepository();
    await writeFile(path.join(cwd, "modified.txt"), "initial\n", "utf8");
    await writeFile(path.join(cwd, "deleted.txt"), "delete me\n", "utf8");
    await writeFile(path.join(cwd, "rename-old.txt"), "rename me\n", "utf8");
    await writeFile(path.join(cwd, " edge name.txt "), "initial\n", "utf8");
    git(cwd, ["add", "."]);
    git(cwd, ["commit", "-m", "dirty fixture"]);
    const headSha = git(cwd, ["rev-parse", "HEAD"]);

    await writeFile(path.join(cwd, "modified.txt"), "staged\n", "utf8");
    git(cwd, ["add", "modified.txt"]);
    await writeFile(path.join(cwd, "modified.txt"), "staged and unstaged\n", "utf8");
    await rm(path.join(cwd, "deleted.txt"));
    await rename(path.join(cwd, "rename-old.txt"), path.join(cwd, "rename-new.txt"));
    git(cwd, ["add", "-A", "rename-old.txt", "rename-new.txt"]);
    await writeFile(path.join(cwd, " edge name.txt "), "changed\n", "utf8");
    await writeFile(path.join(cwd, " untracked name.txt "), "untracked\n", "utf8");

    const dirty = await listDirtyPathsAgainstHead(cwd, headSha);

    expect(dirty).toEqual(
      expect.arrayContaining([
        { path: "modified.txt", state: "modified" },
        { path: "deleted.txt", state: "deleted" },
        { path: "rename-old.txt", state: "deleted" },
        { path: "rename-new.txt", state: "modified" },
        { path: " edge name.txt ", state: "modified" },
        { path: " untracked name.txt ", state: "untracked" },
      ]),
    );
    expect(dirty).toHaveLength(6);
    expect(dirty.filter(({ path: dirtyPath }) => dirtyPath === "modified.txt")).toHaveLength(1);
  });

  it("treats every indexed and untracked path as dirty when HEAD is unborn", async () => {
    const cwd = await createRepository();
    await writeFile(path.join(cwd, "indexed.txt"), "indexed\n", "utf8");
    await writeFile(path.join(cwd, "untracked.txt"), "untracked\n", "utf8");
    git(cwd, ["add", "indexed.txt"]);

    expect(await listDirtyPathsAgainstHead(cwd, null)).toEqual([
      { path: "indexed.txt", state: "modified" },
      { path: "untracked.txt", state: "untracked" },
    ]);
  });
});
