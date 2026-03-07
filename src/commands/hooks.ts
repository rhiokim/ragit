import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getGitRoot } from "../core/git.js";

const header = "# managed-by-ragit";

export interface HookActionResult {
  name: "post-commit" | "post-merge";
  target: string;
  action: "install" | "uninstall" | "status";
  state: "installed" | "absent" | "external" | "planned";
}

export interface HooksMutationResult {
  dryRun: boolean;
  root: string;
  hooks: HookActionResult[];
}

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

export const runHooksInstall = async (cwd: string, dryRun = false): Promise<HooksMutationResult> => {
  const root = await getGitRoot(cwd);
  const hooks: HookActionResult[] = [];
  for (const name of ["post-commit", "post-merge"] as const) {
    const target = hookPath(root, name);
    hooks.push({
      name,
      target: path.relative(cwd, target).replaceAll(path.sep, "/"),
      action: "install",
      state: dryRun ? "planned" : "installed",
    });
    if (dryRun) continue;
    await writeFile(target, hookTemplate(name), "utf8");
    await chmod(target, 0o755);
  }
  return { dryRun, root, hooks };
};

export const runHooksUninstall = async (cwd: string, dryRun = false): Promise<HooksMutationResult> => {
  const root = await getGitRoot(cwd);
  const hooks: HookActionResult[] = [];
  for (const name of ["post-commit", "post-merge"] as const) {
    const target = hookPath(root, name);
    let state: HookActionResult["state"] = "absent";
    try {
      const content = await readFile(target, "utf8");
      state = content.includes(header) ? "installed" : "external";
      if (!content.includes(header)) {
        hooks.push({
          name,
          target: path.relative(cwd, target).replaceAll(path.sep, "/"),
          action: "uninstall",
          state,
        });
        continue;
      }
      hooks.push({
        name,
        target: path.relative(cwd, target).replaceAll(path.sep, "/"),
        action: "uninstall",
        state: dryRun ? "planned" : "absent",
      });
      if (!dryRun) {
        await rm(target, { force: true });
      }
    } catch {
      hooks.push({
        name,
        target: path.relative(cwd, target).replaceAll(path.sep, "/"),
        action: "uninstall",
        state,
      });
    }
  }
  return { dryRun, root, hooks };
};

export const runHooksStatus = async (cwd: string): Promise<HooksMutationResult> => {
  const root = await getGitRoot(cwd);
  const hooks: HookActionResult[] = [];
  for (const name of ["post-commit", "post-merge"] as const) {
    const target = hookPath(root, name);
    let state: HookActionResult["state"] = "absent";
    try {
      const content = await readFile(target, "utf8");
      state = content.includes(header) ? "installed" : "external";
    } catch {
      state = "absent";
    }
    hooks.push({
      name,
      target: path.relative(cwd, target).replaceAll(path.sep, "/"),
      action: "status",
      state,
    });
  }
  return { dryRun: false, root, hooks };
};

