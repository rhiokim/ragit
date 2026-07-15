import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createIngestTransaction,
  parseIngestTransactionJournal,
  readIngestTransaction,
  updateIngestTransaction,
} from "../src/core/ingest-transaction.js";
import { resolveRagitPaths } from "../src/core/project.js";

describe("ingest transaction journal", () => {
  it("atomically creates, updates, and parses a recovery record", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "ragit-ingest-transaction-"));
    const created = await createIngestTransaction(cwd, {
      targetHeadSha: "abc123",
      baseSha: "base456",
      manifestPath: ".ragit/manifest/abc123.json",
      documentVersionIds: ["document-version-1"],
      chunkIds: ["chunk-1", "chunk-2"],
    });

    expect(created).toMatchObject({
      schemaVersion: 1,
      transactionId: expect.any(String),
      kind: "ingest",
      status: "in-progress",
      phase: "prepared",
      targetHeadSha: "abc123",
      baseSha: "base456",
      manifestPath: ".ragit/manifest/abc123.json",
      documentVersionIds: ["document-version-1"],
      chunkIds: ["chunk-1", "chunk-2"],
      startedAt: expect.any(String),
      updatedAt: expect.any(String),
    });

    const updated = await updateIngestTransaction(cwd, created, { phase: "store-written" });
    expect(updated).toMatchObject({
      transactionId: created.transactionId,
      status: "in-progress",
      phase: "store-written",
    });
    await expect(readIngestTransaction(cwd, created.transactionId)).resolves.toEqual(updated);

    const transactionPath = path.join(resolveRagitPaths(cwd).runtimeTransactionsDir, `${created.transactionId}.json`);
    expect(parseIngestTransactionJournal(JSON.parse(await readFile(transactionPath, "utf8")))).toEqual(updated);
    expect(parseIngestTransactionJournal({ schemaVersion: 1 })).toBeNull();
    await expect(readdir(resolveRagitPaths(cwd).runtimeTransactionsDir)).resolves.toEqual([
      `${created.transactionId}.json`,
    ]);
  });

  it("continues to parse completed schema 1 journals without finalization payload", () => {
    const legacyCompleted = {
      schemaVersion: 1,
      transactionId: "legacy-completed",
      kind: "ingest" as const,
      status: "completed" as const,
      phase: "completed" as const,
      targetHeadSha: "abc123",
      manifestPath: ".ragit/manifest/abc123.json",
      startedAt: "2026-07-15T10:00:00.000Z",
      updatedAt: "2026-07-15T10:01:00.000Z",
      documentVersionIds: ["document-version-1"],
      chunkIds: ["chunk-1"],
    };

    expect(parseIngestTransactionJournal(legacyCompleted)).toEqual(legacyCompleted);
  });

  it("rejects a finalization payload with a non-canonical recordedAt timestamp", () => {
    expect(
      parseIngestTransactionJournal({
        schemaVersion: 1,
        transactionId: "invalid-recorded-at",
        kind: "ingest",
        status: "in-progress",
        phase: "manifest-committed",
        targetHeadSha: "abc123",
        manifestPath: ".ragit/manifest/abc123.json",
        startedAt: "2026-07-15T10:00:00.000Z",
        updatedAt: "2026-07-15T10:01:00.000Z",
        documentVersionIds: [],
        chunkIds: [],
        finalization: {
          recordedAt: "2026-07-15T10:00:00Z",
          processed: 0,
          scope: "durable",
          plannedFiles: [],
          plannedArtifactIds: [],
          plannedArtifactBindings: [],
        },
      }),
    ).toBeNull();
  });

  it("rejects unsafe transaction ids before constructing a journal path", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "ragit-ingest-transaction-safe-id-"));
    await expect(readIngestTransaction(cwd, "../outside")).rejects.toThrow(/unsafe ingest transaction id/i);
    await expect(readIngestTransaction(cwd, "nested/file")).rejects.toThrow(/unsafe ingest transaction id/i);
  });

  it("rejects a regular journal file whose embedded id differs from the requested id", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "ragit-ingest-transaction-mismatch-"));
    const paths = resolveRagitPaths(cwd);
    await mkdir(paths.runtimeTransactionsDir, { recursive: true });
    await writeFile(
      path.join(paths.runtimeTransactionsDir, "requested-id.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        transactionId: "different-id",
        kind: "ingest",
        status: "completed",
        phase: "completed",
        targetHeadSha: "abc123",
        manifestPath: ".ragit/manifest/abc123.json",
        startedAt: "2026-07-15T10:00:00.000Z",
        updatedAt: "2026-07-15T10:01:00.000Z",
        documentVersionIds: [],
        chunkIds: [],
      })}\n`,
      "utf8",
    );
    await expect(readIngestTransaction(cwd, "requested-id")).rejects.toThrow(/does not match requested id/i);
  });
});
