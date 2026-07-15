import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { isRagitOperationalError } from "./errors.js";
import {
  IngestTransactionJournal,
  isSafeIngestTransactionId,
  readIngestTransaction,
} from "./ingest-transaction.js";
import { loadSnapshotManifest } from "./manifest.js";
import { resolveRagitPaths } from "./project.js";
import { SnapshotManifest } from "./types.js";

export type IngestTransactionClassification =
  | "completed"
  | "precommit-incomplete"
  | "finalization-pending"
  | "inconsistent"
  | "invalid";

export interface IngestTransactionDiagnostic {
  transactionId: string;
  classification: IngestTransactionClassification;
  status?: IngestTransactionJournal["status"];
  phase?: IngestTransactionJournal["phase"];
  targetHeadSha?: string;
  updatedAt?: string;
  lastError?: IngestTransactionJournal["lastError"];
  detail?: string;
}

export interface IngestTransactionDiagnostics {
  transactions: IngestTransactionDiagnostic[];
  summary: {
    completed: number;
    precommitIncomplete: number;
    finalizationPending: number;
    inconsistent: number;
    invalid: number;
  };
  pending: IngestTransactionDiagnostic[];
  lastCompleted: IngestTransactionDiagnostic | null;
}

export const isFullGitObjectId = (value: string): boolean => /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(value);

export const expectedIngestManifestPath = (headSha: string): string => `.ragit/manifest/${headSha}.json`;

const incompletePrecommitPhase = (phase: IngestTransactionJournal["phase"]): boolean =>
  phase === "prepared" || phase === "store-written" || phase === "store-verified";

const fromJournal = (
  journal: IngestTransactionJournal,
  classification: IngestTransactionClassification,
  detail?: string,
): IngestTransactionDiagnostic => ({
  transactionId: journal.transactionId,
  classification,
  status: journal.status,
  phase: journal.phase,
  targetHeadSha: journal.targetHeadSha,
  updatedAt: journal.updatedAt,
  ...(journal.lastError === undefined ? {} : { lastError: journal.lastError }),
  ...(detail === undefined ? {} : { detail }),
});

const manifestMismatch = (journal: IngestTransactionJournal, manifest: SnapshotManifest): string | null => {
  const documentVersionIds = new Set(manifest.docs.map((document) => document.versionId));
  if (journal.documentVersionIds.some((id) => !documentVersionIds.has(id))) {
    return "manifest is missing a journal document version";
  }
  const chunkIds = new Set(manifest.chunks.map((chunk) => chunk.id));
  if (journal.chunkIds.some((id) => !chunkIds.has(id))) {
    return "manifest is missing a journal chunk";
  }
  if (
    journal.finalization?.plannedArtifactIds.some(
      (artifactId) => !manifest.artifactEntries?.some((entry) => entry.artifactId === artifactId && entry.bindingStatus === "bound"),
    )
  ) {
    return "manifest is missing a projected bound artifact";
  }
  return null;
};

const classifyJournal = async (cwd: string, journal: IngestTransactionJournal): Promise<IngestTransactionDiagnostic> => {
  if (
    !isFullGitObjectId(journal.targetHeadSha) ||
    journal.manifestPath !== expectedIngestManifestPath(journal.targetHeadSha)
  ) {
    return fromJournal(journal, "inconsistent", "journal lacks a safe manifest target");
  }
  try {
    const manifest = await loadSnapshotManifest(cwd, journal.targetHeadSha);
    const mismatch = manifestMismatch(journal, manifest);
    if (mismatch) return fromJournal(journal, "inconsistent", mismatch);
    if (journal.status === "completed") {
      return journal.phase === "completed"
        ? fromJournal(journal, "completed")
        : fromJournal(journal, "inconsistent", "completed journal has a non-completed phase");
    }
    if (!journal.finalization) {
      return fromJournal(journal, "inconsistent", "journal lacks a finalization payload");
    }
    return fromJournal(journal, "finalization-pending");
  } catch (error) {
    if (
      isRagitOperationalError(error) &&
      error.code === "SNAPSHOT_NOT_INDEXED" &&
      (journal.status === "failed-precommit" || journal.status === "in-progress") &&
      incompletePrecommitPhase(journal.phase)
    ) {
      return fromJournal(journal, "precommit-incomplete");
    }
    return fromJournal(journal, "inconsistent", "manifest commit truth could not be verified");
  }
};

const invalidDiagnostic = (transactionId: string, detail: string): IngestTransactionDiagnostic => ({
  transactionId,
  classification: "invalid",
  detail,
});

export const scanIngestTransactions = async (cwd: string): Promise<IngestTransactionDiagnostics> => {
  const directory = resolveRagitPaths(cwd).runtimeTransactionsDir;
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return {
        transactions: [],
        summary: { completed: 0, precommitIncomplete: 0, finalizationPending: 0, inconsistent: 0, invalid: 0 },
        pending: [],
        lastCompleted: null,
      };
    }
    return {
      transactions: [invalidDiagnostic("<transactions>", "transaction directory is unreadable")],
      summary: { completed: 0, precommitIncomplete: 0, finalizationPending: 0, inconsistent: 0, invalid: 1 },
      pending: [],
      lastCompleted: null,
    };
  }

  const transactions: IngestTransactionDiagnostic[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.name.endsWith(".json")) continue;
    const transactionId = entry.name.slice(0, -".json".length);
    if (!isSafeIngestTransactionId(transactionId)) {
      transactions.push(invalidDiagnostic(entry.name, "unsafe transaction journal filename"));
      continue;
    }
    const target = path.join(directory, entry.name);
    try {
      const metadata = await lstat(target);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        transactions.push(invalidDiagnostic(transactionId, "transaction journal must be a regular file"));
        continue;
      }
      const journal = await readIngestTransaction(cwd, transactionId);
      if (!journal || journal.transactionId !== transactionId) {
        transactions.push(invalidDiagnostic(transactionId, "transaction filename does not match journal id"));
        continue;
      }
      transactions.push(await classifyJournal(cwd, journal));
    } catch {
      transactions.push(invalidDiagnostic(transactionId, "transaction journal is malformed or unreadable"));
    }
  }

  const summary = {
    completed: 0,
    precommitIncomplete: 0,
    finalizationPending: 0,
    inconsistent: 0,
    invalid: 0,
  };
  for (const transaction of transactions) {
    if (transaction.classification === "precommit-incomplete") summary.precommitIncomplete += 1;
    else if (transaction.classification === "finalization-pending") summary.finalizationPending += 1;
    else summary[transaction.classification] += 1;
  }
  const completed = transactions
    .filter((transaction) => transaction.classification === "completed")
    .sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "") || left.transactionId.localeCompare(right.transactionId));
  return {
    transactions,
    summary,
    pending: transactions.filter((transaction) => transaction.classification === "finalization-pending"),
    lastCompleted: completed[0] ?? null,
  };
};
