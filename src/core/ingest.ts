import { access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { chunkSections, parseSections } from "./chunk.js";
import { loadConfig } from "./config.js";
import { detectDocType } from "./docType.js";
import { hashFileContent, listAllDocumentFiles, listDocumentFilesByGlob } from "./files.js";
import { getHeadSha, getParentSha, listChangedFilesSince } from "./git.js";
import { chunkVersionId, documentIdFromPath, documentVersionId, toRepoPath } from "./identity.js";
import { maskSecrets } from "./mask.js";
import { buildSnapshotManifest, latestSnapshotSha, loadSnapshotManifestIfExists, writeSnapshotManifest } from "./manifest.js";
import { ensureRagitStructure } from "./project.js";
import { bootstrapCanonicalStore, closeCanonicalStore, writeChunksToCanonicalStore, writeDocumentsToCanonicalStore } from "./store.js";
import { ChunkRecord, DocType, DocumentRecord } from "./types.js";
import { embedWithLocalPlaceholder } from "./embedding.js";

export interface IngestOptions {
  all?: boolean;
  since?: string;
  files?: string;
}

interface ResolvedIngestTargets {
  files: string[];
  deletedDocumentIds: string[];
  fullSnapshot: boolean;
}

const fileExists = async (target: string): Promise<boolean> => {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

const isDocumentLikePath = (target: string): boolean => {
  const normalized = target.replaceAll(path.sep, "/");
  if (normalized.includes("/.git/") || normalized.includes("/.ragit/") || normalized.includes("/node_modules/") || normalized.includes("/dist/")) {
    return false;
  }
  const extension = path.extname(normalized).toLowerCase();
  return extension === ".md" || extension === ".mdx";
};

const resolveCandidates = async (cwd: string, options: IngestOptions): Promise<ResolvedIngestTargets> => {
  if (options.files) {
    return {
      files: await listDocumentFilesByGlob(cwd, options.files),
      deletedDocumentIds: [],
      fullSnapshot: false,
    };
  }
  if (options.since) {
    const changed = await listChangedFilesSince(cwd, options.since);
    const files: string[] = [];
    const deletedDocumentIds: string[] = [];
    const seenFiles = new Set<string>();
    const seenDeleted = new Set<string>();
    for (const relativePath of changed) {
      if (!isDocumentLikePath(relativePath)) continue;
      const repoPath = relativePath.replaceAll(path.sep, "/");
      const absolutePath = path.resolve(cwd, relativePath);
      if (await fileExists(absolutePath)) {
        if (!seenFiles.has(absolutePath)) {
          seenFiles.add(absolutePath);
          files.push(absolutePath);
        }
        continue;
      }
      const documentId = documentIdFromPath(repoPath);
      if (!seenDeleted.has(documentId)) {
        seenDeleted.add(documentId);
        deletedDocumentIds.push(documentId);
      }
    }
    return {
      files,
      deletedDocumentIds,
      fullSnapshot: false,
    };
  }
  return {
    files: await listAllDocumentFiles(cwd),
    deletedDocumentIds: [],
    fullSnapshot: true,
  };
};

const isSupported = (docType: DocType, supported: DocType[]): boolean =>
  docType !== "unknown" && supported.includes(docType);

export interface IngestSummary {
  processed: number;
  skipped: number;
  masked: number;
  commitSha: string;
  manifestPath: string;
  searchReady: boolean;
}

const sortDocuments = (documents: DocumentRecord[]): DocumentRecord[] =>
  [...documents].sort((left, right) => left.path.localeCompare(right.path) || left.versionId.localeCompare(right.versionId));

const sortChunkEntries = (chunks: Array<Pick<ChunkRecord, "id" | "documentId" | "documentVersionId">>): Array<
  Pick<ChunkRecord, "id" | "documentId" | "documentVersionId">
> => [...chunks].sort((left, right) => left.id.localeCompare(right.id));

export const runIngest = async (cwd: string, options: IngestOptions): Promise<IngestSummary> => {
  await ensureRagitStructure(cwd);
  const config = await loadConfig(cwd);
  const candidates = await resolveCandidates(cwd, options);
  const headSha = await getHeadSha(cwd);
  const parentSha = await getParentSha(cwd);
  const store = await bootstrapCanonicalStore(cwd, config.embedding, false);
  let processed = 0;
  let skipped = 0;
  let masked = 0;
  const changedDocuments = new Map<string, DocumentRecord>();
  const changedChunks = new Map<string, ChunkRecord[]>();

  try {
    for (const absolutePath of candidates.files) {
      const { content, hash } = await hashFileContent(absolutePath);
      const maskedContent = config.security.secret_masking ? maskSecrets(content) : { text: content, maskedCount: 0 };
      masked += maskedContent.maskedCount;
      const detection = detectDocType(absolutePath, maskedContent.text, cwd);
      if (!isSupported(detection.docType, config.ingest.supported_types)) {
        skipped += 1;
        continue;
      }
      const repoPath = toRepoPath(cwd, absolutePath);
      const logicalDocumentId = documentIdFromPath(repoPath);
      const versionId = documentVersionId(logicalDocumentId, headSha, hash);
      const sections = parseSections(detection.body);
      const doc: DocumentRecord = {
        id: logicalDocumentId,
        versionId,
        path: repoPath,
        docType: detection.docType,
        commitSha: headSha,
        hash,
        sections,
      };
      const chunks = chunkSections(sections).map((chunk, index) => {
        const id = chunkVersionId(versionId, chunk.sectionId, index, chunk.text);
        const record: ChunkRecord = {
          id,
          documentId: doc.id,
          documentVersionId: doc.versionId,
          sectionId: chunk.sectionId,
          sectionTitle: chunk.sectionTitle,
          path: doc.path,
          docType: doc.docType,
          commitSha: headSha,
          text: chunk.text,
          tokenCount: chunk.tokenCount,
          embedding: embedWithLocalPlaceholder(chunk.text, config.embedding.dimensions),
        };
        return record;
      });
      changedDocuments.set(doc.id, doc);
      changedChunks.set(doc.id, chunks);
      processed += 1;
    }

    const baseSnapshot =
      candidates.fullSnapshot
        ? null
        : (await loadSnapshotManifestIfExists(cwd, parentSha)) ??
          (await loadSnapshotManifestIfExists(cwd, await latestSnapshotSha(cwd)));

    const documentMap = new Map<string, DocumentRecord>();
    const chunkEntries = new Map<string, Pick<ChunkRecord, "id" | "documentId" | "documentVersionId">>();

    if (baseSnapshot) {
      for (const document of baseSnapshot.docs) {
        documentMap.set(document.id, document);
      }
      for (const chunk of baseSnapshot.chunks) {
        chunkEntries.set(chunk.id, chunk);
      }
    }

    const removedDocumentIds = new Set<string>(candidates.deletedDocumentIds);
    for (const documentId of changedDocuments.keys()) {
      removedDocumentIds.add(documentId);
    }

    if (candidates.fullSnapshot) {
      documentMap.clear();
      chunkEntries.clear();
    } else if (removedDocumentIds.size > 0) {
      for (const documentId of removedDocumentIds) {
        documentMap.delete(documentId);
      }
      for (const [chunkId, chunk] of chunkEntries.entries()) {
        if (removedDocumentIds.has(chunk.documentId)) {
          chunkEntries.delete(chunkId);
        }
      }
    }

    const newDocuments = Array.from(changedDocuments.values());
    const newChunks = Array.from(changedChunks.values()).flat();
    writeDocumentsToCanonicalStore(store, newDocuments);
    writeChunksToCanonicalStore(store, newChunks);

    for (const document of newDocuments) {
      documentMap.set(document.id, document);
    }
    for (const chunk of newChunks) {
      chunkEntries.set(chunk.id, {
        id: chunk.id,
        documentId: chunk.documentId,
        documentVersionId: chunk.documentVersionId,
      });
    }

    const manifest = buildSnapshotManifest(headSha, parentSha, sortDocuments(Array.from(documentMap.values())), sortChunkEntries(Array.from(chunkEntries.values())));
    await writeSnapshotManifest(cwd, manifest);
    const manifestPath = `.ragit/manifest/${headSha}.json`;
    return {
      processed,
      skipped,
      masked,
      commitSha: headSha,
      manifestPath,
      searchReady: true,
    };
  } finally {
    closeCanonicalStore(store);
  }
};
