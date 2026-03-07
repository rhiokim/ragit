import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config.js";
import { embedWithLocalPlaceholder } from "./embedding.js";
import { getHeadSha, getParentSha } from "./git.js";
import { chunkVersionId, documentIdFromPath, documentVersionId } from "./identity.js";
import { buildSnapshotManifest, writeSnapshotManifest } from "./manifest.js";
import { ensureRagitStructure } from "./project.js";
import { loadLegacyStore, legacyStorePath } from "./legacy-store.js";
import { bootstrapCanonicalStore, closeCanonicalStore, writeChunksToCanonicalStore, writeDocumentsToCanonicalStore } from "./store.js";
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

const coerceLegacyDocType = (value?: string): DocType =>
  normalizeKnownDocType(value) ?? "unknown";

export const migrateFromSqliteVss = async (cwd: string, dryRun: boolean): Promise<MigrationSummary> => {
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
  const sha = await getHeadSha(cwd);
  const parentSha = await getParentSha(cwd);
  const store = await bootstrapCanonicalStore(cwd, config.embedding, false);
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
  const chunkByDoc = new Map<string, ChunkRecord[]>();
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
    const chunk: ChunkRecord = {
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
      embedding: rawChunk.embedding?.length
        ? rawChunk.embedding
        : embedWithLocalPlaceholder(rawChunk.text, config.embedding.dimensions),
    };
    const previous = chunkByDoc.get(repoPath) ?? [];
    previous.push(chunk);
    chunkByDoc.set(repoPath, previous);
  }

  try {
    const documents = Array.from(docs.values());
    const chunks = Array.from(chunkByDoc.values()).flat();
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

export const migrateFromJsonStore = async (cwd: string, dryRun: boolean): Promise<MigrationSummary> => {
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
  const sha = await getHeadSha(cwd);
  const parentSha = await getParentSha(cwd);
  const canonical = await bootstrapCanonicalStore(cwd, config.embedding, false);

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
    const normalizedChunks = chunks.map((legacyChunk, index) => {
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
        embedding: legacyChunk.embedding?.length
          ? legacyChunk.embedding
          : embedWithLocalPlaceholder(legacyChunk.text, config.embedding.dimensions),
      } satisfies ChunkRecord;
    });

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
