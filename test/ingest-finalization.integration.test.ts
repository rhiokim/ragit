import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadArtifactRecord, persistArtifactRecord, reviewArtifacts, sessionMaterialize } from "../src/core/artifacts.js";
import { readLedgerEvents } from "../src/core/event-ledger.js";
import { finalizeIngestTransaction } from "../src/core/ingest-finalization.js";
import { runIngest } from "../src/core/ingest.js";
import { readIngestTransaction, updateIngestTransaction } from "../src/core/ingest-transaction.js";
import { loadSnapshotManifest } from "../src/core/manifest.js";
import { resolveRagitPaths } from "../src/core/project.js";
import { runInit } from "../src/commands/init.js";

const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const writeDoc = async (cwd: string): Promise<void> => {
  await mkdir(path.join(cwd, "docs"), { recursive: true });
  await writeFile(
    path.join(cwd, "docs", "base.spec.md"),
    "---\ntype: spec\narchitecture_view: lld\n---\n# Recovery\nCommitted recovery content.\n",
    "utf8",
  );
};

const createPendingArtifactRepository = async (prefix: string): Promise<{ cwd: string; artifactId: string; headSha: string }> => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), prefix));
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.email", "ragit@example.com"]);
  git(cwd, ["config", "user.name", "ragit-test"]);
  await writeDoc(cwd);
  await runInit(cwd, { nonInteractive: true });
  const materialized = await sessionMaterialize(cwd, {
    goal: "recover ingest finalization",
    relatedPaths: ["docs/base.spec.md"],
    createdAt: "2026-07-15T10:00:00.000Z",
    turns: [
      {
        turnId: "turn-1",
        role: "user",
        content: "Please keep recovery behavior deterministic.",
        createdAt: "2026-07-15T10:00:00.000Z",
      },
    ],
  });
  const artifactId = materialized.artifactIds[0]!;
  await reviewArtifacts(cwd, {
    updates: [{ artifactId, nextStatus: "reviewed", reason: "ready for indexed recovery" }],
  });
  git(cwd, ["add", "."]);
  git(cwd, ["commit", "-m", "seed recovery repository"]);
  return { cwd, artifactId, headSha: git(cwd, ["rev-parse", "HEAD"]) };
};

const loadOnlyTransaction = async (cwd: string) => {
  const entries = (await readdir(resolveRagitPaths(cwd).runtimeTransactionsDir)).filter((entry) => entry.endsWith(".json"));
  expect(entries).toHaveLength(1);
  const journal = await readIngestTransaction(cwd, entries[0]!.replace(/\.json$/, ""));
  if (journal === null) throw new Error("expected ingest transaction");
  return journal;
};

const ingestCompletedEvents = async (cwd: string, headSha: string) =>
  (await readLedgerEvents(cwd)).filter((event) => event.eventType === "ingest.completed" && event.sourceHeadSha === headSha);

describe("ingest finalization", () => {
  it("projects artifact binding into a committed manifest and finalizes it idempotently", async () => {
    const { cwd, artifactId, headSha } = await createPendingArtifactRepository("ragit-finalization-repair-");

    await expect(
      runIngest(cwd, { all: true, scope: "all" }, {
        testHook: async (boundary) => {
          if (boundary === "after-manifest") throw new Error("stop after manifest publication");
        },
      }),
    ).rejects.toThrow("stop after manifest publication");

    const manifest = await loadSnapshotManifest(cwd, headSha);
    expect(manifest.artifactEntries?.find((entry) => entry.artifactId === artifactId)).toMatchObject({ bindingStatus: "bound" });
    await expect(loadArtifactRecord(cwd, artifactId)).resolves.toMatchObject({ bindingStatus: "pending", boundHeadSha: null });
    const journal = await loadOnlyTransaction(cwd);
    expect(journal.finalization?.plannedArtifactIds).toContain(artifactId);
    expect(journal.finalization?.plannedArtifactBindings).toContainEqual({ artifactId, updatedAt: expect.any(String) });
    expect(journal.finalization?.plannedFiles).toContain("docs/base.spec.md");
    expect(journal.finalization?.scope).toBe("all");

    await finalizeIngestTransaction(cwd, journal.transactionId);
    await expect(loadArtifactRecord(cwd, artifactId)).resolves.toMatchObject({ bindingStatus: "bound", boundHeadSha: headSha });
    expect(await ingestCompletedEvents(cwd, headSha)).toHaveLength(1);
    await expect(loadOnlyTransaction(cwd)).resolves.toMatchObject({ status: "completed", phase: "completed" });

    await finalizeIngestTransaction(cwd, journal.transactionId);
    expect(await ingestCompletedEvents(cwd, headSha)).toHaveLength(1);
  }, 30_000);

  it("recovers a manifest-visible journal crash window from the actual manifest", async () => {
    const { cwd, headSha } = await createPendingArtifactRepository("ragit-finalization-window-");
    await expect(
      runIngest(cwd, { all: true, scope: "all" }, {
        testHook: async (boundary) => {
          if (boundary === "after-manifest") throw new Error("simulate manifest journal window");
        },
      }),
    ).rejects.toThrow("simulate manifest journal window");
    const journal = await loadOnlyTransaction(cwd);
    await updateIngestTransaction(cwd, journal, { status: "failed-precommit", phase: "store-verified" });

    await finalizeIngestTransaction(cwd, journal.transactionId);
    await expect(loadOnlyTransaction(cwd)).resolves.toMatchObject({ status: "completed", phase: "completed" });
    expect(await ingestCompletedEvents(cwd, headSha)).toHaveLength(1);
  }, 30_000);

  it("does not finalize precommit or payload-less postcommit journals", async () => {
    const precommit = await createPendingArtifactRepository("ragit-finalization-precommit-");
    await expect(
      runIngest(precommit.cwd, { all: true, scope: "all" }, {
        testHook: async (boundary) => {
          if (boundary === "store-written") throw new Error("stop before manifest publication");
        },
      }),
    ).rejects.toThrow("stop before manifest publication");
    const precommitJournal = await loadOnlyTransaction(precommit.cwd);
    await expect(finalizeIngestTransaction(precommit.cwd, precommitJournal.transactionId)).rejects.toMatchObject({
      code: "SNAPSHOT_NOT_INDEXED",
    });
    expect(await ingestCompletedEvents(precommit.cwd, precommit.headSha)).toHaveLength(0);

    const payloadLess = await createPendingArtifactRepository("ragit-finalization-payload-less-");
    await expect(
      runIngest(payloadLess.cwd, { all: true, scope: "all" }, {
        testHook: async (boundary) => {
          if (boundary === "after-manifest") throw new Error("leave postcommit journal");
        },
      }),
    ).rejects.toThrow("leave postcommit journal");
    const journal = await loadOnlyTransaction(payloadLess.cwd);
    const journalPath = path.join(resolveRagitPaths(payloadLess.cwd).runtimeTransactionsDir, `${journal.transactionId}.json`);
    const raw = JSON.parse(await readFile(journalPath, "utf8")) as Record<string, unknown>;
    delete raw.finalization;
    await writeFile(journalPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");

    await expect(finalizeIngestTransaction(payloadLess.cwd, journal.transactionId)).rejects.toThrow(/finalization payload/i);
    expect(await ingestCompletedEvents(payloadLess.cwd, payloadLess.headSha)).toHaveLength(0);
  }, 45_000);

  it("rejects invalid target SHAs and unexpected manifest paths before finalization", async () => {
    const { cwd } = await createPendingArtifactRepository("ragit-finalization-path-");
    await expect(
      runIngest(cwd, { all: true, scope: "all" }, {
        testHook: async (boundary) => {
          if (boundary === "after-manifest") throw new Error("leave path validation journal");
        },
      }),
    ).rejects.toThrow("leave path validation journal");
    const journal = await loadOnlyTransaction(cwd);
    const journalPath = path.join(resolveRagitPaths(cwd).runtimeTransactionsDir, `${journal.transactionId}.json`);
    const raw = JSON.parse(await readFile(journalPath, "utf8")) as Record<string, unknown>;

    raw.manifestPath = ".ragit/manifest/not-the-target.json";
    await writeFile(journalPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    await expect(finalizeIngestTransaction(cwd, journal.transactionId)).rejects.toThrow(/unexpected manifest path/i);

    raw.targetHeadSha = "../outside";
    raw.manifestPath = ".ragit/manifest/../outside.json";
    await writeFile(journalPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    await expect(finalizeIngestTransaction(cwd, journal.transactionId)).rejects.toThrow(/invalid target HEAD/i);
  }, 30_000);

  it("does not overwrite a changed planned artifact and retries ledger finalization without duplicates", async () => {
    const conflict = await createPendingArtifactRepository("ragit-finalization-conflict-");
    await expect(
      runIngest(conflict.cwd, { all: true, scope: "all" }, {
        testHook: async (boundary) => {
          if (boundary === "after-manifest") throw new Error("leave conflict journal");
        },
      }),
    ).rejects.toThrow("leave conflict journal");
    const conflictJournal = await loadOnlyTransaction(conflict.cwd);
    const artifact = await loadArtifactRecord(conflict.cwd, conflict.artifactId);
    if (!artifact) throw new Error("expected planned artifact");
    await persistArtifactRecord(conflict.cwd, { ...artifact, updatedAt: "2026-07-15T11:00:00.000Z" });
    await expect(finalizeIngestTransaction(conflict.cwd, conflictJournal.transactionId)).rejects.toThrow(/artifact binding conflict/i);
    await expect(loadArtifactRecord(conflict.cwd, conflict.artifactId)).resolves.toMatchObject({ bindingStatus: "pending" });

    const retry = await createPendingArtifactRepository("ragit-finalization-ledger-");
    await expect(
      runIngest(retry.cwd, { all: true, scope: "all" }, {
        testHook: async (boundary) => {
          if (boundary === "after-artifacts-finalized") throw new Error("stop before ledger finalization");
        },
      }),
    ).rejects.toThrow("stop before ledger finalization");
    await expect(loadArtifactRecord(retry.cwd, retry.artifactId)).resolves.toMatchObject({ bindingStatus: "bound", boundHeadSha: retry.headSha });
    expect(await ingestCompletedEvents(retry.cwd, retry.headSha)).toHaveLength(0);
    const retryJournal = await loadOnlyTransaction(retry.cwd);
    expect(retryJournal).toMatchObject({ status: "failed-postcommit", phase: "artifacts-finalized" });

    await finalizeIngestTransaction(retry.cwd, retryJournal.transactionId);
    await finalizeIngestTransaction(retry.cwd, retryJournal.transactionId);
    expect(await ingestCompletedEvents(retry.cwd, retry.headSha)).toHaveLength(1);
    await expect(loadOnlyTransaction(retry.cwd)).resolves.toMatchObject({ status: "completed", phase: "completed" });

    const afterAppend = await createPendingArtifactRepository("ragit-finalization-after-append-");
    await expect(
      runIngest(afterAppend.cwd, { all: true, scope: "all" }, {
        testHook: async (boundary) => {
          if (boundary === "after-ledger-appended") throw new Error("stop after ledger append");
        },
      }),
    ).rejects.toThrow("stop after ledger append");
    expect(await ingestCompletedEvents(afterAppend.cwd, afterAppend.headSha)).toHaveLength(1);
    const afterAppendJournal = await loadOnlyTransaction(afterAppend.cwd);
    expect(afterAppendJournal).toMatchObject({ status: "failed-postcommit", phase: "artifacts-finalized" });

    await finalizeIngestTransaction(afterAppend.cwd, afterAppendJournal.transactionId);
    await finalizeIngestTransaction(afterAppend.cwd, afterAppendJournal.transactionId);
    expect(await ingestCompletedEvents(afterAppend.cwd, afterAppend.headSha)).toHaveLength(1);
    await expect(loadOnlyTransaction(afterAppend.cwd)).resolves.toMatchObject({ status: "completed", phase: "completed" });
  }, 45_000);
});
