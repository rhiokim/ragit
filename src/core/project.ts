import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { CONFIG_PATH, RAGIT_DIR, defaultConfig, stringifyToml } from "./config.js";
import { RagitConfig } from "./types.js";

export interface RagitPaths {
  root: string;
  ragitDir: string;
  configPath: string;
  manifestDir: string;
  memoryDir: string;
  memorySessionsDir: string;
  memoryWorkingDir: string;
  storeDir: string;
  storeMetaPath: string;
  documentsCollectionDir: string;
  chunksCollectionDir: string;
  cacheDir: string;
  hooksDir: string;
}

export const resolveRagitPaths = (cwd: string): RagitPaths => ({
  root: cwd,
  ragitDir: path.join(cwd, RAGIT_DIR),
  configPath: path.join(cwd, CONFIG_PATH),
  manifestDir: path.join(cwd, ".ragit", "manifest"),
  memoryDir: path.join(cwd, ".ragit", "memory"),
  memorySessionsDir: path.join(cwd, ".ragit", "memory", "sessions"),
  memoryWorkingDir: path.join(cwd, ".ragit", "memory", "working"),
  storeDir: path.join(cwd, ".ragit", "store"),
  storeMetaPath: path.join(cwd, ".ragit", "store", "meta.json"),
  documentsCollectionDir: path.join(cwd, ".ragit", "store", "documents"),
  chunksCollectionDir: path.join(cwd, ".ragit", "store", "chunks"),
  cacheDir: path.join(cwd, ".ragit", "cache"),
  hooksDir: path.join(cwd, ".ragit", "hooks"),
});

export const ensureRagitDirectories = async (cwd: string): Promise<RagitPaths> => {
  const paths = resolveRagitPaths(cwd);
  await mkdir(paths.ragitDir, { recursive: true });
  await mkdir(paths.manifestDir, { recursive: true });
  await mkdir(paths.memoryDir, { recursive: true });
  await mkdir(paths.memorySessionsDir, { recursive: true });
  await mkdir(paths.memoryWorkingDir, { recursive: true });
  await mkdir(paths.storeDir, { recursive: true });
  await mkdir(paths.cacheDir, { recursive: true });
  await mkdir(paths.hooksDir, { recursive: true });
  return paths;
};

export const ensureConfigFile = async (cwd: string, config: RagitConfig = defaultConfig()): Promise<string> => {
  const paths = resolveRagitPaths(cwd);
  try {
    await access(paths.configPath, constants.F_OK);
  } catch {
    await writeFile(paths.configPath, stringifyToml(config), "utf8");
  }
  return paths.configPath;
};

export const writeRagitConfig = async (cwd: string, config: RagitConfig): Promise<string> => {
  const paths = resolveRagitPaths(cwd);
  await writeFile(paths.configPath, stringifyToml(config), "utf8");
  return paths.configPath;
};

export const ensureRagitStructure = async (cwd: string, config: RagitConfig = defaultConfig()): Promise<RagitPaths> => {
  const paths = await ensureRagitDirectories(cwd);
  await ensureConfigFile(cwd, config);
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
  const existingLines = new Set(content.split(/\r?\n/));
  const missingEntries = gitIgnoreEntries.filter((entry) => !existingLines.has(entry));
  if (missingEntries.length === 0) return;

  const prefix = content.length === 0 ? "" : content.endsWith("\n") ? "" : "\n";
  const appended = `${missingEntries.join("\n")}\n`;
  await writeFile(gitIgnorePath, `${content}${prefix}${appended}`, "utf8");
};
