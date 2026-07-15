import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { RagitOperationalError } from "./errors.js";
import { resolveRagitPaths } from "./project.js";

export const STORE_WRITE_LOCK_SCHEMA_VERSION = 1;

export type StoreWriteCommand = "ingest" | "ingest-recover" | "migrate-embeddings" | "migrate-from-sqlite-vss" | "migrate-from-json-store" | "security-purge-store";

export interface StoreWriteLockOwner {
  schemaVersion: number;
  token: string;
  pid: number;
  hostname: string;
  startedAt: string;
  command: StoreWriteCommand;
  headSha?: string;
}

export interface StoreWriteLock {
  path: string;
  owner: StoreWriteLockOwner;
  release(): Promise<boolean>;
}

export interface StoreWriteLockInspection {
  state: "missing" | "active" | "stale" | "unknown";
  owner: StoreWriteLockOwner | null;
}

export interface StoreWriteLockDependencies {
  hostname?: () => string;
  isProcessAlive?: (pid: number) => Promise<boolean>;
  now?: () => Date;
  token?: () => string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStoreWriteCommand = (value: unknown): value is StoreWriteCommand =>
  value === "ingest" ||
  value === "ingest-recover" ||
  value === "migrate-embeddings" ||
  value === "migrate-from-sqlite-vss" ||
  value === "migrate-from-json-store" ||
  value === "security-purge-store";

const parseOwner = (value: unknown): StoreWriteLockOwner | null => {
  if (!isRecord(value)) return null;
  if (
    value.schemaVersion !== STORE_WRITE_LOCK_SCHEMA_VERSION ||
    typeof value.token !== "string" ||
    value.token.length === 0 ||
    typeof value.pid !== "number" ||
    !Number.isInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.hostname !== "string" ||
    value.hostname.length === 0 ||
    typeof value.startedAt !== "string" ||
    value.startedAt.length === 0 ||
    !isStoreWriteCommand(value.command) ||
    (value.headSha !== undefined && typeof value.headSha !== "string")
  ) {
    return null;
  }
  return {
    schemaVersion: value.schemaVersion,
    token: value.token,
    pid: value.pid,
    hostname: value.hostname,
    startedAt: value.startedAt,
    command: value.command,
    ...(typeof value.headSha === "string" ? { headSha: value.headSha } : {}),
  };
};

const defaultIsProcessAlive = async (pid: number): Promise<boolean> => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error) {
      if (error.code === "EPERM") return true;
      if (error.code === "ESRCH") return false;
    }
    return true;
  }
};

const lockDependencies = (dependencies: StoreWriteLockDependencies = {}) => ({
  hostname: dependencies.hostname ?? hostname,
  isProcessAlive: dependencies.isProcessAlive ?? defaultIsProcessAlive,
  now: dependencies.now ?? (() => new Date()),
  token: dependencies.token ?? randomUUID,
});

const readOwner = async (cwd: string): Promise<StoreWriteLockOwner | null> => {
  try {
    return parseOwner(JSON.parse(await readFile(resolveRagitPaths(cwd).storeWriteLockPath, "utf8")));
  } catch {
    return null;
  }
};

export const inspectStoreWriteLock = async (
  cwd: string,
  dependencies: StoreWriteLockDependencies = {},
): Promise<StoreWriteLockInspection> => {
  const resolved = lockDependencies(dependencies);
  const paths = resolveRagitPaths(cwd);
  let content: string;
  try {
    content = await readFile(paths.storeWriteLockPath, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return { state: "missing", owner: null };
    }
    return { state: "unknown", owner: null };
  }

  let owner: StoreWriteLockOwner | null = null;
  try {
    owner = parseOwner(JSON.parse(content));
  } catch {
    owner = null;
  }
  if (owner === null || owner.hostname !== resolved.hostname()) {
    return { state: "unknown", owner };
  }
  return {
    state: await resolved.isProcessAlive(owner.pid) ? "active" : "stale",
    owner,
  };
};

const lockBusyError = (inspection: StoreWriteLockInspection): RagitOperationalError =>
  new RagitOperationalError(
    "STORE_WRITE_BUSY",
    "다른 ragit store writer가 실행 중이거나 lock 소유자를 확인할 수 없습니다.",
    {
      details: { lockState: inspection.state, owner: inspection.owner },
      recovery: { command: "retry after the active writer completes" },
    },
  );

const staleLockError = (inspection: StoreWriteLockInspection): RagitOperationalError =>
  new RagitOperationalError(
    "STORE_WRITE_LOCK_STALE",
    "ragit store write lock의 소유 프로세스가 종료되었습니다.",
    {
      details: { lockState: inspection.state, owner: inspection.owner },
      recovery: { command: "inspect .ragit/runtime/store-write.lock before removing it" },
    },
  );

export const releaseStoreWriteLock = async (cwd: string, token: string): Promise<boolean> => {
  const owner = await readOwner(cwd);
  if (owner === null || owner.token !== token) return false;
  await rm(resolveRagitPaths(cwd).storeWriteLockPath, { force: true });
  return true;
};

export const acquireStoreWriteLock = async (
  cwd: string,
  input: { command: StoreWriteCommand; headSha?: string },
  dependencies: StoreWriteLockDependencies = {},
): Promise<StoreWriteLock> => {
  const resolved = lockDependencies(dependencies);
  const paths = resolveRagitPaths(cwd);
  const owner: StoreWriteLockOwner = {
    schemaVersion: STORE_WRITE_LOCK_SCHEMA_VERSION,
    token: resolved.token(),
    pid: process.pid,
    hostname: resolved.hostname(),
    startedAt: resolved.now().toISOString(),
    command: input.command,
    ...(input.headSha ? { headSha: input.headSha } : {}),
  };
  await mkdir(paths.runtimeDir, { recursive: true });
  try {
    await writeFile(paths.storeWriteLockPath, `${JSON.stringify(owner)}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) {
      throw error;
    }
    const inspection = await inspectStoreWriteLock(cwd, dependencies);
    if (inspection.state === "stale") throw staleLockError(inspection);
    throw lockBusyError(inspection);
  }
  return {
    path: paths.storeWriteLockPath,
    owner,
    release: () => releaseStoreWriteLock(cwd, owner.token),
  };
};

export const withStoreWriteLock = async <T>(
  cwd: string,
  input: { command: StoreWriteCommand; headSha?: string },
  operation: () => Promise<T>,
): Promise<T> => {
  const lock = await acquireStoreWriteLock(cwd, input);
  try {
    return await operation();
  } finally {
    await lock.release();
  }
};
