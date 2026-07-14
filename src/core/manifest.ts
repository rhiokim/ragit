import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { isRagitOperationalError, RagitOperationalError } from "./errors.js";
import { SnapshotManifest, ChunkRecord, DocumentRecord, SnapshotChunkScopes } from "./types.js";

type SnapshotChunkInput = Pick<ChunkRecord, "id" | "documentId" | "documentVersionId">;
type SnapshotArtifactInput = NonNullable<SnapshotManifest["artifactEntries"]>[number];

export const CURRENT_MANIFEST_VERSION = 3;

const emptyScopes = (): SnapshotChunkScopes => ({
  durable: [],
  session: [],
  harness: [],
  evidence: [],
});

const manifestDir = (cwd: string): string => path.join(cwd, ".ragit", "manifest");

const manifestPath = (cwd: string, sha: string): string => path.join(manifestDir(cwd), `${sha}.json`);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOwn = (value: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const hasCode = (error: unknown, code: string): boolean =>
  error instanceof Error && "code" in error && error.code === code;

const invalidManifest = (
  sha: string,
  target: string,
  reason: string,
  cause?: unknown,
): RagitOperationalError =>
  new RagitOperationalError(
    "SNAPSHOT_MANIFEST_INVALID",
    `snapshot manifest가 유효하지 않습니다: ${sha}`,
    {
      details: { resolvedSha: sha, manifestPath: target, reason },
      recovery: { command: "ragit ingest --all" },
      cause,
    },
  );

const missingManifest = (sha: string, target: string, cause?: unknown): RagitOperationalError =>
  new RagitOperationalError(
    "SNAPSHOT_NOT_INDEXED",
    `indexed snapshot을 찾을 수 없습니다: ${sha}`,
    {
      details: { resolvedSha: sha, manifestPath: target },
      recovery: { command: "ragit ingest --all" },
      cause,
    },
  );

const unsupportedManifest = (
  sha: string,
  target: string,
  indexVersion: number,
): RagitOperationalError =>
  new RagitOperationalError(
    "SNAPSHOT_SCHEMA_UNSUPPORTED",
    `snapshot manifest schema를 지원하지 않습니다: ${indexVersion}`,
    {
      details: {
        resolvedSha: sha,
        manifestPath: target,
        indexVersion,
        supportedIndexVersion: CURRENT_MANIFEST_VERSION,
      },
      recovery: { command: "npm install --global ragit@latest" },
    },
  );

const requireNonEmptyString = (
  value: Record<string, unknown>,
  field: string,
  sha: string,
  target: string,
): string => {
  const candidate = value[field];
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw invalidManifest(sha, target, `${field} must be a non-empty string`);
  }
  return candidate;
};

const normalizeChunkScopes = (
  value: unknown,
  sha: string,
  target: string,
): SnapshotChunkScopes => {
  const normalized = emptyScopes();
  if (value === undefined) return normalized;
  if (!isRecord(value)) {
    throw invalidManifest(sha, target, "chunkScopes must be an object");
  }

  for (const scope of ["durable", "session", "harness", "evidence"] as const) {
    if (!hasOwn(value, scope)) continue;
    const chunkIds = value[scope];
    if (!Array.isArray(chunkIds) || chunkIds.some((chunkId) => typeof chunkId !== "string")) {
      throw invalidManifest(sha, target, `chunkScopes.${scope} must be an array of strings`);
    }
    normalized[scope] = chunkIds;
  }
  return normalized;
};

const normalizeManifest = (
  value: unknown,
  sha: string,
  target: string,
): SnapshotManifest => {
  if (!isRecord(value)) {
    throw invalidManifest(sha, target, "manifest root must be an object");
  }

  const commitSha = requireNonEmptyString(value, "commitSha", sha, target);
  if (!hasOwn(value, "parentSha") || (value.parentSha !== null && typeof value.parentSha !== "string")) {
    throw invalidManifest(sha, target, "parentSha must be a string or null");
  }
  requireNonEmptyString(value, "createdAt", sha, target);
  if (!Number.isInteger(value.indexVersion) || (value.indexVersion as number) < 1) {
    throw invalidManifest(sha, target, "indexVersion must be a positive integer");
  }
  if (commitSha !== sha) {
    throw invalidManifest(sha, target, `commitSha does not match filename: ${commitSha}`);
  }

  const indexVersion = value.indexVersion as number;
  if (indexVersion > CURRENT_MANIFEST_VERSION) {
    throw unsupportedManifest(sha, target, indexVersion);
  }
  if (!Array.isArray(value.docs)) {
    throw invalidManifest(sha, target, "docs must be an array");
  }
  if (!Array.isArray(value.chunks)) {
    throw invalidManifest(sha, target, "chunks must be an array");
  }
  for (const chunk of value.chunks) {
    if (
      !isRecord(chunk) ||
      typeof chunk.id !== "string" ||
      typeof chunk.documentId !== "string" ||
      typeof chunk.documentVersionId !== "string"
    ) {
      throw invalidManifest(sha, target, "chunks entries must contain string ids");
    }
  }

  const manifest = value as unknown as SnapshotManifest;
  if (indexVersion < CURRENT_MANIFEST_VERSION) {
    return {
      ...manifest,
      indexVersion: CURRENT_MANIFEST_VERSION,
      artifactEntries: [],
      chunkScopes: {
        ...emptyScopes(),
        durable: manifest.chunks.map((chunk) => chunk.id),
      },
    };
  }

  if (value.artifactEntries !== undefined && !Array.isArray(value.artifactEntries)) {
    throw invalidManifest(sha, target, "artifactEntries must be an array");
  }

  return {
    ...manifest,
    indexVersion: CURRENT_MANIFEST_VERSION,
    artifactEntries: (value.artifactEntries as SnapshotManifest["artifactEntries"] | undefined) ?? [],
    chunkScopes: normalizeChunkScopes(value.chunkScopes, sha, target),
  };
};

export const buildSnapshotManifest = (
  commitSha: string,
  parentSha: string | null,
  docs: DocumentRecord[],
  chunks: SnapshotChunkInput[],
  options: {
    artifactEntries?: SnapshotArtifactInput[];
    chunkScopes?: Partial<SnapshotChunkScopes>;
  } = {},
): SnapshotManifest => ({
  commitSha,
  parentSha,
  createdAt: new Date().toISOString(),
  indexVersion: CURRENT_MANIFEST_VERSION,
  docs,
  chunks: chunks.map((chunk) => ({
    id: chunk.id,
    documentId: chunk.documentId,
    documentVersionId: chunk.documentVersionId,
  })),
  artifactEntries: options.artifactEntries ?? [],
  chunkScopes: {
    ...emptyScopes(),
    durable: options.chunkScopes?.durable ?? chunks.map((chunk) => chunk.id),
    session: options.chunkScopes?.session ?? [],
    harness: options.chunkScopes?.harness ?? [],
    evidence: options.chunkScopes?.evidence ?? [],
  },
});

export const listSnapshotShas = async (cwd: string): Promise<string[]> => {
  try {
    const entries = await readdir(manifestDir(cwd), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.length > ".json".length && entry.name.endsWith(".json"))
      .map((entry) => entry.name.slice(0, -".json".length))
      .sort((a, b) => a.localeCompare(b));
  } catch (error) {
    if (hasCode(error, "ENOENT")) return [];
    throw error;
  }
};

export const snapshotManifestExists = async (cwd: string, sha: string): Promise<boolean> => {
  try {
    return (await stat(manifestPath(cwd, sha))).isFile();
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
};

export const writeSnapshotManifest = async (cwd: string, manifest: SnapshotManifest): Promise<void> => {
  const directory = manifestDir(cwd);
  const target = manifestPath(cwd, manifest.commitSha);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
};

export const loadSnapshotManifest = async (cwd: string, sha: string): Promise<SnapshotManifest> => {
  const target = manifestPath(cwd, sha);
  let content: string;
  try {
    content = await readFile(target, "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) throw missingManifest(sha, target, error);
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw invalidManifest(sha, target, "manifest is not valid JSON", error);
  }
  return normalizeManifest(parsed, sha, target);
};

export const loadSnapshotManifestIfExists = async (
  cwd: string,
  sha: string | null | undefined,
): Promise<SnapshotManifest | null> => {
  if (!sha) return null;
  try {
    return await loadSnapshotManifest(cwd, sha);
  } catch (error) {
    if (isRagitOperationalError(error) && error.code === "SNAPSHOT_NOT_INDEXED") return null;
    throw error;
  }
};

// Diagnostic callers only. Retrieval and ingest policy must never select snapshots by recency.
export const latestSnapshotSha = async (cwd: string): Promise<string | null> => {
  const snapshots = await listSnapshotShas(cwd);
  return snapshots.at(-1) ?? null;
};

export const resolveSnapshotRef = async (cwd: string, ref: string): Promise<string> => {
  const snapshots = await listSnapshotShas(cwd);
  if (snapshots.includes(ref)) return ref;
  const byPrefix = snapshots.filter((sha) => sha.startsWith(ref));
  if (byPrefix.length === 1) return byPrefix[0];
  if (byPrefix.length > 1) {
    throw new Error(`snapshot ref가 모호합니다: ${ref}`);
  }
  throw new Error(`snapshot을 찾을 수 없습니다: ${ref}`);
};
