import { createHash } from "node:crypto";
import path from "node:path";
import { chunkSections, parseSections } from "./chunk.js";
import { loadConfig } from "./config.js";
import { detectDocType } from "./docType.js";
import { hashFileContent, listAllDocumentFiles, listDocumentFilesByGlob, listDocumentFilesSince } from "./files.js";
import { getHeadSha, getParentSha } from "./git.js";
import { maskSecrets } from "./mask.js";
import { buildSnapshotManifest, writeSnapshotManifest } from "./manifest.js";
import { ensureRagitStructure } from "./project.js";
import { loadStore, upsertDocumentWithChunks, writeStore } from "./store.js";
import { ChunkRecord, DocType, DocumentRecord } from "./types.js";
import { embedWithZvec } from "./zvec.js";

export interface IngestOptions {
  all?: boolean;
  since?: string;
  files?: string;
}

const documentId = (absolutePath: string): string => createHash("sha1").update(absolutePath).digest("hex");

const chunkId = (document: DocumentRecord, sectionId: string, index: number, text: string): string =>
  createHash("sha1").update(`${document.id}:${sectionId}:${index}:${text}`).digest("hex");

const resolveCandidates = async (cwd: string, options: IngestOptions): Promise<string[]> => {
  if (options.files) return listDocumentFilesByGlob(cwd, options.files);
  if (options.since) return listDocumentFilesSince(cwd, options.since);
  return listAllDocumentFiles(cwd);
};

const isSupported = (docType: DocType, supported: DocType[]): boolean =>
  docType !== "unknown" && supported.includes(docType);

export interface IngestSummary {
  processed: number;
  skipped: number;
  masked: number;
  commitSha: string;
  manifestPath: string;
}

export const runIngest = async (cwd: string, options: IngestOptions): Promise<IngestSummary> => {
  await ensureRagitStructure(cwd);
  const config = await loadConfig(cwd);
  const candidates = await resolveCandidates(cwd, options);
  const store = await loadStore(cwd);
  const headSha = await getHeadSha(cwd);
  const parentSha = await getParentSha(cwd);
  let processed = 0;
  let skipped = 0;
  let masked = 0;

  for (const absolutePath of candidates) {
    const { content, hash } = await hashFileContent(absolutePath);
    const maskedContent = config.security.secret_masking ? maskSecrets(content) : { text: content, maskedCount: 0 };
    masked += maskedContent.maskedCount;
    const detection = detectDocType(absolutePath, maskedContent.text, cwd);
    if (!isSupported(detection.docType, config.ingest.supported_types)) {
      skipped += 1;
      continue;
    }
    const sections = parseSections(detection.body);
    const doc: DocumentRecord = {
      id: documentId(absolutePath),
      path: path.relative(cwd, absolutePath).replaceAll(path.sep, "/"),
      docType: detection.docType,
      commitSha: headSha,
      hash,
      sections,
    };
    const chunks = chunkSections(sections).map((chunk, index) => {
      const id = chunkId(doc, chunk.sectionId, index, chunk.text);
      const record: ChunkRecord = {
        id,
        documentId: doc.id,
        sectionId: chunk.sectionId,
        sectionTitle: chunk.sectionTitle,
        path: doc.path,
        docType: doc.docType,
        commitSha: headSha,
        text: chunk.text,
        tokenCount: chunk.tokenCount,
        embedding: embedWithZvec(chunk.text),
      };
      return record;
    });
    upsertDocumentWithChunks(store, doc, chunks);
    processed += 1;
  }

  await writeStore(cwd, store);
  const docs = Object.values(store.documents);
  const chunks = Object.values(store.chunks);
  const manifest = buildSnapshotManifest(headSha, parentSha, docs, chunks);
  await writeSnapshotManifest(cwd, manifest);
  const manifestPath = `.ragit/manifest/${headSha}.json`;
  return {
    processed,
    skipped,
    masked,
    commitSha: headSha,
    manifestPath,
  };
};
