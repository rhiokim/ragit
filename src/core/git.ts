import { execFile } from "node:child_process";

const execGit = (cwd: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile("git", args, { cwd }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolve(stdout.trim());
    });
  });

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

export const getParentSha = async (cwd: string): Promise<string | null> => {
  try {
    return await execGit(cwd, ["rev-parse", "HEAD^"]);
  } catch {
    return null;
  }
};

export const listChangedFilesSince = async (cwd: string, since: string): Promise<string[]> => {
  const output = await execGit(cwd, ["diff", "--name-only", `${since}..HEAD`]);
  if (!output) return [];
  return output.split(/\r?\n/).filter(Boolean);
};

export const currentBranch = async (cwd: string): Promise<string> => execGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
