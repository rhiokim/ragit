import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ChunkRecord, DocumentRecord } from "./types.js";

export interface RagitStore {
  documents: Record<string, DocumentRecord>;
  chunks: Record<string, ChunkRecord>;
}

const defaultStore = (): RagitStore => ({
  documents: {},
  chunks: {},
});

const storePath = (cwd: string): string => path.join(cwd, ".ragit", "store", "index.json");

export const loadStore = async (cwd: string): Promise<RagitStore> => {
  const target = storePath(cwd);
  try {
    const content = await readFile(target, "utf8");
    const parsed = JSON.parse(content) as RagitStore;
    return {
      documents: parsed.documents ?? {},
      chunks: parsed.chunks ?? {},
    };
  } catch {
    return defaultStore();
  }
};

export const writeStore = async (cwd: string, store: RagitStore): Promise<void> => {
  const target = storePath(cwd);
  await writeFile(target, `${JSON.stringify(store, null, 2)}\n`, "utf8");
};

export const upsertDocumentWithChunks = (store: RagitStore, document: DocumentRecord, chunks: ChunkRecord[]): void => {
  const previous = store.documents[document.id];
  if (previous) {
    for (const chunk of Object.values(store.chunks)) {
      if (chunk.documentId === document.id) {
        delete store.chunks[chunk.id];
      }
    }
  }
  store.documents[document.id] = document;
  for (const chunk of chunks) {
    store.chunks[chunk.id] = chunk;
  }
};
