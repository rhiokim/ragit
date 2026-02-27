import { readdir } from "node:fs/promises";
import path from "node:path";
import { loadConfig, setConfigValue, writeConfig } from "../core/config.js";
import { ensureGitRepository, currentBranch, getHeadSha } from "../core/git.js";
import { ensureGitIgnoreEntries, ensureRagitStructure, resolveRagitPaths } from "../core/project.js";

export const runInit = async (cwd: string): Promise<void> => {
  await ensureGitRepository(cwd);
  await ensureRagitStructure(cwd);
  await ensureGitIgnoreEntries(cwd);
  console.log("ragit 초기화가 완료되었습니다.");
};

export const runConfigSet = async (cwd: string, key: string, value: string): Promise<void> => {
  await ensureRagitStructure(cwd);
  const config = await loadConfig(cwd);
  const updated = setConfigValue(config, key, value);
  await writeConfig(cwd, updated);
  console.log(`설정이 업데이트되었습니다: ${key}=${value}`);
};

export const runStatus = async (cwd: string): Promise<void> => {
  await ensureRagitStructure(cwd);
  const paths = resolveRagitPaths(cwd);
  const config = await loadConfig(cwd);
  const manifests = await readdir(paths.manifestDir);
  const branch = await currentBranch(cwd);
  const sha = await getHeadSha(cwd);
  const status = {
    branch,
    head: sha,
    backend: config.storage.backend,
    supported_types: config.ingest.supported_types,
    manifests: manifests.length,
    format: config.output.format,
  };
  console.log(JSON.stringify(status, null, 2));
};

export const runDoctor = async (cwd: string): Promise<void> => {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
  try {
    await ensureGitRepository(cwd);
    checks.push({ name: "git.repository", ok: true, detail: "저장소 확인 완료" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checks.push({ name: "git.repository", ok: false, detail: message });
  }
  try {
    const paths = await ensureRagitStructure(cwd);
    const manifests = await readdir(paths.manifestDir);
    checks.push({ name: "ragit.structure", ok: true, detail: `manifest=${manifests.length}` });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checks.push({ name: "ragit.structure", ok: false, detail: message });
  }
  try {
    const config = await loadConfig(cwd);
    checks.push({ name: "ragit.config", ok: true, detail: `backend=${config.storage.backend}` });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checks.push({ name: "ragit.config", ok: false, detail: message });
  }
  const hasFailure = checks.some((check) => !check.ok);
  for (const check of checks) {
    const icon = check.ok ? "✅" : "❌";
    console.log(`${icon} ${check.name}: ${check.detail}`);
  }
  if (hasFailure) {
    throw new Error("doctor 진단에서 실패가 발견되었습니다.");
  }
};

export const resolveCwd = (input?: string): string => (input ? path.resolve(input) : process.cwd());
