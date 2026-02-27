import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { CONFIG_PATH, RAGIT_DIR, defaultConfig, stringifyToml } from "./config.js";

export interface RagitPaths {
  root: string;
  ragitDir: string;
  configPath: string;
  manifestDir: string;
  storeDir: string;
  cacheDir: string;
  hooksDir: string;
}

export const resolveRagitPaths = (cwd: string): RagitPaths => ({
  root: cwd,
  ragitDir: path.join(cwd, RAGIT_DIR),
  configPath: path.join(cwd, CONFIG_PATH),
  manifestDir: path.join(cwd, ".ragit", "manifest"),
  storeDir: path.join(cwd, ".ragit", "store"),
  cacheDir: path.join(cwd, ".ragit", "cache"),
  hooksDir: path.join(cwd, ".ragit", "hooks"),
});

export const ensureRagitStructure = async (cwd: string): Promise<RagitPaths> => {
  const paths = resolveRagitPaths(cwd);
  await mkdir(paths.ragitDir, { recursive: true });
  await mkdir(paths.manifestDir, { recursive: true });
  await mkdir(paths.storeDir, { recursive: true });
  await mkdir(paths.cacheDir, { recursive: true });
  await mkdir(paths.hooksDir, { recursive: true });
  try {
    await access(paths.configPath, constants.F_OK);
  } catch {
    await writeFile(paths.configPath, stringifyToml(defaultConfig()), "utf8");
  }
  return paths;
};

const gitIgnoreEntries = [".ragit/store/", ".ragit/cache/"];

export const ensureGitIgnoreEntries = async (cwd: string): Promise<void> => {
  const gitIgnorePath = path.join(cwd, ".gitignore");
  let content = "";
  try {
    content = await readFile(gitIgnorePath, "utf8");
  } catch {
    content = "";
  }
  let updated = content.trimEnd();
  for (const entry of gitIgnoreEntries) {
    if (!content.includes(entry)) {
      updated += `\n${entry}`;
    }
  }
  if (updated.length > 0) {
    updated += "\n";
  }
  await writeFile(gitIgnorePath, updated, "utf8");
};
