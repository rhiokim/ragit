import { bindPlannedArtifacts } from "./artifacts.js";
import { appendLedgerEvent } from "./event-ledger.js";
import {
  failIngestTransaction,
  IngestTransactionJournal,
  readIngestTransaction,
  updateIngestTransaction,
} from "./ingest-transaction.js";
import { expectedIngestManifestPath, isFullGitObjectId } from "./ingest-recovery.js";
import { loadSnapshotManifest } from "./manifest.js";
import { RAGIT_VERSION } from "./version.js";

export type IngestFinalizationTestBoundary = "after-artifacts-finalized" | "after-ledger-appended";

export interface FinalizeIngestTransactionDependencies {
  testHook?: (boundary: IngestFinalizationTestBoundary, transaction: IngestTransactionJournal) => Promise<void> | void;
}

export interface FinalizeIngestTransactionResult {
  transaction: IngestTransactionJournal;
  boundArtifactIds: string[];
}

const finalizationPayload = (journal: IngestTransactionJournal) => {
  if (!journal.finalization) {
    throw new Error("ingest transaction cannot finalize without finalization payload");
  }
  if (!isFullGitObjectId(journal.targetHeadSha)) {
    throw new Error("ingest transaction cannot finalize with an invalid target HEAD");
  }
  if (journal.manifestPath !== expectedIngestManifestPath(journal.targetHeadSha)) {
    throw new Error("ingest transaction cannot finalize with an unexpected manifest path");
  }
  return journal.finalization;
};

const appendIngestCompletedEvent = async (
  cwd: string,
  journal: IngestTransactionJournal,
): Promise<void> => {
  const finalization = finalizationPayload(journal);
  await appendLedgerEvent(cwd, {
    eventType: "ingest.completed",
    recordedAt: finalization.recordedAt,
    goalId: null,
    episodeId: null,
    sessionId: null,
    sourceHeadSha: journal.targetHeadSha,
    summary: `Ingested ${finalization.processed} document${finalization.processed === 1 ? "" : "s"} into ${finalization.scope} scope`,
    artifactIds: finalization.plannedArtifactIds,
    relatedPaths: finalization.plannedFiles,
    provenance: {
      actor: "assistant",
      producer: "ragit",
      producerVersion: RAGIT_VERSION,
      operation: "ingest.completed",
      inputRefs: finalization.plannedFiles,
      outputRefs: [journal.manifestPath],
      evidenceRefs: [],
      contentHash: `${journal.targetHeadSha}:${finalization.processed}:${finalization.scope}:${journal.manifestPath}`,
    },
  });
};

export const finalizeIngestTransaction = async (
  cwd: string,
  transactionId: string,
  dependencies: FinalizeIngestTransactionDependencies = {},
): Promise<FinalizeIngestTransactionResult> => {
  const initial = await readIngestTransaction(cwd, transactionId);
  if (!initial) throw new Error(`ingest transaction was not found: ${transactionId}`);
  if (initial.status === "completed") {
    return {
      transaction: initial,
      boundArtifactIds: initial.finalization?.plannedArtifactIds ?? [],
    };
  }
  const finalization = finalizationPayload(initial);
  let transaction = initial;
  try {
    await loadSnapshotManifest(cwd, transaction.targetHeadSha);
    if (
      transaction.phase === "prepared" ||
      transaction.phase === "store-written" ||
      transaction.phase === "store-verified"
    ) {
      transaction = await updateIngestTransaction(cwd, transaction, { phase: "manifest-committed" });
    }
    const boundArtifactIds = await bindPlannedArtifacts(
      cwd,
      transaction.targetHeadSha,
      finalization.recordedAt,
      finalization.plannedArtifactBindings,
    );
    transaction = await updateIngestTransaction(cwd, transaction, { phase: "artifacts-finalized" });
    await dependencies.testHook?.("after-artifacts-finalized", transaction);
    await appendIngestCompletedEvent(cwd, transaction);
    await dependencies.testHook?.("after-ledger-appended", transaction);
    transaction = await updateIngestTransaction(cwd, transaction, { phase: "ledger-finalized" });
    transaction = await updateIngestTransaction(cwd, transaction, {
      status: "completed",
      phase: "completed",
      lastError: undefined,
    });
    return { transaction, boundArtifactIds };
  } catch (error) {
    await failIngestTransaction(cwd, transaction, error);
    throw error;
  }
};
