import { lstat, rename, rm } from "node:fs/promises";
import path from "node:path";
import { resolveRagitPaths } from "./project.js";

export interface StoreSwapDependencies {
  beforePromoteNext?: () => Promise<void> | void;
}

const exists = async (target: string): Promise<boolean> => {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
};

export const storeSwapPaths = (cwd: string) => {
  const paths = resolveRagitPaths(cwd);
  return {
    store: paths.storeDir,
    next: path.join(paths.ragitDir, "store.next"),
    previous: path.join(paths.ragitDir, "store.prev"),
  };
};

export const assertStoreSwapReady = async (cwd: string): Promise<void> => {
  const paths = storeSwapPaths(cwd);
  if (await exists(paths.next) || await exists(paths.previous)) {
    throw new Error("store rebuild temporary directory(.ragit/store.next 또는 .ragit/store.prev)가 남아 있습니다.");
  }
};

export const promoteNextStore = async (cwd: string, dependencies: StoreSwapDependencies = {}): Promise<void> => {
  const paths = storeSwapPaths(cwd);
  if (await exists(paths.previous)) {
    throw new Error("store backup(.ragit/store.prev)이 남아 있습니다.");
  }
  if (!(await exists(paths.next))) {
    throw new Error("temporary store(.ragit/store.next)를 찾을 수 없습니다.");
  }
  if (!(await exists(paths.store))) {
    await dependencies.beforePromoteNext?.();
    await rename(paths.next, paths.store);
    return;
  }
  await rename(paths.store, paths.previous);
  try {
    await dependencies.beforePromoteNext?.();
    await rename(paths.next, paths.store);
  } catch (error) {
    try {
      await rename(paths.previous, paths.store);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "store promotion and rollback both failed");
    }
    throw error;
  }
  await rm(paths.previous, { recursive: true, force: true });
};

export const removeNextStore = async (cwd: string): Promise<void> => {
  await rm(storeSwapPaths(cwd).next, { recursive: true, force: true });
};
