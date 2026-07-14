import { execFile } from "node:child_process";
import { RagitOperationalError } from "./errors.js";

class GitCommandError extends Error {
  readonly exitCode: number | null;

  constructor(message: string, exitCode: number | null, cause: unknown) {
    super(message, { cause });
    this.name = "GitCommandError";
    this.exitCode = exitCode;
  }
}

const execGitRaw = (cwd: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile("git", args, { cwd, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        reject(
          new GitCommandError(
            stderr.trim() || error.message,
            typeof error.code === "number" ? error.code : null,
            error,
          ),
        );
        return;
      }
      resolve(stdout);
    });
  });

const execGit = async (cwd: string, args: string[]): Promise<string> =>
  (await execGitRaw(cwd, args)).trim();

const splitLines = (output: string): string[] =>
  output.split(/\r?\n/).filter(Boolean);

const splitNullDelimited = (output: string): string[] => {
  const values = output.split("\0");
  if (values.at(-1) === "") {
    values.pop();
  }
  return values;
};

const invalidCommitRef = (ref: string): RagitOperationalError =>
  new RagitOperationalError(
    "SNAPSHOT_REF_INVALID",
    `유효한 commit으로 해석할 수 없는 ref입니다: ${ref}`,
    {
      details: { ref },
      recovery: { command: "git rev-parse --verify HEAD" },
    },
  );

export const ensureGitRepository = async (cwd: string): Promise<void> => {
  await execGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
};

export const isGitRepository = async (cwd: string): Promise<boolean> => {
  try {
    await ensureGitRepository(cwd);
    return true;
  } catch {
    return false;
  }
};

export const initGitRepository = async (cwd: string): Promise<void> => {
  await execGit(cwd, ["init"]);
};

export const getGitRoot = async (cwd: string): Promise<string> => execGit(cwd, ["rev-parse", "--show-toplevel"]);

export const tryGetGitRoot = async (cwd: string): Promise<string | null> => {
  try {
    return await getGitRoot(cwd);
  } catch {
    return null;
  }
};

export const getHeadSha = async (cwd: string): Promise<string> => execGit(cwd, ["rev-parse", "HEAD"]);

export const getHeadShaIfExists = async (cwd: string): Promise<string | null> => {
  try {
    return (await execGit(cwd, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])).toLowerCase();
  } catch (error) {
    if (error instanceof GitCommandError && error.exitCode === 1) {
      return null;
    }
    throw error;
  }
};

export const getCurrentBranch = async (cwd: string): Promise<string | null> => {
  try {
    return await execGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  } catch (error) {
    if (error instanceof GitCommandError && error.exitCode === 1) {
      return null;
    }
    throw error;
  }
};

export const resolveCommitSha = async (cwd: string, ref: string): Promise<string> => {
  if (ref === "HEAD") {
    const headSha = await getHeadShaIfExists(cwd);
    if (headSha === null) {
      throw invalidCommitRef(ref);
    }
    return headSha;
  }
  if (!/^[0-9a-fA-F]{4,40}$/.test(ref)) {
    throw invalidCommitRef(ref);
  }

  const normalizedRef = ref.toLowerCase();
  const candidates = splitLines(await execGit(cwd, ["rev-parse", `--disambiguate=${normalizedRef}`]));
  const commitMatches: string[] = [];
  for (const candidate of candidates) {
    if ((await execGit(cwd, ["cat-file", "-t", candidate])) === "commit") {
      commitMatches.push(candidate.toLowerCase());
    }
  }

  if (commitMatches.length === 0) {
    throw invalidCommitRef(ref);
  }
  if (commitMatches.length > 1) {
    throw new RagitOperationalError(
      "SNAPSHOT_REF_AMBIGUOUS",
      `여러 commit과 일치하는 ref입니다: ${ref}`,
      {
        details: { ref, matches: commitMatches },
        recovery: { command: `git rev-parse --disambiguate=${normalizedRef}` },
      },
    );
  }
  return commitMatches[0];
};

export const getParentSha = async (cwd: string): Promise<string | null> => {
  try {
    return await execGit(cwd, ["rev-parse", "HEAD^"]);
  } catch {
    return null;
  }
};

export const getParentShaForCommit = async (cwd: string, sha: string): Promise<string | null> => {
  const [commit, parent] = (await execGit(cwd, ["rev-list", "--parents", "--max-count=1", sha])).split(/\s+/);
  if (!commit) {
    throw new Error(`commit을 찾을 수 없습니다: ${sha}`);
  }
  return parent?.toLowerCase() ?? null;
};

export const isAncestorCommit = async (cwd: string, ancestor: string, descendant: string): Promise<boolean> => {
  try {
    await execGit(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch (error) {
    if (error instanceof GitCommandError && error.exitCode === 1) {
      return false;
    }
    throw error;
  }
};

export const listCommitAncestry = async (cwd: string, sha: string): Promise<string[]> =>
  splitLines(await execGit(cwd, ["rev-list", sha])).map((entry) => entry.toLowerCase());

export const listChangedFilesBetween = async (cwd: string, base: string, target: string): Promise<string[]> => {
  const output = await execGitRaw(cwd, ["diff", "--name-only", "-z", base, target]);
  return splitNullDelimited(output);
};

export const listChangedFilesSince = async (cwd: string, since: string): Promise<string[]> => {
  const output = await execGit(cwd, ["diff", "--name-only", `${since}..HEAD`]);
  if (!output) return [];
  return output.split(/\r?\n/).filter(Boolean);
};

export const currentBranch = async (cwd: string): Promise<string> => execGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);

export interface GitDirtyPath {
  path: string;
  state: "modified" | "deleted" | "untracked";
}

const addDirtyPath = (paths: Map<string, GitDirtyPath["state"]>, dirtyPath: string, state: GitDirtyPath["state"]): void => {
  const priority: Record<GitDirtyPath["state"], number> = {
    untracked: 0,
    modified: 1,
    deleted: 2,
  };
  const current = paths.get(dirtyPath);
  if (current === undefined || priority[state] > priority[current]) {
    paths.set(dirtyPath, state);
  }
};

const collectNameStatusPaths = (output: string, paths: Map<string, GitDirtyPath["state"]>): void => {
  const values = splitNullDelimited(output);
  for (let index = 0; index < values.length; ) {
    const status = values[index];
    index += 1;
    if (!status) {
      throw new Error("git name-status 출력에 상태가 없습니다.");
    }

    if (status.startsWith("R")) {
      const oldPath = values[index];
      const newPath = values[index + 1];
      index += 2;
      if (oldPath === undefined || newPath === undefined) {
        throw new Error("git rename 출력에 경로가 없습니다.");
      }
      addDirtyPath(paths, oldPath, "deleted");
      addDirtyPath(paths, newPath, "modified");
      continue;
    }

    if (status.startsWith("C")) {
      const newPath = values[index + 1];
      index += 2;
      if (newPath === undefined) {
        throw new Error("git copy 출력에 경로가 없습니다.");
      }
      addDirtyPath(paths, newPath, "modified");
      continue;
    }

    const dirtyPath = values[index];
    index += 1;
    if (dirtyPath === undefined) {
      throw new Error("git name-status 출력에 경로가 없습니다.");
    }
    addDirtyPath(paths, dirtyPath, status.startsWith("D") ? "deleted" : "modified");
  }
};

export const listDirtyPathsAgainstHead = async (cwd: string, headSha: string | null): Promise<GitDirtyPath[]> => {
  const paths = new Map<string, GitDirtyPath["state"]>();
  if (headSha === null) {
    for (const trackedPath of splitNullDelimited(await execGitRaw(cwd, ["ls-files", "-z"]))) {
      addDirtyPath(paths, trackedPath, "modified");
    }
  } else {
    collectNameStatusPaths(
      await execGitRaw(cwd, ["diff", "--name-status", "-z", "--find-renames", "HEAD"]),
      paths,
    );
  }

  for (const untrackedPath of splitNullDelimited(
    await execGitRaw(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]),
  )) {
    addDirtyPath(paths, untrackedPath, "untracked");
  }

  return [...paths].map(([dirtyPath, state]) => ({ path: dirtyPath, state }));
};

export interface GitCommitInfo {
  sha: string;
  subject: string;
  authorName: string;
  authoredAt: string;
}

export const listGitCommits = async (
  cwd: string,
  options: {
    revRange?: string;
  } = {},
): Promise<GitCommitInfo[]> => {
  const format = ["--format=%H%x1f%s%x1f%an%x1f%aI%x1e"];
  const args = ["log", ...format];
  if (options.revRange) {
    args.push(options.revRange);
  }
  const output = await execGit(cwd, args);
  if (!output) return [];
  return output
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha, subject, authorName, authoredAt] = record.split("\x1f");
      return {
        sha,
        subject,
        authorName,
        authoredAt,
      };
    });
};
