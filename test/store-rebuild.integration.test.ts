import { execFileSync } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { reviewArtifacts, sessionMaterialize } from "../src/core/artifacts.js";
import { runIngest } from "../src/core/ingest.js";
import { scanIngestTransactions } from "../src/core/ingest-recovery.js";
import { createIngestTransaction, updateIngestTransaction } from "../src/core/ingest-transaction.js";
import { listSnapshotShas, loadSnapshotManifest } from "../src/core/manifest.js";
import { resolveRagitPaths } from "../src/core/project.js";
import { runRepair } from "../src/core/repair.js";
import { rebuildStoreFromManifests } from "../src/core/store-rebuild.js";
import {
  bootstrapCanonicalStore,
  closeCanonicalStore,
  readCanonicalStoreMeta,
  writeChunksToCanonicalStore,
  writeDocumentsToCanonicalStore,
} from "../src/core/store.js";
import { acquireStoreWriteLock } from "../src/core/store-write-lock.js";

const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const createRepository = async (prefix: string): Promise<{ cwd: string; sha: string }> => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), prefix));
  git(cwd, ["init"]);
  git(cwd, ["config", "user.email", "ragit@example.com"]);
  git(cwd, ["config", "user.name", "ragit-test"]);
  await writeFile(path.join(cwd, "README.md"), "# rebuild\n\nStore rebuild contract.\n", "utf8");
  git(cwd, ["add", "."]);
  git(cwd, ["commit", "-m", "seed"]);
  await runInit(cwd, { nonInteractive: true });
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-m", "init ragit"]);
  const sha = git(cwd, ["rev-parse", "HEAD"]);
  await runIngest(cwd, { all: true, scope: "durable" });
  return { cwd, sha };
};

const manifestsBeforeAfter = async (cwd: string): Promise<Map<string, string>> => {
  const result = new Map<string, string>();
  for (const sha of await listSnapshotShas(cwd)) {
    result.set(sha, await readFile(path.join(cwd, ".ragit", "manifest", `${sha}.json`), "utf8"));
  }
  return result;
};

const logicalTree = async (cwd: string, relative = ""): Promise<Array<{ path: string; content: Buffer }>> => {
  const snapshot: Array<{ path: string; content: Buffer }> = [];
  for (const entry of (await readdir(path.join(cwd, relative), { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
    if (!relative && entry.name === ".git") continue;
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) snapshot.push(...await logicalTree(cwd, child));
    else snapshot.push({ path: child, content: await readFile(path.join(cwd, child)) });
  }
  return snapshot;
};

const storeRecords = async (cwd: string): Promise<{ documents: number; chunks: number }> => {
  const meta = await readCanonicalStoreMeta(cwd);
  if (!meta) return { documents: 0, chunks: 0 };
  const store = await bootstrapCanonicalStore(cwd, meta.embeddingContract, true);
  try {
    return {
      documents: Number(store.documents.stats.docCount),
      chunks: Number(store.chunks.stats.docCount),
    };
  } finally {
    closeCanonicalStore(store);
  }
};

const transactionFiles = async (cwd: string): Promise<string[]> => {
  try {
    return (await readdir(resolveRagitPaths(cwd).runtimeTransactionsDir)).sort();
  } catch {
    return [];
  }
};

const addReviewedArtifact = async (cwd: string): Promise<string> => {
  const materialized = await sessionMaterialize(cwd, {
    goal: "preserve artifact rebuild payload",
    relatedPaths: ["README.md"],
    createdAt: "2026-07-15T10:00:00.000Z",
    turns: [{ turnId: "turn-1", role: "user", content: "Keep this indexed artifact canonical.", createdAt: "2026-07-15T10:00:00.000Z" }],
  });
  const artifactId = materialized.artifactIds[0]!;
  await reviewArtifacts(cwd, { updates: [{ artifactId, nextStatus: "reviewed", reason: "rebuild fixture" }] });
  await runIngest(cwd, { all: true, scope: "all" });
  return artifactId;
};

describe("store rebuild", () => {
  it("plans explicitly without creating a lock or changing logical files, and default repair excludes rebuild", async () => {
    const { cwd } = await createRepository("ragit-store-rebuild-plan-");
    const before = await manifestsBeforeAfter(cwd);
    const logicalBefore = await logicalTree(cwd);

    const plan = await runRepair(cwd, { actions: ["store-rebuild"] });
    expect(plan.plannedActions).toEqual([expect.objectContaining({ action: "store-rebuild", status: "planned" })]);
    await expect(access(path.join(cwd, ".ragit", "runtime", "store-write.lock"), constants.F_OK)).rejects.toThrow();
    expect(await manifestsBeforeAfter(cwd)).toEqual(before);
    expect(await logicalTree(cwd)).toEqual(logicalBefore);

    const defaultPlan = await runRepair(cwd, {});
    expect(defaultPlan.plannedActions.some((action) => action.action === "store-rebuild")).toBe(false);
  }, 90_000);

  it("rebuilds the exact manifest union and removes source-store orphans without rewriting manifests", async () => {
    const { cwd, sha } = await createRepository("ragit-store-rebuild-union-");
    await mkdir(path.join(cwd, "docs"), { recursive: true });
    await writeFile(path.join(cwd, "docs", "second.spec.md"), "# Second\n\nUnion source of truth.\n", "utf8");
    git(cwd, ["add", "docs/second.spec.md"]);
    git(cwd, ["commit", "-m", "add second snapshot document"]);
    await runIngest(cwd, { all: true, scope: "durable" });
    const manifestBefore = await manifestsBeforeAfter(cwd);
    const manifests = await Promise.all((await listSnapshotShas(cwd)).map((entry) => loadSnapshotManifest(cwd, entry)));
    const expectedDocuments = new Set(manifests.flatMap((manifest) => manifest.docs.map((document) => document.versionId))).size;
    const expectedChunks = new Set(manifests.flatMap((manifest) => manifest.chunks.map((chunk) => chunk.id))).size;
    const meta = await readCanonicalStoreMeta(cwd);
    expect(meta).toBeTruthy();
    const source = await bootstrapCanonicalStore(cwd, meta!.embeddingContract, false);
    try {
      writeDocumentsToCanonicalStore(source, [{
        id: "orphan-document",
        versionId: "orphan-document-version",
        path: "orphan.md",
        docType: "unknown",
        commitSha: sha,
        hash: "orphan",
        sections: [],
      }]);
      writeChunksToCanonicalStore(source, [{
        id: "orphan-chunk",
        documentId: "orphan-document",
        documentVersionId: "orphan-document-version",
        sectionId: "orphan",
        sectionTitle: "orphan",
        path: "orphan.md",
        docType: "unknown",
        commitSha: sha,
        text: "orphan",
        tokenCount: 1,
        embedding: Array(meta!.embeddingContract.dimensions).fill(0),
      }]);
    } finally {
      closeCanonicalStore(source);
    }

    const result = await runRepair(cwd, { apply: true, actions: ["store-rebuild"] });
    expect(result.executedActions).toEqual([expect.objectContaining({ action: "store-rebuild", status: "executed" })]);
    expect(await storeRecords(cwd)).toEqual({ documents: expectedDocuments, chunks: expectedChunks });
    expect(await manifestsBeforeAfter(cwd)).toEqual(manifestBefore);
  }, 45_000);

  it("rebuilds durable manifests without a source store", async () => {
    const { cwd, sha } = await createRepository("ragit-store-rebuild-durable-");
    const manifest = await loadSnapshotManifest(cwd, sha);
    await rm(path.join(cwd, ".ragit", "store"), { recursive: true, force: true });

    await expect(rebuildStoreFromManifests(cwd)).resolves.toMatchObject({ documents: manifest.docs.length, chunks: manifest.chunks.length });
    expect(await storeRecords(cwd)).toEqual({ documents: manifest.docs.length, chunks: manifest.chunks.length });
  }, 45_000);

  it("rebuilds new artifact payloads without a source store and preserves legacy artifact source fallback", async () => {
    const { cwd, sha } = await createRepository("ragit-store-rebuild-artifact-");
    const artifactId = await addReviewedArtifact(cwd);
    const manifestPath = path.join(cwd, ".ragit", "manifest", `${sha}.json`);
    const withPayload = JSON.parse(await readFile(manifestPath, "utf8")) as {
      artifactEntries: Array<{ artifactId: string; rebuildPayload?: { chunks: unknown[] } }>;
    };
    const entry = withPayload.artifactEntries.find((candidate) => candidate.artifactId === artifactId);
    expect(entry?.rebuildPayload?.chunks.length).toBeGreaterThan(0);
    expect(entry?.rebuildPayload?.chunks.every((chunk) => !("embedding" in (chunk as Record<string, unknown>)))).toBe(true);
    const legacySnapshotSha = "d".repeat(40);
    const legacySnapshot = JSON.parse(JSON.stringify(withPayload)) as {
      commitSha: string;
      artifactEntries: Array<Record<string, unknown>>;
    };
    legacySnapshot.commitSha = legacySnapshotSha;
    delete legacySnapshot.artifactEntries.find((candidate) => candidate.artifactId === artifactId)!.rebuildPayload;
    await writeFile(path.join(cwd, ".ragit", "manifest", `${legacySnapshotSha}.json`), `${JSON.stringify(legacySnapshot, null, 2)}\n`, "utf8");
    await rm(path.join(cwd, ".ragit", "store"), { recursive: true, force: true });
    await expect(rebuildStoreFromManifests(cwd)).resolves.toMatchObject({ legacyChunks: 0 });

    await rm(path.join(cwd, ".ragit", "manifest", `${legacySnapshotSha}.json`));
    const sourceRestored = JSON.parse(await readFile(manifestPath, "utf8")) as { artifactEntries: Array<Record<string, unknown>> };
    const legacyEntry = sourceRestored.artifactEntries.find((candidate) => candidate.artifactId === artifactId)!;
    delete legacyEntry.rebuildPayload;
    await writeFile(manifestPath, `${JSON.stringify(sourceRestored, null, 2)}\n`, "utf8");
    await expect(rebuildStoreFromManifests(cwd)).resolves.toMatchObject({ legacyChunks: entry!.rebuildPayload!.chunks.length });
  }, 60_000);

  it("accepts a schema-1 artifact payload that omits optional chunk fields", async () => {
    const { cwd, sha } = await createRepository("ragit-store-rebuild-sparse-payload-");
    const artifactId = await addReviewedArtifact(cwd);
    const manifestPath = path.join(cwd, ".ragit", "manifest", `${sha}.json`);
    const raw = JSON.parse(await readFile(manifestPath, "utf8")) as {
      artifactEntries: Array<{ artifactId: string; rebuildPayload?: { chunks: Array<Record<string, unknown>> } }>;
    };
    const payload = raw.artifactEntries.find((entry) => entry.artifactId === artifactId)!.rebuildPayload!;
    for (const chunk of payload.chunks) {
      delete chunk.artifactKind;
      delete chunk.tier;
      delete chunk.status;
      delete chunk.authority;
      delete chunk.confidence;
      delete chunk.goalId;
      delete chunk.episodeId;
      delete chunk.sourceSessionId;
      delete chunk.bindingStatus;
      delete chunk.searchPolicy;
    }
    await writeFile(manifestPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    await rm(path.join(cwd, ".ragit", "store"), { recursive: true, force: true });

    await expect(rebuildStoreFromManifests(cwd)).resolves.toMatchObject({ legacyChunks: 0 });
  }, 60_000);

  it("keeps repeated artifact payloads stable across different snapshot heads", async () => {
    const { cwd } = await createRepository("ragit-store-rebuild-artifact-history-");
    const artifactId = await addReviewedArtifact(cwd);
    await mkdir(path.join(cwd, "docs"), { recursive: true });
    await writeFile(path.join(cwd, "docs", "later.spec.md"), "# Later\n\nA later snapshot.\n", "utf8");
    git(cwd, ["add", "docs/later.spec.md"]);
    git(cwd, ["commit", "-m", "add later snapshot"]);
    await runIngest(cwd, { all: true, scope: "all" });
    const manifests = await Promise.all((await listSnapshotShas(cwd)).map((sha) => loadSnapshotManifest(cwd, sha)));
    const payloadChunks = manifests
      .map((manifest) => manifest.artifactEntries?.find((entry) => entry.artifactId === artifactId)?.rebuildPayload?.chunks ?? [])
      .filter((chunks) => chunks.length > 0);
    expect(payloadChunks).toHaveLength(2);
    expect(payloadChunks[0]).toEqual(payloadChunks[1]);

    await rm(path.join(cwd, ".ragit", "store"), { recursive: true, force: true });
    await expect(rebuildStoreFromManifests(cwd)).resolves.toBeTruthy();
  }, 60_000);

  it("keeps legacy manifests byte-for-byte unchanged while rebuilding their durable records", async () => {
    const { cwd, sha } = await createRepository("ragit-store-rebuild-v2-");
    const manifestPath = path.join(cwd, ".ragit", "manifest", `${sha}.json`);
    const raw = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    raw.indexVersion = 2;
    delete raw.artifactEntries;
    delete raw.chunkScopes;
    await writeFile(manifestPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    const bytes = await readFile(manifestPath, "utf8");
    await rm(path.join(cwd, ".ragit", "store"), { recursive: true, force: true });

    await rebuildStoreFromManifests(cwd);
    expect(await readFile(manifestPath, "utf8")).toBe(bytes);
  }, 45_000);

  it("fails closed for a legacy artifact chunk when its source record is unavailable", async () => {
    const { cwd, sha } = await createRepository("ragit-store-rebuild-legacy-");
    const manifestPath = path.join(cwd, ".ragit", "manifest", `${sha}.json`);
    const before = await readFile(manifestPath, "utf8");
    const raw = JSON.parse(before) as { chunks: unknown[]; artifactEntries?: unknown[] };
    raw.artifactEntries = [{
      artifactId: "artifact-legacy",
      artifactScope: "session",
      kind: "note",
      tier: "working",
      status: "reviewed",
      path: ".ragit/artifacts/session/artifact-legacy.json",
      chunkIds: ["legacy-artifact-chunk"],
      searchPolicy: "searchable",
      sourceSessionId: null,
      sourceHeadSha: null,
      goalId: null,
      episodeId: null,
      bindingStatus: "bound",
    }];
    raw.artifactEntries ??= [];
    raw.chunks = [
      ...raw.chunks,
      { id: "legacy-artifact-chunk", documentId: "artifact:artifact-legacy", documentVersionId: "legacy-artifact-version" },
    ];
    await writeFile(manifestPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    const manifestBytes = await readFile(manifestPath, "utf8");
    await rm(path.join(cwd, ".ragit", "store"), { recursive: true, force: true });

    await expect(rebuildStoreFromManifests(cwd)).rejects.toMatchObject({ code: "STORE_REBUILD_UNREBUILDABLE" });
    expect(await readFile(manifestPath, "utf8")).toBe(manifestBytes);
    await expect(access(path.join(cwd, ".ragit", "store"), constants.F_OK)).rejects.toThrow();
  }, 45_000);

  it("fails closed when an artifact payload conflicts with the same chunk id", async () => {
    const { cwd, sha } = await createRepository("ragit-store-rebuild-payload-conflict-");
    const artifactId = await addReviewedArtifact(cwd);
    const manifestPath = path.join(cwd, ".ragit", "manifest", `${sha}.json`);
    const raw = JSON.parse(await readFile(manifestPath, "utf8")) as {
      artifactEntries: Array<{ artifactId: string; rebuildPayload?: { chunks: Array<Record<string, unknown>> } }>;
    };
    const entry = raw.artifactEntries.find((candidate) => candidate.artifactId === artifactId)!;
    const conflicting = JSON.parse(JSON.stringify(raw)) as typeof raw & { commitSha: string };
    conflicting.commitSha = "e".repeat(40);
    const conflictingEntry = conflicting.artifactEntries.find((candidate) => candidate.artifactId === artifactId)!;
    conflictingEntry.rebuildPayload!.chunks[0]!.text = "conflicting payload text";
    await writeFile(path.join(cwd, ".ragit", "manifest", `${conflicting.commitSha}.json`), `${JSON.stringify(conflicting, null, 2)}\n`, "utf8");
    const before = await storeRecords(cwd);

    await expect(rebuildStoreFromManifests(cwd)).rejects.toMatchObject({ code: "STORE_REBUILD_UNREBUILDABLE" });
    expect(await storeRecords(cwd)).toEqual(before);
    expect(entry.rebuildPayload?.chunks[0]?.text).not.toBe("conflicting payload text");
  }, 60_000);

  it("rejects a duplicate payload entry even when a prior manifest supplies the missing id", async () => {
    const { cwd, sha } = await createRepository("ragit-store-rebuild-payload-completeness-");
    const artifactId = await addReviewedArtifact(cwd);
    const manifestPath = path.join(cwd, ".ragit", "manifest", `${sha}.json`);
    const raw = JSON.parse(await readFile(manifestPath, "utf8")) as {
      commitSha: string;
      chunks: Array<Record<string, unknown>>;
      artifactEntries: Array<{ artifactId: string; chunkIds: string[]; rebuildPayload?: { chunks: Array<Record<string, unknown>> } }>;
    };
    const entry = raw.artifactEntries.find((candidate) => candidate.artifactId === artifactId)!;
    const firstId = entry.chunkIds[0]!;
    const firstChunk = entry.rebuildPayload!.chunks[0]!;
    const secondId = "f".repeat(40);
    const secondChunk = { ...firstChunk, id: secondId };
    const valid = JSON.parse(JSON.stringify(raw)) as typeof raw;
    valid.commitSha = "0".repeat(40);
    const validEntry = valid.artifactEntries.find((candidate) => candidate.artifactId === artifactId)!;
    validEntry.chunkIds = [firstId, secondId];
    validEntry.rebuildPayload!.chunks = [firstChunk, secondChunk];
    valid.chunks.push({ id: secondId, documentId: firstChunk.documentId, documentVersionId: firstChunk.documentVersionId });
    await writeFile(path.join(cwd, ".ragit", "manifest", `${valid.commitSha}.json`), `${JSON.stringify(valid, null, 2)}\n`, "utf8");

    const malformed = JSON.parse(JSON.stringify(valid)) as typeof valid;
    malformed.commitSha = "1".repeat(40);
    const malformedEntry = malformed.artifactEntries.find((candidate) => candidate.artifactId === artifactId)!;
    malformedEntry.rebuildPayload!.chunks = [firstChunk, { ...firstChunk }];
    await writeFile(path.join(cwd, ".ragit", "manifest", `${malformed.commitSha}.json`), `${JSON.stringify(malformed, null, 2)}\n`, "utf8");

    await expect(rebuildStoreFromManifests(cwd)).rejects.toMatchObject({ code: "STORE_REBUILD_UNREBUILDABLE" });
  }, 60_000);

  it("fails before mutation for leftover stores, propagates live lock contention, and restores the old store after promotion failure", async () => {
    const { cwd } = await createRepository("ragit-store-rebuild-swap-");
    const before = await storeRecords(cwd);
    await mkdir(path.join(cwd, ".ragit", "store.next"));
    await expect(rebuildStoreFromManifests(cwd)).rejects.toThrow(/store\.next/);
    expect(await storeRecords(cwd)).toEqual(before);
    await rm(path.join(cwd, ".ragit", "store.next"), { recursive: true, force: true });
    await mkdir(path.join(cwd, ".ragit", "store.prev"));
    await expect(rebuildStoreFromManifests(cwd)).rejects.toThrow(/store\.prev/);
    await rm(path.join(cwd, ".ragit", "store.prev"), { recursive: true, force: true });
    await symlink("missing-store", path.join(cwd, ".ragit", "store.next"));
    await expect(rebuildStoreFromManifests(cwd)).rejects.toThrow(/store\.next/);
    await rm(path.join(cwd, ".ragit", "store.next"), { force: true });

    const lock = await acquireStoreWriteLock(cwd, { command: "ingest" });
    try {
      await expect(runRepair(cwd, { apply: true, actions: ["store-rebuild"] })).rejects.toMatchObject({ code: "STORE_WRITE_BUSY" });
    } finally {
      await lock.release();
    }

    const journalsBefore = await transactionFiles(cwd);
    await expect(rebuildStoreFromManifests(cwd, {
      swap: { beforePromoteNext: () => { throw new Error("promotion fixture"); } },
    })).rejects.toMatchObject({ code: "STORE_REBUILD_PROMOTION_FAILED" });
    expect(await storeRecords(cwd)).toEqual(before);
    expect(await transactionFiles(cwd)).toEqual(journalsBefore);
    await expect(access(path.join(cwd, ".ragit", "store.next"), constants.F_OK)).rejects.toThrow();
    await expect(rebuildStoreFromManifests(cwd)).resolves.toBeTruthy();
  }, 60_000);

  it("removes only terminal completed and failed-precommit journals after a successful promotion", async () => {
    const { cwd } = await createRepository("ragit-store-rebuild-cleanup-");
    await expect(
      runIngest(cwd, { all: true, scope: "durable" }, {
        testHook: async (boundary) => {
          if (boundary === "after-manifest") throw new Error("leave finalization pending");
        },
      }),
    ).rejects.toThrow("leave finalization pending");
    const pending = (await scanIngestTransactions(cwd)).pending[0];
    expect(pending?.classification).toBe("finalization-pending");
    const failed = await createIngestTransaction(cwd, {
      targetHeadSha: "b".repeat(40),
      manifestPath: `.ragit/manifest/${"b".repeat(40)}.json`,
      documentVersionIds: [],
      chunkIds: [],
    });
    await updateIngestTransaction(cwd, failed, { status: "failed-precommit", phase: "store-written" });
    const inProgress = await createIngestTransaction(cwd, {
      targetHeadSha: "c".repeat(40),
      manifestPath: `.ragit/manifest/${"c".repeat(40)}.json`,
      documentVersionIds: [],
      chunkIds: [],
    });
    await updateIngestTransaction(cwd, inProgress, { status: "in-progress", phase: "store-written" });
    await writeFile(path.join(resolveRagitPaths(cwd).runtimeTransactionsDir, "malformed.json"), "{", "utf8");
    await symlink("malformed.json", path.join(resolveRagitPaths(cwd).runtimeTransactionsDir, "symlink.json"));
    const inconsistent = await createIngestTransaction(cwd, {
      targetHeadSha: "d".repeat(40),
      manifestPath: ".ragit/manifest/not-the-target.json",
      documentVersionIds: [],
      chunkIds: [],
    });

    await rebuildStoreFromManifests(cwd);
    const remaining = await transactionFiles(cwd);
    expect(remaining).toContain(`${pending!.transactionId}.json`);
    expect(remaining).toContain(`${inProgress.transactionId}.json`);
    expect(remaining).toContain("malformed.json");
    expect(remaining).toContain("symlink.json");
    expect(remaining).toContain(`${inconsistent.transactionId}.json`);
    expect(remaining).not.toContain(`${failed.transactionId}.json`);
    expect(remaining).toHaveLength(5);
  }, 45_000);
});
