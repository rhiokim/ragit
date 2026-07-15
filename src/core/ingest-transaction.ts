import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveRagitPaths } from "./project.js";

export const INGEST_TRANSACTION_SCHEMA_VERSION = 1;

export type IngestTransactionPhase =
  | "prepared"
  | "store-written"
  | "store-verified"
  | "manifest-committed"
  | "artifacts-finalized"
  | "ledger-finalized"
  | "completed";

export type IngestTransactionStatus =
  | "in-progress"
  | "failed-precommit"
  | "failed-postcommit"
  | "completed";

export interface IngestTransactionLastError {
  name: string;
  message: string;
  code?: string;
}

export interface IngestTransactionArtifactBinding {
  artifactId: string;
  updatedAt: string;
}

export interface IngestTransactionFinalization {
  recordedAt: string;
  processed: number;
  scope: "durable" | "all";
  plannedFiles: string[];
  plannedArtifactIds: string[];
  plannedArtifactBindings: IngestTransactionArtifactBinding[];
}

export interface IngestTransactionJournal {
  schemaVersion: number;
  transactionId: string;
  kind: "ingest";
  status: IngestTransactionStatus;
  phase: IngestTransactionPhase;
  targetHeadSha: string;
  baseSha?: string;
  manifestPath: string;
  startedAt: string;
  updatedAt: string;
  documentVersionIds: string[];
  chunkIds: string[];
  finalization?: IngestTransactionFinalization;
  lastError?: IngestTransactionLastError;
}

export interface CreateIngestTransactionInput {
  targetHeadSha: string;
  baseSha?: string | null;
  manifestPath: string;
  documentVersionIds: string[];
  chunkIds: string[];
  finalization?: IngestTransactionFinalization;
}

export interface IngestTransactionUpdate {
  status?: IngestTransactionStatus;
  phase?: IngestTransactionPhase;
  lastError?: IngestTransactionLastError;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isNonEmptyString);

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const isCanonicalUtcTimestamp = (value: unknown): value is string => {
  if (!isNonEmptyString(value)) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
};

const isPhase = (value: unknown): value is IngestTransactionPhase =>
  value === "prepared" ||
  value === "store-written" ||
  value === "store-verified" ||
  value === "manifest-committed" ||
  value === "artifacts-finalized" ||
  value === "ledger-finalized" ||
  value === "completed";

const isStatus = (value: unknown): value is IngestTransactionStatus =>
  value === "in-progress" ||
  value === "failed-precommit" ||
  value === "failed-postcommit" ||
  value === "completed";

const parseLastError = (value: unknown): IngestTransactionLastError | null | undefined => {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !isNonEmptyString(value.name) || !isNonEmptyString(value.message)) return null;
  if (value.code !== undefined && !isNonEmptyString(value.code)) return null;
  return {
    name: value.name,
    message: value.message,
    ...(typeof value.code === "string" ? { code: value.code } : {}),
  };
};

const parseFinalization = (value: unknown): IngestTransactionFinalization | null | undefined => {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  const plannedFiles = value.plannedFiles;
  const plannedArtifactIds = value.plannedArtifactIds;
  const plannedArtifactBindingsValue = value.plannedArtifactBindings;
  if (
    !isCanonicalUtcTimestamp(value.recordedAt) ||
    !isNonNegativeInteger(value.processed) ||
    (value.scope !== "durable" && value.scope !== "all") ||
    !isStringArray(plannedFiles) ||
    !isStringArray(plannedArtifactIds) ||
    !Array.isArray(plannedArtifactBindingsValue)
  ) {
    return null;
  }
  const plannedArtifactBindings: IngestTransactionArtifactBinding[] = [];
  for (const binding of plannedArtifactBindingsValue) {
    if (!isRecord(binding) || !isNonEmptyString(binding.artifactId) || !isNonEmptyString(binding.updatedAt)) {
      return null;
    }
    plannedArtifactBindings.push({ artifactId: binding.artifactId, updatedAt: binding.updatedAt });
  }
  if (
    plannedArtifactBindings.length !== plannedArtifactIds.length ||
    new Set(plannedArtifactIds).size !== plannedArtifactIds.length ||
    plannedArtifactBindings.some((binding, index) => binding.artifactId !== plannedArtifactIds[index])
  ) {
    return null;
  }
  return {
    recordedAt: value.recordedAt,
    processed: value.processed,
    scope: value.scope,
    plannedFiles,
    plannedArtifactIds,
    plannedArtifactBindings,
  };
};

export const parseIngestTransactionJournal = (value: unknown): IngestTransactionJournal | null => {
  if (!isRecord(value)) return null;
  if (
    value.schemaVersion !== INGEST_TRANSACTION_SCHEMA_VERSION ||
    !isNonEmptyString(value.transactionId) ||
    value.kind !== "ingest" ||
    !isStatus(value.status) ||
    !isPhase(value.phase) ||
    !isNonEmptyString(value.targetHeadSha) ||
    (value.baseSha !== undefined && !isNonEmptyString(value.baseSha)) ||
    !isNonEmptyString(value.manifestPath) ||
    !isNonEmptyString(value.startedAt) ||
    !isNonEmptyString(value.updatedAt) ||
    !isStringArray(value.documentVersionIds) ||
    !isStringArray(value.chunkIds)
  ) {
    return null;
  }
  const lastError = parseLastError(value.lastError);
  const finalization = parseFinalization(value.finalization);
  if (lastError === null || finalization === null) return null;
  return {
    schemaVersion: value.schemaVersion,
    transactionId: value.transactionId,
    kind: "ingest",
    status: value.status,
    phase: value.phase,
    targetHeadSha: value.targetHeadSha,
    ...(typeof value.baseSha === "string" ? { baseSha: value.baseSha } : {}),
    manifestPath: value.manifestPath,
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
    documentVersionIds: value.documentVersionIds,
    chunkIds: value.chunkIds,
    ...(finalization === undefined ? {} : { finalization }),
    ...(lastError === undefined ? {} : { lastError }),
  };
};

const transactionPath = (cwd: string, transactionId: string): string =>
  path.join(resolveRagitPaths(cwd).runtimeTransactionsDir, `${transactionId}.json`);

const serialized = (journal: IngestTransactionJournal): string => `${JSON.stringify(journal, null, 2)}\n`;

const writeNewTransaction = async (cwd: string, journal: IngestTransactionJournal): Promise<void> => {
  const paths = resolveRagitPaths(cwd);
  await mkdir(paths.runtimeTransactionsDir, { recursive: true });
  await writeFile(transactionPath(cwd, journal.transactionId), serialized(journal), { encoding: "utf8", flag: "wx" });
};

const writeUpdatedTransaction = async (cwd: string, journal: IngestTransactionJournal): Promise<void> => {
  const target = transactionPath(cwd, journal.transactionId);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, serialized(journal), { encoding: "utf8", flag: "wx" });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
};

export const createIngestTransaction = async (
  cwd: string,
  input: CreateIngestTransactionInput,
): Promise<IngestTransactionJournal> => {
  const recordedAt = new Date().toISOString();
  const journal: IngestTransactionJournal = {
    schemaVersion: INGEST_TRANSACTION_SCHEMA_VERSION,
    transactionId: randomUUID(),
    kind: "ingest",
    status: "in-progress",
    phase: "prepared",
    targetHeadSha: input.targetHeadSha,
    ...(input.baseSha ? { baseSha: input.baseSha } : {}),
    manifestPath: input.manifestPath,
    startedAt: recordedAt,
    updatedAt: recordedAt,
    documentVersionIds: input.documentVersionIds,
    chunkIds: input.chunkIds,
    ...(input.finalization === undefined ? {} : { finalization: input.finalization }),
  };
  await writeNewTransaction(cwd, journal);
  return journal;
};

export const readIngestTransaction = async (
  cwd: string,
  transactionId: string,
): Promise<IngestTransactionJournal | null> => {
  let content: string;
  try {
    content = await readFile(transactionPath(cwd, transactionId), "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  const parsed = parseIngestTransactionJournal(JSON.parse(content));
  if (parsed === null) throw new Error(`ingest transaction journal is invalid: ${transactionId}`);
  return parsed;
};

export const updateIngestTransaction = async (
  cwd: string,
  journal: IngestTransactionJournal,
  update: IngestTransactionUpdate,
): Promise<IngestTransactionJournal> => {
  const next: IngestTransactionJournal = {
    ...journal,
    ...update,
    updatedAt: new Date().toISOString(),
  };
  await writeUpdatedTransaction(cwd, next);
  return next;
};

export const ingestTransactionError = (error: unknown): IngestTransactionLastError => {
  const code = typeof error === "object" && error !== null && "code" in error && isNonEmptyString(error.code)
    ? error.code
    : undefined;
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(code === undefined ? {} : { code }),
    };
  }
  return {
    name: "Error",
    message: String(error),
    ...(code === undefined ? {} : { code }),
  };
};

export const failIngestTransaction = async (
  cwd: string,
  journal: IngestTransactionJournal,
  error: unknown,
): Promise<IngestTransactionJournal> =>
  updateIngestTransaction(cwd, journal, {
    status:
      journal.phase === "manifest-committed" ||
      journal.phase === "artifacts-finalized" ||
      journal.phase === "ledger-finalized"
        ? "failed-postcommit"
        : "failed-precommit",
    lastError: ingestTransactionError(error),
  });
