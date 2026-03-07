import { loadConfig } from "./config.js";
import { getHeadSha } from "./git.js";
import { latestSnapshotSha, loadSnapshotManifest, resolveSnapshotRef } from "./manifest.js";
import { bootstrapCanonicalStore, closeCanonicalStore } from "./store.js";
import { ChunkRecord, RetrievalHit } from "./types.js";
import { embedWithLocalPlaceholder, zvecCosineDistanceToSimilarity } from "./embedding.js";

const normalizeText = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const tokenize = (text: string): string[] => normalizeText(text).split(" ").filter(Boolean);

const keywordScore = (query: string, target: string): number => {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return 0;
  const targetTokens = tokenize(target);
  if (targetTokens.length === 0) return 0;
  const targetSet = new Set(targetTokens);
  let matched = 0;
  for (const token of queryTokens) {
    if (targetSet.has(token)) matched += 1;
  }
  return matched / queryTokens.length;
};

export const calculateHybridScore = (scoreVector: number, scoreKeyword: number, alpha: number): number =>
  alpha * scoreVector + (1 - alpha) * scoreKeyword;

const resolveSnapshotSha = async (cwd: string, at?: string): Promise<string> => {
  if (at) return resolveSnapshotRef(cwd, at);
  try {
    const head = await getHeadSha(cwd);
    return resolveSnapshotRef(cwd, head);
  } catch {
    const latest = await latestSnapshotSha(cwd);
    if (!latest) throw new Error("사용 가능한 snapshot이 없습니다.");
    return latest;
  }
};

export interface QueryOptions {
  topK?: number;
  at?: string;
}

export interface QueryResult {
  snapshotSha: string;
  hits: RetrievalHit[];
}

const escapeFilterLiteral = (value: string): string => value.replaceAll("'", "''");

const buildSnapshotIdFilter = (ids: string[]): string => `id IN (${ids.map((id) => `'${escapeFilterLiteral(id)}'`).join(",")})`;

const hydrateChunk = (raw: { id: string; fields: Record<string, unknown> }): ChunkRecord => ({
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
  embedding: [],
});

export const searchKnowledge = async (cwd: string, query: string, options: QueryOptions): Promise<QueryResult> => {
  const config = await loadConfig(cwd);
  const snapshotSha = await resolveSnapshotSha(cwd, options.at);
  const snapshot = await loadSnapshotManifest(cwd, snapshotSha);
  const alpha = config.retrieval.alpha;
  const topK = options.topK ?? config.retrieval.top_k;
  const manifestChunkIds = snapshot.chunks.map((entry) => entry.id);
  if (manifestChunkIds.length === 0) {
    return {
      snapshotSha,
      hits: [],
    };
  }
  const queryEmbedding = embedWithLocalPlaceholder(query, config.embedding.dimensions);
  const store = await bootstrapCanonicalStore(cwd, config.embedding, true);

  try {
    const batchSize = 400;
    const candidateLimit = Math.min(manifestChunkIds.length, Math.max(topK * 20, 100));
    const candidates = new Map<string, RetrievalHit>();
    const scopedChunkIds = new Set(manifestChunkIds);

    for (let cursor = 0; cursor < manifestChunkIds.length; cursor += batchSize) {
      const slice = manifestChunkIds.slice(cursor, cursor + batchSize);
      const filter = buildSnapshotIdFilter(slice);
      const result = store.chunks.querySync({
        fieldName: "embedding",
        vector: queryEmbedding,
        topk: Math.min(candidateLimit, slice.length),
        filter,
        outputFields: ["documentId", "documentVersionId", "sectionId", "sectionTitle", "path", "docType", "commitSha", "text", "tokenCount"],
      });
      for (const raw of result) {
        const chunk = hydrateChunk(raw);
        const scoreVector = zvecCosineDistanceToSimilarity(raw.score);
        const scoreKeyword = config.retrieval.keyword_enabled ? keywordScore(query, chunk.text) : 0;
        const scoreFinal = calculateHybridScore(scoreVector, scoreKeyword, alpha);
        const existing = candidates.get(chunk.id);
        if (existing && existing.scoreFinal >= scoreFinal) {
          continue;
        }
        candidates.set(chunk.id, {
          chunkId: chunk.id,
          path: chunk.path,
          sectionTitle: chunk.sectionTitle,
          scoreVector,
          scoreKeyword,
          scoreFinal,
          text: chunk.text,
        });
      }
    }

    const hits = Array.from(candidates.values())
      .filter((hit) => scopedChunkIds.has(hit.chunkId))
      .sort((a, b) => b.scoreFinal - a.scoreFinal)
      .slice(0, topK);
    return {
      snapshotSha,
      hits,
    };
  } finally {
    closeCanonicalStore(store);
  }
};
