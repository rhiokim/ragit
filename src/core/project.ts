import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { CONFIG_PATH, RAGIT_DIR, defaultConfig, stringifyToml } from "./config.js";
import { buildRagitGitIgnorePlan, RagitGitIgnorePolicy } from "./gitignore-policy.js";
import { RagitConfig } from "./types.js";

const DEFAULT_GITIGNORE_PLAN = buildRagitGitIgnorePlan();

export interface RagitPaths {
  root: string;
  ragitDir: string;
  configPath: string;
  docsDir: string;
  docsIndexPath: string;
  manifestDir: string;
  reportsDir: string;
  narrativeReportsDir: string;
  logDir: string;
  transcriptDir: string;
  eventDir: string;
  harnessRunsDir: string;
  artifactsDir: string;
  sessionArtifactsDir: string;
  harnessArtifactsDir: string;
  memoryDir: string;
  memorySessionsDir: string;
  memoryWorkingDir: string;
  securityDir: string;
  securityStatePath: string;
  quarantineDir: string;
  admissionDir: string;
  storeDir: string;
  storeMetaPath: string;
  documentsCollectionDir: string;
  chunksCollectionDir: string;
  cacheDir: string;
  hooksDir: string;
  runtimeDir: string;
  runtimeTransactionsDir: string;
  storeWriteLockPath: string;
}

export const resolveRagitPaths = (cwd: string): RagitPaths => ({
  root: cwd,
  ragitDir: path.join(cwd, RAGIT_DIR),
  configPath: path.join(cwd, CONFIG_PATH),
  docsDir: path.join(cwd, ".ragit", "docs"),
  docsIndexPath: path.join(cwd, ".ragit", "docs", "index.json"),
  manifestDir: path.join(cwd, ".ragit", "manifest"),
  reportsDir: path.join(cwd, ".ragit", "reports"),
  narrativeReportsDir: path.join(cwd, ".ragit", "reports", "narrative"),
  logDir: path.join(cwd, ".ragit", "log"),
  transcriptDir: path.join(cwd, ".ragit", "log", "transcripts"),
  eventDir: path.join(cwd, ".ragit", "log", "events"),
  harnessRunsDir: path.join(cwd, ".ragit", "log", "harness-runs"),
  artifactsDir: path.join(cwd, ".ragit", "artifacts"),
  sessionArtifactsDir: path.join(cwd, ".ragit", "artifacts", "session"),
  harnessArtifactsDir: path.join(cwd, ".ragit", "artifacts", "harness"),
  memoryDir: path.join(cwd, ".ragit", "memory"),
  memorySessionsDir: path.join(cwd, ".ragit", "memory", "sessions"),
  memoryWorkingDir: path.join(cwd, ".ragit", "memory", "working"),
  securityDir: path.join(cwd, ".ragit", "security"),
  securityStatePath: path.join(cwd, ".ragit", "security", "state.json"),
  quarantineDir: path.join(cwd, ".ragit", "security", "quarantine"),
  admissionDir: path.join(cwd, ".ragit", "security", "admission"),
  storeDir: path.join(cwd, ".ragit", "store"),
  storeMetaPath: path.join(cwd, ".ragit", "store", "meta.json"),
  documentsCollectionDir: path.join(cwd, ".ragit", "store", "documents"),
  chunksCollectionDir: path.join(cwd, ".ragit", "store", "chunks"),
  cacheDir: path.join(cwd, ".ragit", "cache"),
  hooksDir: path.join(cwd, ".ragit", "hooks"),
  runtimeDir: path.join(cwd, ".ragit", "runtime"),
  runtimeTransactionsDir: path.join(cwd, ".ragit", "runtime", "transactions"),
  storeWriteLockPath: path.join(cwd, ".ragit", "runtime", "store-write.lock"),
});

export const ensureRagitDirectories = async (cwd: string): Promise<RagitPaths> => {
  const paths = resolveRagitPaths(cwd);
  await mkdir(paths.ragitDir, { recursive: true });
  await mkdir(paths.docsDir, { recursive: true });
  await mkdir(paths.manifestDir, { recursive: true });
  await mkdir(paths.reportsDir, { recursive: true });
  await mkdir(paths.narrativeReportsDir, { recursive: true });
  await mkdir(paths.logDir, { recursive: true });
  await mkdir(paths.transcriptDir, { recursive: true });
  await mkdir(paths.eventDir, { recursive: true });
  await mkdir(paths.harnessRunsDir, { recursive: true });
  await mkdir(paths.artifactsDir, { recursive: true });
  await mkdir(paths.sessionArtifactsDir, { recursive: true });
  await mkdir(paths.harnessArtifactsDir, { recursive: true });
  await mkdir(paths.memoryDir, { recursive: true });
  await mkdir(paths.memorySessionsDir, { recursive: true });
  await mkdir(paths.memoryWorkingDir, { recursive: true });
  await mkdir(paths.securityDir, { recursive: true });
  await mkdir(paths.quarantineDir, { recursive: true });
  await mkdir(paths.admissionDir, { recursive: true });
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

export interface GitIgnoreUpdateSummary {
  path: string;
  policy: RagitGitIgnorePolicy;
  plannedEntries: string[];
  addedEntries: string[];
  existingEntries: string[];
}

export const inspectGitIgnoreEntries = async (
  cwd: string,
  entries = DEFAULT_GITIGNORE_PLAN.entries,
  policy: RagitGitIgnorePolicy = DEFAULT_GITIGNORE_PLAN.policy,
): Promise<GitIgnoreUpdateSummary> => {
  const gitIgnorePath = path.join(cwd, ".gitignore");
  let content = "";
  try {
    content = await readFile(gitIgnorePath, "utf8");
  } catch {
    content = "";
  }
  const existingLines = new Set(content.split(/\r?\n/));
  const addedEntries = entries.filter((entry) => !existingLines.has(entry));
  const existingEntries = entries.filter((entry) => existingLines.has(entry));
  return {
    path: path.relative(cwd, gitIgnorePath) || ".gitignore",
    policy,
    plannedEntries: entries,
    addedEntries,
    existingEntries,
  };
};

export const ensureGitIgnoreEntries = async (
  cwd: string,
  entries = DEFAULT_GITIGNORE_PLAN.entries,
  policy: RagitGitIgnorePolicy = DEFAULT_GITIGNORE_PLAN.policy,
): Promise<GitIgnoreUpdateSummary> => {
  const gitIgnorePath = path.join(cwd, ".gitignore");
  let content = "";
  try {
    content = await readFile(gitIgnorePath, "utf8");
  } catch {
    content = "";
  }
  const summary = await inspectGitIgnoreEntries(cwd, entries, policy);
  if (summary.addedEntries.length === 0) return summary;

  const prefix = content.length === 0 ? "" : content.endsWith("\n") ? "" : "\n";
  const appended = `${summary.addedEntries.join("\n")}\n`;
  await writeFile(gitIgnorePath, `${content}${prefix}${appended}`, "utf8");
  return summary;
};
