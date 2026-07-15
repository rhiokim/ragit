import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  migrateEmbeddings,
  migrateFromJsonStore,
  migrateFromSqliteVss,
} from "../src/core/migrate.js";
import { runSecurityPurge } from "../src/core/security.js";
import { acquireStoreWriteLock } from "../src/core/store-write-lock.js";

const expectNotBusy = async (operation: () => Promise<unknown>): Promise<void> => {
  try {
    await operation();
  } catch (error) {
    expect(error).not.toMatchObject({ code: "STORE_WRITE_BUSY" });
  }
};

describe("shared store writer coverage", () => {
  it("serializes every mutating store writer while dry-runs bypass the lock", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "ragit-store-writers-"));
    const lock = await acquireStoreWriteLock(cwd, { command: "ingest" });

    try {
      const applyOperations = [
        () => migrateEmbeddings(cwd, false),
        () => migrateFromSqliteVss(cwd, false),
        () => migrateFromJsonStore(cwd, false),
        () => runSecurityPurge(cwd, "store", false),
        () => runSecurityPurge(cwd, "all", false),
      ];
      for (const operation of applyOperations) {
        await expect(operation()).rejects.toMatchObject({
          code: "STORE_WRITE_BUSY",
          details: { lockState: "active", owner: { token: lock.owner.token } },
        });
      }

      await expectNotBusy(() => migrateEmbeddings(cwd, true));
      await expectNotBusy(() => migrateFromSqliteVss(cwd, true));
      await expectNotBusy(() => migrateFromJsonStore(cwd, true));
      await expect(runSecurityPurge(cwd, "store", true)).resolves.toMatchObject({ mode: "dry-run" });
    } finally {
      await lock.release();
    }
  });
});
