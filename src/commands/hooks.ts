import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getGitRoot } from "../core/git.js";

const header = "# managed-by-ragit";
const hookTemplate = (hookName: "post-commit" | "post-merge"): string => {
  const sinceExpr = hookName === "post-commit" ? "HEAD~1" : "${ORIG_HEAD:-HEAD~1}";
  return `#!/bin/sh
${header}
if command -v ragit >/dev/null 2>&1; then
  ragit ingest --since ${sinceExpr} >/dev/null 2>&1 || true
elif [ -f "./dist/cli.js" ]; then
  node ./dist/cli.js ingest --since ${sinceExpr} >/dev/null 2>&1 || true
fi
`;
};

const hookPath = (root: string, name: "post-commit" | "post-merge"): string => path.join(root, ".git", "hooks", name);

export const runHooksInstall = async (cwd: string): Promise<void> => {
  const root = await getGitRoot(cwd);
  for (const name of ["post-commit", "post-merge"] as const) {
    const target = hookPath(root, name);
    await writeFile(target, hookTemplate(name), "utf8");
    await chmod(target, 0o755);
  }
  console.log("ragit hooks 설치가 완료되었습니다.");
};

export const runHooksUninstall = async (cwd: string): Promise<void> => {
  const root = await getGitRoot(cwd);
  for (const name of ["post-commit", "post-merge"] as const) {
    const target = hookPath(root, name);
    try {
      const content = await readFile(target, "utf8");
      if (!content.includes(header)) continue;
      await rm(target, { force: true });
    } catch {
      continue;
    }
  }
  console.log("ragit hooks 제거가 완료되었습니다.");
};

export const runHooksStatus = async (cwd: string): Promise<void> => {
  const root = await getGitRoot(cwd);
  const result: Record<string, "installed" | "absent" | "external"> = {};
  for (const name of ["post-commit", "post-merge"] as const) {
    const target = hookPath(root, name);
    try {
      const content = await readFile(target, "utf8");
      result[name] = content.includes(header) ? "installed" : "external";
    } catch {
      result[name] = "absent";
    }
  }
  console.log(JSON.stringify(result, null, 2));
};
