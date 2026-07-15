import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runDoctor, runStatus } from "../src/commands/bootstrap.js";
import { loadArtifactRecord, reviewArtifacts, sessionMaterialize } from "../src/core/artifacts.js";
import { readLedgerEvents } from "../src/core/event-ledger.js";
import { runIngest } from "../src/core/ingest.js";
import { scanIngestTransactions } from "../src/core/ingest-recovery.js";
import { readIngestTransaction, updateIngestTransaction } from "../src/core/ingest-transaction.js";
import { resolveRagitPaths } from "../src/core/project.js";
import { runRepair } from "../src/core/repair.js";
import { bootstrapCanonicalStore, closeCanonicalStore, readCanonicalStoreMeta } from "../src/core/store.js";
import { acquireStoreWriteLock } from "../src/core/store-write-lock.js";
import { runInit } from "../src/commands/init.js";

const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const snapshotTree = async (cwd: string, relative = ""): Promise<Array<{ path: string; content: string }>> => {
  const entries = await readdir(path.join(cwd, relative), { withFileTypes: true });
  const snapshot: Array<{ path: string; content: string }> = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!relative && entry.name === ".git") continue;
    if (relative === ".ragit" && entry.name === "store") continue;
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) snapshot.push(...await snapshotTree(cwd, child));
    else snapshot.push({ path: child, content: await readFile(path.join(cwd, child), "utf8") });
  }
  return snapshot;
};

const createPendingArtifactRepository = async (prefix: string): Promise<{ cwd: string; artifactId: string; headSha: string }> => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), prefix));
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.email", "ragit@example.com"]);
  git(cwd, ["config", "user.name", "ragit-test"]);
  await mkdir(path.join(cwd, "docs"), { recursive: true });
  await writeFile(
    path.join(cwd, "docs", "base.spec.md"),
    "---\ntype: spec\narchitecture_view: lld\n---\n# Recovery\nCommitted recovery content.\n",
    "utf8",
  );
  await runInit(cwd, { nonInteractive: true });
  const materialized = await sessionMaterialize(cwd, {
    goal: "recover ingest finalization",
    relatedPaths: ["docs/base.spec.md"],
    createdAt: "2026-07-15T10:00:00.000Z",
    turns: [{ turnId: "turn-1", role: "user", content: "Keep recovery deterministic.", createdAt: "2026-07-15T10:00:00.000Z" }],
  });
  const artifactId = materialized.artifactIds[0]!;
  await reviewArtifacts(cwd, { updates: [{ artifactId, nextStatus: "reviewed", reason: "ready for recovery" }] });
  git(cwd, ["add", "."]);
  git(cwd, ["commit", "-m", "seed recovery repository"]);
  return { cwd, artifactId, headSha: git(cwd, ["rev-parse", "HEAD"]) };
};

const loadOnlyTransaction = async (cwd: string) => {
  const entries = (await readdir(resolveRagitPaths(cwd).runtimeTransactionsDir)).filter((entry) => entry.endsWith(".json"));
  expect(entries).toHaveLength(1);
  const journal = await readIngestTransaction(cwd, entries[0]!.replace(/\.json$/, ""));
  if (!journal) throw new Error("expected ingest transaction");
  return journal;
};

const leaveManifestVisibleTransaction = async (cwd: string) => {
  await expect(
    runIngest(cwd, { all: true, scope: "all" }, {
      testHook: async (boundary) => {
        if (boundary === "after-manifest") throw new Error("stop after manifest publication");
      },
    }),
  ).rejects.toThrow("stop after manifest publication");
  return loadOnlyTransaction(cwd);
};

const completedEvents = async (cwd: string, headSha: string) =>
  (await readLedgerEvents(cwd)).filter((event) => event.eventType === "ingest.completed" && event.sourceHeadSha === headSha);

describe("ingest recovery diagnostics and repair", () => {
  it("keeps missing transaction directories empty and diagnoses malformed, mismatched, and unsafe journal files", async () => {
    const empty = await mkdtemp(path.join(os.tmpdir(), "ragit-ingest-recovery-empty-"));
    await expect(scanIngestTransactions(empty)).resolves.toMatchObject({ transactions: [], summary: { invalid: 0 } });

    const { cwd } = await createPendingArtifactRepository("ragit-ingest-recovery-invalid-");
    const transactions = resolveRagitPaths(cwd).runtimeTransactionsDir;
    await mkdir(transactions, { recursive: true });
    await writeFile(path.join(transactions, "malformed.json"), "{", "utf8");
    await writeFile(
      path.join(transactions, "mismatch.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        transactionId: "different-id",
        kind: "ingest",
        status: "completed",
        phase: "completed",
        targetHeadSha: "abc123",
        manifestPath: ".ragit/manifest/abc123.json",
        startedAt: "2026-07-15T10:00:00.000Z",
        updatedAt: "2026-07-15T10:00:00.000Z",
        documentVersionIds: [],
        chunkIds: [],
      })}\n`,
      "utf8",
    );
    await symlink(path.join(transactions, "malformed.json"), path.join(transactions, "symlink.json"));

    const before = await snapshotTree(cwd);
    const [diagnostics, status, doctor] = await Promise.all([scanIngestTransactions(cwd), runStatus(cwd), runDoctor(cwd)]);
    expect(diagnostics.summary.invalid).toBe(3);
    expect(status.ingestRecovery.summary.invalid).toBe(3);
    expect(doctor.checks.find((check) => check.name === "ingest.transactions")?.ok).toBe(false);
    expect(await snapshotTree(cwd)).toEqual(before);
  }, 30_000);

  it("reports lock and manifest-visible finalization without exposing the lock token, and remains read-only", async () => {
    const { cwd, headSha } = await createPendingArtifactRepository("ragit-ingest-recovery-status-");
    const journal = await leaveManifestVisibleTransaction(cwd);
    await updateIngestTransaction(cwd, journal, { status: "failed-precommit", phase: "store-verified" });
    const lock = await acquireStoreWriteLock(cwd, { command: "migrate-embeddings", headSha });
    try {
      const before = await snapshotTree(cwd);
      const [status, doctor] = await Promise.all([runStatus(cwd), runDoctor(cwd)]);
      expect(status.storeWriter).toMatchObject({
        state: "active",
        owner: { pid: process.pid, command: "migrate-embeddings", headSha },
      });
      expect(JSON.stringify(status.storeWriter)).not.toContain(lock.owner.token);
      expect(status.ingestRecovery).toMatchObject({
        summary: { finalizationPending: 1 },
        pending: [expect.objectContaining({ transactionId: journal.transactionId, phase: "store-verified" })],
      });
      expect(doctor.checks.find((check) => check.name === "store-write-lock")?.ok).toBe(true);
      expect(doctor.checks.find((check) => check.name === "ingest.transactions")?.ok).toBe(false);
      expect(await snapshotTree(cwd)).toEqual(before);
    } finally {
      await lock.release();
    }
  }, 45_000);

  it("classifies only valid completed journals as completed and keeps hard-crash precommit journals non-recoverable", async () => {
    const completed = await createPendingArtifactRepository("ragit-ingest-recovery-completed-");
    await runIngest(completed.cwd, { all: true, scope: "all" });
    const completedJournal = await loadOnlyTransaction(completed.cwd);
    await expect(scanIngestTransactions(completed.cwd)).resolves.toMatchObject({ summary: { completed: 1 } });
    const completedPath = path.join(resolveRagitPaths(completed.cwd).runtimeTransactionsDir, `${completedJournal.transactionId}.json`);
    const completedRaw = JSON.parse(await readFile(completedPath, "utf8")) as Record<string, unknown>;
    delete completedRaw.finalization;
    await writeFile(completedPath, `${JSON.stringify(completedRaw, null, 2)}\n`, "utf8");
    await expect(scanIngestTransactions(completed.cwd)).resolves.toMatchObject({
      summary: { completed: 1 },
      lastCompleted: { transactionId: completedJournal.transactionId },
    });
    completedRaw.phase = "store-verified";
    await writeFile(completedPath, `${JSON.stringify(completedRaw, null, 2)}\n`, "utf8");
    await expect(scanIngestTransactions(completed.cwd)).resolves.toMatchObject({ summary: { inconsistent: 1 } });
    completedRaw.phase = "completed";
    completedRaw.manifestPath = ".ragit/manifest/not-the-target.json";
    await writeFile(completedPath, `${JSON.stringify(completedRaw, null, 2)}\n`, "utf8");
    await expect(scanIngestTransactions(completed.cwd)).resolves.toMatchObject({ summary: { inconsistent: 1 } });
    completedRaw.manifestPath = `.ragit/manifest/${completed.headSha}.json`;
    completedRaw.targetHeadSha = "not-a-git-object";
    await writeFile(completedPath, `${JSON.stringify(completedRaw, null, 2)}\n`, "utf8");
    await expect(scanIngestTransactions(completed.cwd)).resolves.toMatchObject({ summary: { inconsistent: 1 } });

    const crashed = await createPendingArtifactRepository("ragit-ingest-recovery-hard-crash-");
    await expect(
      runIngest(crashed.cwd, { all: true, scope: "all" }, {
        testHook: async (boundary) => {
          if (boundary === "store-written") throw new Error("simulate hard crash");
        },
      }),
    ).rejects.toThrow("simulate hard crash");
    const crashedJournal = await loadOnlyTransaction(crashed.cwd);
    await updateIngestTransaction(crashed.cwd, crashedJournal, { status: "in-progress", phase: "store-written" });
    await expect(scanIngestTransactions(crashed.cwd)).resolves.toMatchObject({ summary: { precommitIncomplete: 1 } });
    await expect(runRepair(crashed.cwd, { actions: ["ingest-recover"] })).resolves.toMatchObject({ plannedActions: [] });
    await expect(runIngest(crashed.cwd, { all: true, scope: "all" })).resolves.toMatchObject({ mode: "apply" });
  }, 60_000);

  it("plans recovery read-only, applies only manifest-visible work, and remains idempotent", async () => {
    const { cwd, artifactId, headSha } = await createPendingArtifactRepository("ragit-ingest-recovery-repair-");
    const journal = await leaveManifestVisibleTransaction(cwd);
    const before = await snapshotTree(cwd);
    const plan = await runRepair(cwd, { actions: ["ingest-recover"] });
    expect(plan.plannedActions).toEqual([expect.objectContaining({ action: "ingest-recover", sourceItemId: journal.transactionId })]);
    expect(await snapshotTree(cwd)).toEqual(before);

    const applied = await runRepair(cwd, { apply: true, actions: ["ingest-recover"] });
    expect(applied.executedActions).toEqual([expect.objectContaining({ action: "ingest-recover", status: "executed" })]);
    await expect(loadArtifactRecord(cwd, artifactId)).resolves.toMatchObject({ bindingStatus: "bound", boundHeadSha: headSha });
    expect(await completedEvents(cwd, headSha)).toHaveLength(1);
    await expect(loadOnlyTransaction(cwd)).resolves.toMatchObject({ status: "completed", phase: "completed" });

    await runRepair(cwd, { apply: true, actions: ["ingest-recover"] });
    expect(await completedEvents(cwd, headSha)).toHaveLength(1);
  }, 45_000);

  it("does not recover journal record references that are absent from the committed manifest", async () => {
    const { cwd } = await createPendingArtifactRepository("ragit-ingest-recovery-manifest-mismatch-");
    const journal = await leaveManifestVisibleTransaction(cwd);
    const journalPath = path.join(resolveRagitPaths(cwd).runtimeTransactionsDir, `${journal.transactionId}.json`);
    const raw = JSON.parse(await readFile(journalPath, "utf8")) as Record<string, unknown>;
    raw.documentVersionIds = ["missing-document-version"];
    await writeFile(journalPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    await expect(scanIngestTransactions(cwd)).resolves.toMatchObject({ summary: { inconsistent: 1 } });

    raw.documentVersionIds = journal.documentVersionIds;
    raw.chunkIds = ["missing-chunk"];
    await writeFile(journalPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    await expect(scanIngestTransactions(cwd)).resolves.toMatchObject({ summary: { inconsistent: 1 } });

    raw.chunkIds = journal.chunkIds;
    raw.finalization = {
      ...journal.finalization,
      plannedArtifactIds: ["missing-artifact"],
      plannedArtifactBindings: [{ artifactId: "missing-artifact", updatedAt: journal.finalization!.plannedArtifactBindings[0]!.updatedAt }],
    };
    await writeFile(journalPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    await expect(scanIngestTransactions(cwd)).resolves.toMatchObject({ summary: { inconsistent: 1 } });
    await expect(runRepair(cwd, { actions: ["ingest-recover"] })).resolves.toMatchObject({ plannedActions: [] });
    await expect(runIngest(cwd, { all: true, scope: "all" })).rejects.toMatchObject({ code: "INGEST_RECOVERY_REQUIRED" });
  }, 45_000);

  it("rechecks recovery eligibility after acquiring the writer lock", async () => {
    const { cwd } = await createPendingArtifactRepository("ragit-ingest-recovery-recheck-");
    const journal = await leaveManifestVisibleTransaction(cwd);
    const journalPath = path.join(resolveRagitPaths(cwd).runtimeTransactionsDir, `${journal.transactionId}.json`);
    const result = await runRepair(
      cwd,
      { apply: true, actions: ["ingest-recover"] },
      {
        beforeIngestRecoveryLock: async () => {
          const raw = JSON.parse(await readFile(journalPath, "utf8")) as Record<string, unknown>;
          raw.manifestPath = ".ragit/manifest/not-the-target.json";
          await writeFile(journalPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
        },
      },
    );
    expect(result.executedActions).toHaveLength(0);
    expect(result.skippedActions).toEqual([expect.objectContaining({ action: "ingest-recover", status: "skipped" })]);
    await expect(readIngestTransaction(cwd, journal.transactionId)).resolves.toMatchObject({ status: "failed-postcommit" });
  }, 45_000);

  it("does not finalize precommit work, but automatically finalizes a recoverable committed transaction before the next ingest", async () => {
    const precommit = await createPendingArtifactRepository("ragit-ingest-recovery-precommit-");
    await expect(
      runIngest(precommit.cwd, { all: true, scope: "all" }, {
        testHook: async (boundary) => {
          if (boundary === "store-written") throw new Error("stop before manifest");
        },
      }),
    ).rejects.toThrow("stop before manifest");
    const precommitJournal = await loadOnlyTransaction(precommit.cwd);
    const precommitPlan = await runRepair(precommit.cwd, { actions: ["ingest-recover"] });
    expect(precommitPlan.plannedActions).toHaveLength(0);
    await expect(readIngestTransaction(precommit.cwd, precommitJournal.transactionId)).resolves.toMatchObject({ status: "failed-precommit" });

    const recoverable = await createPendingArtifactRepository("ragit-ingest-recovery-auto-");
    const journal = await leaveManifestVisibleTransaction(recoverable.cwd);
    await runIngest(recoverable.cwd, { all: true, scope: "all" });
    await expect(readIngestTransaction(recoverable.cwd, journal.transactionId)).resolves.toMatchObject({ status: "completed", phase: "completed" });
    expect(await completedEvents(recoverable.cwd, recoverable.headSha)).toHaveLength(2);
  }, 60_000);

  it("blocks new ingest for unrepairable committed state before store writing and propagates recovery lock contention", async () => {
    const blocked = await createPendingArtifactRepository("ragit-ingest-recovery-blocked-");
    const journal = await leaveManifestVisibleTransaction(blocked.cwd);
    const journalPath = path.join(resolveRagitPaths(blocked.cwd).runtimeTransactionsDir, `${journal.transactionId}.json`);
    const raw = JSON.parse(await readFile(journalPath, "utf8")) as Record<string, unknown>;
    raw.manifestPath = ".ragit/manifest/not-the-target.json";
    await writeFile(journalPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    let storeWritten = false;
    await expect(
      runIngest(blocked.cwd, { all: true, scope: "all" }, {
        testHook: async (boundary) => {
          if (boundary === "store-written") storeWritten = true;
        },
      }),
    ).rejects.toMatchObject({ code: "INGEST_RECOVERY_REQUIRED", exitCode: 3 });
    expect(storeWritten).toBe(false);

    const malformed = await createPendingArtifactRepository("ragit-ingest-recovery-malformed-block-");
    const malformedDir = resolveRagitPaths(malformed.cwd).runtimeTransactionsDir;
    await mkdir(malformedDir, { recursive: true });
    await writeFile(path.join(malformedDir, "malformed.json"), "{", "utf8");
    await expect(runIngest(malformed.cwd, { all: true, scope: "all" })).rejects.toMatchObject({
      code: "INGEST_RECOVERY_REQUIRED",
      exitCode: 3,
    });

    const busy = await createPendingArtifactRepository("ragit-ingest-recovery-busy-");
    await leaveManifestVisibleTransaction(busy.cwd);
    const lock = await acquireStoreWriteLock(busy.cwd, { command: "migrate-embeddings" });
    try {
      await expect(runRepair(busy.cwd, { apply: true, actions: ["ingest-recover"] })).rejects.toMatchObject({
        code: "STORE_WRITE_BUSY",
        exitCode: 3,
      });
    } finally {
      await lock.release();
    }
  }, 60_000);

  it("retains doctor manifest-to-store fetch verification", async () => {
    const { cwd } = await createPendingArtifactRepository("ragit-ingest-recovery-doctor-store-");
    await runIngest(cwd, { all: true, scope: "all" });
    const journal = await loadOnlyTransaction(cwd);
    const meta = await readCanonicalStoreMeta(cwd);
    if (!meta) throw new Error("expected canonical store metadata");
    const store = await bootstrapCanonicalStore(cwd, meta.embeddingContract);
    try {
      store.chunks.deleteSync(journal.chunkIds[0]!);
    } finally {
      closeCanonicalStore(store);
    }
    const doctor = await runDoctor(cwd);
    expect(doctor.checks.find((check) => check.name === "ragit.manifest-consistency")).toMatchObject({
      ok: false,
      detail: expect.stringContaining("missingChunkIds=1"),
    });
  }, 45_000);

  it("reports an unknown writer lock as a failing doctor check", async () => {
    const { cwd } = await createPendingArtifactRepository("ragit-ingest-recovery-unknown-lock-");
    const paths = resolveRagitPaths(cwd);
    await mkdir(paths.runtimeDir, { recursive: true });
    await writeFile(paths.storeWriteLockPath, "not-json\n", "utf8");
    const doctor = await runDoctor(cwd);
    expect(doctor.checks.find((check) => check.name === "store-write-lock")).toMatchObject({ ok: false });
  }, 30_000);
});
