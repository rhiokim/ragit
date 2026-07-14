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
  const baseRef = hookName === "post-commit" ? "HEAD^" : "ORIG_HEAD";
  return `#!/bin/sh
${header}
base_ref='${baseRef}'
base_sha="$(git rev-parse --verify "\${base_ref}^{commit}" 2>/dev/null)" || exit 0
if command -v ragit >/dev/null 2>&1; then
  if ! ragit ingest --since "$base_sha" >/dev/null 2>&1; then
    echo "[ragit] incremental ingest failed; run 'ragit ingest --all' to recover." >&2
  fi
elif [ -f "./dist/cli.js" ]; then
  if ! node ./dist/cli.js ingest --since "$base_sha" >/dev/null 2>&1; then
    echo "[ragit] incremental ingest failed; run 'ragit ingest --all' to recover." >&2
  fi
fi
exit 0
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
