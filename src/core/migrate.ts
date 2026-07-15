import { createHash } from "node:crypto";
import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { embedTexts, resolveEmbeddingProfile, toEmbeddingContract } from "./embedding.js";
import { loadConfig } from "./config.js";
import { getHeadSha, getParentSha } from "./git.js";
import { chunkVersionId, documentIdFromPath, documentVersionId } from "./identity.js";
import { buildSnapshotManifest, loadSnapshotManifest, writeSnapshotManifest } from "./manifest.js";
import { ensureRagitStructure } from "./project.js";
import { loadLegacyStore, legacyStorePath } from "./legacy-store.js";
import {
  bootstrapCanonicalStore,
  bootstrapCanonicalStoreAtPath,
  closeCanonicalStore,
  openCanonicalStoreWithContract,
  readCanonicalStoreMeta,
  writeChunksToCanonicalStore,
  writeDocumentsToCanonicalStore,
} from "./store.js";
import { withStoreWriteLock } from "./store-write-lock.js";
import { assertStoreSwapReady, promoteNextStore, removeNextStore, storeSwapPaths } from "./store-swap.js";
import { ChunkRecord, DocumentRecord, DocType, normalizeKnownDocType } from "./types.js";

interface SqliteVssExport {
  docs: Array<{
    id?: string;
    path: string;
    docType?: string;
    hash?: string;
    sections?: Array<{ id: string; title: string; level: number; content: string }>;
  }>;
  chunks: Array<{
    id?: string;
    documentId?: string;
    path: string;
    sectionId?: string;
    sectionTitle?: string;
    text: string;
    tokenCount?: number;
    embedding?: number[];
    docType?: string;
  }>;
}

const candidatePaths = [
  ".ragit/sqlite-vss/export.json",
  ".ragit/sqlite-vss/records.json",
  ".ragit/sqlite_vss/export.json",
];

const loadLegacyPayload = async (cwd: string): Promise<SqliteVssExport> => {
  for (const candidate of candidatePaths) {
    const target = path.join(cwd, candidate);
    try {
      const content = await readFile(target, "utf8");
      return JSON.parse(content) as SqliteVssExport;
    } catch {
      continue;
    }
  }
  throw new Error("sqlite-vss export 파일을 찾을 수 없습니다.");
};

export interface MigrationSummary {
  mode: "dry-run" | "apply";
  docs: number;
  chunks: number;
  snapshotSha?: string;
}

export interface EmbeddingMigrationSummary {
  mode: "dry-run" | "apply";
  currentContract: {
    provider: string;
    dimensions: number;
    version: string;
    schemaVersion: number;
  } | null;
  targetContract: {
    provider: string;
    dimensions: number;
    version: string;
  };
  manifests: number;
  documents: number;
  chunks: number;
  migrationNeeded: boolean;
}

const coerceLegacyDocType = (value?: string): DocType =>
  normalizeKnownDocType(value) ?? "unknown";

const vectorToNumbers = (value: unknown): number[] => {
  if (Array.isArray(value)) return value.map((item) => Number(item));
  if (value && typeof value === "object" && "length" in value) {
    return Array.from(value as ArrayLike<number>, (item) => Number(item));
  }
  return [];
};

const optionalString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const collectManifestDocumentsAndChunkIds = async (
  cwd: string,
): Promise<{ manifests: number; documents: DocumentRecord[]; chunkIds: string[] }> => {
  const manifestDir = path.join(cwd, ".ragit", "manifest");
  const manifestFiles = (await readdir(manifestDir)).filter((name) => name.endsWith(".json")).sort();
  const documentsByVersionId = new Map<string, DocumentRecord>();
  const chunkIds = new Set<string>();
  for (const fileName of manifestFiles) {
    const manifest = await loadSnapshotManifest(cwd, fileName.replace(/\.json$/, ""));
    for (const document of manifest.docs) {
      documentsByVersionId.set(document.versionId, document);
    }
    for (const chunk of manifest.chunks) {
      chunkIds.add(chunk.id);
    }
  }
  return {
    manifests: manifestFiles.length,
    documents: Array.from(documentsByVersionId.values()),
    chunkIds: Array.from(chunkIds),
  };
};

const hydrateFetchedChunk = (raw: {
  id: string;
  vectors: Record<string, unknown>;
  fields: Record<string, unknown>;
}): ChunkRecord => ({
  id: raw.id,
  documentId: String(raw.fields.documentId),
  documentVersionId: String(raw.fields.documentVersionId),
  sectionId: String(raw.fields.sectionId),
  sectionTitle: String(raw.fields.sectionTitle),
  path: String(raw.fields.path),
  docType: String(raw.fields.docType) as ChunkRecord["docType"],
  commitSha: String(raw.fields.commitSha),
  text: String(raw.fields.text),
  tokenCount: Number(raw.fields.tokenCount),
  embedding: vectorToNumbers(raw.vectors.embedding),
  originType: (optionalString(raw.fields.originType) ?? undefined) as "document" | "artifact" | undefined,
  artifactId: optionalString(raw.fields.artifactId),
  artifactKind: optionalString(raw.fields.artifactKind) as ChunkRecord["artifactKind"] | null,
  tier: optionalString(raw.fields.tier) as ChunkRecord["tier"] | null,
  status: optionalString(raw.fields.status) as ChunkRecord["status"] | null,
  authority: optionalString(raw.fields.authority) as ChunkRecord["authority"] | null,
  confidence: typeof raw.fields.confidence === "number" && raw.fields.confidence >= 0 ? raw.fields.confidence : null,
  goalId: optionalString(raw.fields.goalId),
  episodeId: optionalString(raw.fields.episodeId),
  sourceSessionId: optionalString(raw.fields.sourceSessionId),
  bindingStatus: optionalString(raw.fields.bindingStatus) as ChunkRecord["bindingStatus"] | null,
  searchPolicy: optionalString(raw.fields.searchPolicy) as ChunkRecord["searchPolicy"] | null,
});

const migrateEmbeddingsUnlocked = async (cwd: string, dryRun: boolean): Promise<EmbeddingMigrationSummary> => {
  await ensureRagitStructure(cwd);
  const config = await loadConfig(cwd);
  const targetProfile = resolveEmbeddingProfile(config);
  const targetContract = toEmbeddingContract(targetProfile);
  const currentMeta = await readCanonicalStoreMeta(cwd);
  if (!currentMeta) {
    throw new Error("현재 canonical store meta를 찾을 수 없습니다. 먼저 ragit init 또는 ragit ingest를 실행해 주세요.");
  }

  const collected = await collectManifestDocumentsAndChunkIds(cwd);
  const migrationNeeded =
    currentMeta.embeddingContract.provider !== targetContract.provider ||
    currentMeta.embeddingContract.dimensions !== targetContract.dimensions ||
    currentMeta.embeddingContract.version !== targetContract.version;

  const summary: EmbeddingMigrationSummary = {
    mode: dryRun ? "dry-run" : "apply",
    currentContract: {
      provider: currentMeta.embeddingContract.provider,
      dimensions: currentMeta.embeddingContract.dimensions,
      version: currentMeta.embeddingContract.version,
      schemaVersion: currentMeta.schemaVersion,
    },
    targetContract,
    manifests: collected.manifests,
    documents: collected.documents.length,
    chunks: collected.chunkIds.length,
    migrationNeeded,
  };
  if (dryRun || !migrationNeeded) {
    return summary;
  }

  const sourceStore = await openCanonicalStoreWithContract(cwd, currentMeta.embeddingContract, true);
  const nextStoreDir = storeSwapPaths(cwd).next;
  try {
    await assertStoreSwapReady(cwd);
  } catch (error) {
    closeCanonicalStore(sourceStore);
    throw error;
  }

  try {
    const fetched = sourceStore.chunks.fetchSync(collected.chunkIds);
    if (Object.keys(fetched).length !== collected.chunkIds.length) {
      const missing = collected.chunkIds.filter((chunkId) => !(chunkId in fetched));
      throw new Error(`manifest가 참조하는 chunk를 source store에서 찾을 수 없습니다: ${missing[0] ?? "unknown"}`);
    }
    const sourceChunks = collected.chunkIds.map((chunkId) => hydrateFetchedChunk(fetched[chunkId]));
    const embeddings = await embedTexts(
      sourceChunks.map((chunk) => chunk.text),
      targetProfile,
      { cwd, cacheMode: "readwrite" },
    );
    const targetChunks = sourceChunks.map((chunk, index) => ({
      ...chunk,
      embedding: embeddings[index] ?? [],
    }));

    const tempStore = await bootstrapCanonicalStoreAtPath(cwd, targetContract, false, nextStoreDir);
    try {
      writeDocumentsToCanonicalStore(tempStore, collected.documents);
      writeChunksToCanonicalStore(tempStore, targetChunks);
    } finally {
      closeCanonicalStore(tempStore);
    }
  } catch (error) {
    await rm(nextStoreDir, { recursive: true, force: true });
    throw error;
  } finally {
    closeCanonicalStore(sourceStore);
  }

  try {
    await promoteNextStore(cwd);
  } catch (error) {
    await removeNextStore(cwd);
    throw error;
  }

  return {
    ...summary,
    mode: "apply",
  };
};

const migrateFromSqliteVssUnlocked = async (cwd: string, dryRun: boolean): Promise<MigrationSummary> => {
  await ensureRagitStructure(cwd);
  const payload = await loadLegacyPayload(cwd);
  if (dryRun) {
    return {
      mode: "dry-run",
      docs: payload.docs?.length ?? 0,
      chunks: payload.chunks?.length ?? 0,
    };
  }
  const config = await loadConfig(cwd);
  const embeddingProfile = resolveEmbeddingProfile(config);
  const sha = await getHeadSha(cwd);
  const parentSha = await getParentSha(cwd);
  const store = await bootstrapCanonicalStore(cwd, toEmbeddingContract(embeddingProfile), false);
  const docs = new Map<string, DocumentRecord>();
  for (const rawDoc of payload.docs ?? []) {
    const repoPath = rawDoc.path.replaceAll(path.sep, "/");
    const logicalId = documentIdFromPath(repoPath);
    const hash = rawDoc.hash ?? createHash("sha1").update(`${repoPath}:${rawDoc.id ?? "legacy"}`).digest("hex");
    const doc: DocumentRecord = {
      id: logicalId,
      versionId: documentVersionId(logicalId, sha, hash),
      path: repoPath,
      docType: coerceLegacyDocType(rawDoc.docType),
      commitSha: sha,
      hash,
      sections: rawDoc.sections ?? [],
    };
    docs.set(repoPath, doc);
  }
  const pendingChunks: Array<{ chunk: Omit<ChunkRecord, "embedding"> }> = [];
  for (const rawChunk of payload.chunks ?? []) {
    const repoPath = rawChunk.path.replaceAll(path.sep, "/");
    const doc = docs.get(repoPath) ?? {
      id: documentIdFromPath(repoPath),
      versionId: documentVersionId(
        documentIdFromPath(repoPath),
        sha,
        createHash("sha1").update(`${repoPath}:legacy-doc`).digest("hex"),
      ),
      path: repoPath,
      docType: "unknown" as DocType,
      commitSha: sha,
      hash: createHash("sha1").update(`${repoPath}:legacy-doc`).digest("hex"),
      sections: [],
    };
    docs.set(repoPath, doc);
    pendingChunks.push({
      chunk: {
        id: rawChunk.id ?? chunkVersionId(doc.versionId, rawChunk.sectionId ?? "legacy", 0, rawChunk.text),
        documentId: doc.id,
        documentVersionId: doc.versionId,
        sectionId: rawChunk.sectionId ?? "legacy",
        sectionTitle: rawChunk.sectionTitle ?? "legacy",
        path: repoPath,
        docType: coerceLegacyDocType(rawChunk.docType),
        commitSha: sha,
        text: rawChunk.text,
        tokenCount: rawChunk.tokenCount ?? rawChunk.text.split(/\s+/).filter(Boolean).length,
      },
    });
  }

  try {
    const documents = Array.from(docs.values());
    const embeddings = await embedTexts(
      pendingChunks.map((item) => item.chunk.text),
      embeddingProfile,
      { cwd, cacheMode: "readwrite" },
    );
    const chunks = pendingChunks.map((item, index) => ({
      ...item.chunk,
      embedding: embeddings[index] ?? [],
    }));
    writeDocumentsToCanonicalStore(store, documents);
    writeChunksToCanonicalStore(store, chunks);
    const manifest = buildSnapshotManifest(sha, parentSha, documents, chunks);
    await writeSnapshotManifest(cwd, manifest);

    return {
      mode: "apply",
      docs: documents.length,
      chunks: chunks.length,
      snapshotSha: sha,
    };
  } finally {
    closeCanonicalStore(store);
  }
};

const migrateFromJsonStoreUnlocked = async (cwd: string, dryRun: boolean): Promise<MigrationSummary> => {
  await ensureRagitStructure(cwd);
  const storePath = legacyStorePath(cwd);
  try {
    await readFile(storePath, "utf8");
  } catch {
    throw new Error("legacy json store를 찾을 수 없습니다.");
  }

  const legacy = await loadLegacyStore(cwd);
  const documents = Object.values(legacy.documents);
  const chunks = Object.values(legacy.chunks);
  if (dryRun) {
    return {
      mode: "dry-run",
      docs: documents.length,
      chunks: chunks.length,
    };
  }

  const config = await loadConfig(cwd);
  const embeddingProfile = resolveEmbeddingProfile(config);
  const sha = await getHeadSha(cwd);
  const parentSha = await getParentSha(cwd);
  const canonical = await bootstrapCanonicalStore(cwd, toEmbeddingContract(embeddingProfile), false);

  try {
    const docByLegacyId = new Map<string, DocumentRecord>();
    const normalizedDocs = documents.map((legacyDoc) => {
      const repoPath = legacyDoc.path.replaceAll(path.sep, "/");
      const logicalId = documentIdFromPath(repoPath);
      const hash = legacyDoc.hash || createHash("sha1").update(`${repoPath}:${legacyDoc.id}`).digest("hex");
      const normalized: DocumentRecord = {
        id: logicalId,
        versionId: documentVersionId(logicalId, sha, hash),
        path: repoPath,
        docType: legacyDoc.docType,
        commitSha: sha,
        hash,
        sections: legacyDoc.sections ?? [],
      };
      docByLegacyId.set(legacyDoc.id, normalized);
      return normalized;
    });
    const pendingChunks = chunks.map((legacyChunk, index) => {
      const repoPath = legacyChunk.path.replaceAll(path.sep, "/");
      const document = docByLegacyId.get(legacyChunk.documentId) ??
        normalizedDocs.find((item) => item.path === repoPath) ?? {
          id: documentIdFromPath(repoPath),
          versionId: documentVersionId(
            documentIdFromPath(repoPath),
            sha,
            createHash("sha1").update(`${repoPath}:json-legacy`).digest("hex"),
          ),
          path: repoPath,
          docType: legacyChunk.docType,
          commitSha: sha,
          hash: createHash("sha1").update(`${repoPath}:json-legacy`).digest("hex"),
          sections: [],
        };
      return {
        id: chunkVersionId(document.versionId, legacyChunk.sectionId, index, legacyChunk.text),
        documentId: document.id,
        documentVersionId: document.versionId,
        sectionId: legacyChunk.sectionId,
        sectionTitle: legacyChunk.sectionTitle,
        path: repoPath,
        docType: legacyChunk.docType,
        commitSha: sha,
        text: legacyChunk.text,
        tokenCount: legacyChunk.tokenCount,
      } satisfies Omit<ChunkRecord, "embedding">;
    });
    const embeddings = await embedTexts(
      pendingChunks.map((chunk) => chunk.text),
      embeddingProfile,
      { cwd, cacheMode: "readwrite" },
    );
    const normalizedChunks = pendingChunks.map((chunk, index) => ({
      ...chunk,
      embedding: embeddings[index] ?? [],
    }));

    writeDocumentsToCanonicalStore(canonical, normalizedDocs);
    writeChunksToCanonicalStore(canonical, normalizedChunks);
    const manifest = buildSnapshotManifest(sha, parentSha, normalizedDocs, normalizedChunks);
    await writeSnapshotManifest(cwd, manifest);

    return {
      mode: "apply",
      docs: normalizedDocs.length,
      chunks: normalizedChunks.length,
      snapshotSha: sha,
    };
  } finally {
    closeCanonicalStore(canonical);
  }
};

export const migrateEmbeddings = async (cwd: string, dryRun: boolean): Promise<EmbeddingMigrationSummary> =>
  dryRun
    ? migrateEmbeddingsUnlocked(cwd, true)
    : withStoreWriteLock(cwd, { command: "migrate-embeddings" }, () => migrateEmbeddingsUnlocked(cwd, false));

export const migrateFromSqliteVss = async (cwd: string, dryRun: boolean): Promise<MigrationSummary> =>
  dryRun
    ? migrateFromSqliteVssUnlocked(cwd, true)
    : withStoreWriteLock(cwd, { command: "migrate-from-sqlite-vss" }, () => migrateFromSqliteVssUnlocked(cwd, false));

export const migrateFromJsonStore = async (cwd: string, dryRun: boolean): Promise<MigrationSummary> =>
  dryRun
    ? migrateFromJsonStoreUnlocked(cwd, true)
    : withStoreWriteLock(cwd, { command: "migrate-from-json-store" }, () => migrateFromJsonStoreUnlocked(cwd, false));
