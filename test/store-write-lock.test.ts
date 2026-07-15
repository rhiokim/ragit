import { hostname } from "node:os";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  acquireStoreWriteLock,
  inspectStoreWriteLock,
  releaseStoreWriteLock,
} from "../src/core/store-write-lock.js";
import { resolveRagitPaths } from "../src/core/project.js";

const missing = async (target: string): Promise<void> => {
  await expect(access(target, constants.F_OK)).rejects.toThrow();
};

describe("store write lock", () => {
  it("acquires one exclusive lock with inspectable owner metadata", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "ragit-store-lock-"));

    const lock = await acquireStoreWriteLock(cwd, {
      command: "ingest",
      headSha: "abc123",
    });

    const owner = JSON.parse(await readFile(lock.path, "utf8")) as Record<string, unknown>;
    expect(owner).toMatchObject({
      schemaVersion: 1,
      token: lock.owner.token,
      pid: process.pid,
      hostname: hostname(),
      command: "ingest",
      headSha: "abc123",
    });
    expect(typeof owner.startedAt).toBe("string");
    await expect(inspectStoreWriteLock(cwd)).resolves.toMatchObject({
      state: "active",
      owner: { token: lock.owner.token },
    });

    await expect(lock.release()).resolves.toBe(true);
    await missing(lock.path);
  });

  it("rejects a concurrent live writer with a retryable structured error", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "ragit-store-lock-busy-"));
    const lock = await acquireStoreWriteLock(cwd, { command: "ingest" });

    await expect(acquireStoreWriteLock(cwd, { command: "migrate-embeddings" })).rejects.toMatchObject({
      code: "STORE_WRITE_BUSY",
      exitCode: 3,
      retryable: true,
      details: {
        lockState: "active",
        owner: { token: lock.owner.token, command: "ingest" },
      },
    });

    await lock.release();
  });

  it("reports a dead same-host owner as stale without stealing its lock", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "ragit-store-lock-stale-"));
    const paths = resolveRagitPaths(cwd);
    await mkdir(paths.runtimeDir, { recursive: true });
    await writeFile(
      paths.storeWriteLockPath,
      `${JSON.stringify({
        schemaVersion: 1,
        token: "stale-token",
        pid: 12345,
        hostname: hostname(),
        startedAt: "2026-07-15T00:00:00.000Z",
        command: "ingest",
      })}\n`,
      "utf8",
    );

    const dependencies = { isProcessAlive: async () => false };
    await expect(inspectStoreWriteLock(cwd, dependencies)).resolves.toMatchObject({
      state: "stale",
      owner: { token: "stale-token" },
    });
    await expect(acquireStoreWriteLock(cwd, { command: "ingest" }, dependencies)).rejects.toMatchObject({
      code: "STORE_WRITE_LOCK_STALE",
      exitCode: 3,
      retryable: false,
      details: { lockState: "stale", owner: { token: "stale-token" } },
    });
    expect(JSON.parse(await readFile(paths.storeWriteLockPath, "utf8"))).toMatchObject({ token: "stale-token" });
  });

  it("does not steal a lock owned by another host", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "ragit-store-lock-remote-"));
    const paths = resolveRagitPaths(cwd);
    const remoteHostname = `${hostname()}-remote`;
    await mkdir(paths.runtimeDir, { recursive: true });
    await writeFile(
      paths.storeWriteLockPath,
      `${JSON.stringify({
        schemaVersion: 1,
        token: "remote-token",
        pid: 12345,
        hostname: remoteHostname,
        startedAt: "2026-07-15T00:00:00.000Z",
        command: "ingest",
      })}\n`,
      "utf8",
    );

    await expect(acquireStoreWriteLock(cwd, { command: "ingest" })).rejects.toMatchObject({
      code: "STORE_WRITE_BUSY",
      details: { lockState: "unknown", owner: { token: "remote-token", hostname: remoteHostname } },
    });
    expect(JSON.parse(await readFile(paths.storeWriteLockPath, "utf8"))).toMatchObject({ token: "remote-token" });
  });

  it("does not release a lock when the token no longer matches", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "ragit-store-lock-release-"));
    const lock = await acquireStoreWriteLock(cwd, { command: "ingest" });

    await expect(releaseStoreWriteLock(cwd, "different-token")).resolves.toBe(false);
    await expect(access(lock.path, constants.F_OK)).resolves.toBeUndefined();
    await expect(lock.release()).resolves.toBe(true);
    await missing(lock.path);
  });
});
