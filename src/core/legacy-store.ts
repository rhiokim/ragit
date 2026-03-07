import { readFile } from "node:fs/promises";
import path from "node:path";
import { ChunkRecord, DocumentRecord } from "./types.js";

export interface RagitLegacyStore {
  documents: Record<string, DocumentRecord>;
  chunks: Record<string, ChunkRecord>;
}

const defaultStore = (): RagitLegacyStore => ({
  documents: {},
  chunks: {},
});

export const legacyStorePath = (cwd: string): string => path.join(cwd, ".ragit", "store", "index.json");

export const loadLegacyStore = async (cwd: string): Promise<RagitLegacyStore> => {
  const target = legacyStorePath(cwd);
  try {
    const content = await readFile(target, "utf8");
    const parsed = JSON.parse(content) as RagitLegacyStore;
    return {
      documents: parsed.documents ?? {},
      chunks: parsed.chunks ?? {},
    };
  } catch {
    return defaultStore();
  }
};
