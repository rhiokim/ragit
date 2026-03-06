import { readFile } from "node:fs/promises";
import path from "node:path";
import { getHeadSha } from "./git.js";
import { buildSnapshotManifest, writeSnapshotManifest } from "./manifest.js";
import { ensureRagitStructure } from "./project.js";
import { loadStore, upsertDocumentWithChunks, writeStore } from "./store.js";
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
  const sha = await getHeadSha(cwd);
  const store = await loadStore(cwd);
  const docs = new Map<string, DocumentRecord>();
  for (const rawDoc of payload.docs ?? []) {
    const id = rawDoc.id ?? rawDoc.path;
    const doc: DocumentRecord = {
      id,
      path: rawDoc.path,
      docType: coerceLegacyDocType(rawDoc.docType),
      commitSha: sha,
      hash: rawDoc.hash ?? "",
      sections: rawDoc.sections ?? [],
    };
    docs.set(doc.id, doc);
  }
  const chunkByDoc = new Map<string, ChunkRecord[]>();
  for (const rawChunk of payload.chunks ?? []) {
    const docId = rawChunk.documentId ?? rawChunk.path;
    if (!docs.has(docId)) {
      docs.set(docId, {
        id: docId,
        path: rawChunk.path,
        docType: "unknown",
        commitSha: sha,
        hash: "",
        sections: [],
      });
    }
    const chunk: ChunkRecord = {
      id: rawChunk.id ?? `${docId}:${rawChunk.sectionId ?? "legacy"}:${rawChunk.text.slice(0, 8)}`,
      documentId: docId,
      sectionId: rawChunk.sectionId ?? "legacy",
      sectionTitle: rawChunk.sectionTitle ?? "legacy",
      path: rawChunk.path,
      docType: coerceLegacyDocType(rawChunk.docType),
      commitSha: sha,
      text: rawChunk.text,
      tokenCount: rawChunk.tokenCount ?? rawChunk.text.split(/\s+/).filter(Boolean).length,
      embedding: rawChunk.embedding ?? [],
    };
    const previous = chunkByDoc.get(docId) ?? [];
    previous.push(chunk);
    chunkByDoc.set(docId, previous);
  }

  for (const [docId, doc] of docs.entries()) {
    const chunks = chunkByDoc.get(docId) ?? [];
    upsertDocumentWithChunks(store, doc, chunks);
  }

  await writeStore(cwd, store);
  const manifest = buildSnapshotManifest(sha, null, Object.values(store.documents), Object.values(store.chunks));
  await writeSnapshotManifest(cwd, manifest);

  return {
    mode: "apply",
    docs: docs.size,
    chunks: Object.values(store.chunks).length,
    snapshotSha: sha,
  };
};
