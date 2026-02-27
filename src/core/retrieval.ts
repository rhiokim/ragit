import { loadConfig } from "./config.js";
import { getHeadSha } from "./git.js";
import { latestSnapshotSha, loadSnapshotManifest, resolveSnapshotRef } from "./manifest.js";
import { loadStore } from "./store.js";
import { ChunkRecord, RetrievalHit } from "./types.js";
import { cosineSimilarity, embedWithZvec } from "./zvec.js";

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

const mapChunksById = (chunks: ChunkRecord[]): Map<string, ChunkRecord> => {
  const map = new Map<string, ChunkRecord>();
  for (const chunk of chunks) map.set(chunk.id, chunk);
  return map;
};

export const searchKnowledge = async (cwd: string, query: string, options: QueryOptions): Promise<QueryResult> => {
  const config = await loadConfig(cwd);
  const snapshotSha = await resolveSnapshotSha(cwd, options.at);
  const snapshot = await loadSnapshotManifest(cwd, snapshotSha);
  const store = await loadStore(cwd);
  const allChunks = Object.values(store.chunks);
  const chunkMap = mapChunksById(allChunks);
  const scopedChunks = snapshot.chunks
    .map((entry) => chunkMap.get(entry.id))
    .filter((chunk): chunk is ChunkRecord => Boolean(chunk));
  const queryEmbedding = embedWithZvec(query);
  const alpha = config.retrieval.alpha;
  const topK = options.topK ?? config.retrieval.top_k;
  const hits = scopedChunks
    .map((chunk) => {
      const scoreVector = cosineSimilarity(queryEmbedding, chunk.embedding);
      const scoreKeyword = config.retrieval.keyword_enabled ? keywordScore(query, chunk.text) : 0;
      const scoreFinal = calculateHybridScore(scoreVector, scoreKeyword, alpha);
      const hit: RetrievalHit = {
        chunkId: chunk.id,
        path: chunk.path,
        sectionTitle: chunk.sectionTitle,
        scoreVector,
        scoreKeyword,
        scoreFinal,
        text: chunk.text,
      };
      return hit;
    })
    .sort((a, b) => b.scoreFinal - a.scoreFinal)
    .slice(0, topK);
  return {
    snapshotSha,
    hits,
  };
};
