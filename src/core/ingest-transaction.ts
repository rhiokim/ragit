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
  lastError?: IngestTransactionLastError;
}

export interface CreateIngestTransactionInput {
  targetHeadSha: string;
  baseSha?: string | null;
  manifestPath: string;
  documentVersionIds: string[];
  chunkIds: string[];
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

const isPhase = (value: unknown): value is IngestTransactionPhase =>
  value === "prepared" ||
  value === "store-written" ||
  value === "store-verified" ||
  value === "manifest-committed" ||
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
  if (lastError === null) return null;
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
    status: journal.phase === "manifest-committed" ? "failed-postcommit" : "failed-precommit",
    lastError: ingestTransactionError(error),
  });
