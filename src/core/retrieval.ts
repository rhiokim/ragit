import { loadConfig } from "./config.js";
import { loadArtifactRecord } from "./artifacts.js";
import { ArtifactAuthority, RetrievalScope, SnapshotManifest } from "./types.js";
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
  scope?: RetrievalScope;
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

const resolveChunkIdsForScope = (snapshot: SnapshotManifest, scope: RetrievalScope): { ids: string[]; scopeById: Map<string, RetrievalScope> } => {
  const scopes = snapshot.chunkScopes ?? {
    durable: snapshot.chunks.map((entry) => entry.id),
    session: [],
    harness: [],
    evidence: [],
  };
  const scopeById = new Map<string, RetrievalScope>();
  const collect = (items: string[], label: RetrievalScope): void => {
    for (const item of items) {
      if (!scopeById.has(item)) scopeById.set(item, label);
    }
  };
  if (scope === "all") {
    collect(scopes.durable, "durable");
    collect(scopes.session, "session");
    collect(scopes.harness, "harness");
    collect(scopes.evidence, "evidence");
  } else {
    const target = scope === "durable" ? scopes.durable : scope === "session" ? scopes.session : scope === "harness" ? scopes.harness : scopes.evidence;
    collect(target, scope);
  }
  return {
    ids: Array.from(scopeById.keys()),
    scopeById,
  };
};

const authorityWeightForScope = (scope: RetrievalScope, authority?: ArtifactAuthority | null): number => {
  if (authority === "promoted_durable" || scope === "durable") return 1;
  if (authority === "reviewed_harness" || scope === "harness") return 0.9;
  if (scope === "session") return 0.8;
  if (scope === "evidence") return 0.4;
  return 0.6;
};

const recencyWeight = (updatedAt?: string | null): number => {
  if (!updatedAt) return 1;
  const ageDays = Math.max(0, (Date.now() - new Date(updatedAt).getTime()) / (1000 * 60 * 60 * 24));
  return Math.max(0.2, 1 - Math.min(ageDays / 30, 0.8));
};

export const searchKnowledge = async (cwd: string, query: string, options: QueryOptions): Promise<QueryResult> => {
  const config = await loadConfig(cwd);
  const snapshotSha = await resolveSnapshotSha(cwd, options.at);
  const snapshot = await loadSnapshotManifest(cwd, snapshotSha);
  const alpha = config.retrieval.alpha;
  const topK = options.topK ?? config.retrieval.top_k;
  const { ids: manifestChunkIds, scopeById } = resolveChunkIdsForScope(snapshot, options.scope ?? "durable");
  const artifactEntryByChunkId = new Map(
    (snapshot.artifactEntries ?? []).flatMap((entry) => entry.chunkIds.map((chunkId) => [chunkId, entry] as const)),
  );
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
        const semanticHybrid = calculateHybridScore(scoreVector, scoreKeyword, alpha);
        const scope = scopeById.get(chunk.id) ?? "durable";
        const artifactEntry = artifactEntryByChunkId.get(chunk.id);
        const artifact = artifactEntry ? await loadArtifactRecord(cwd, artifactEntry.artifactId) : null;
        const authorityWeight = authorityWeightForScope(scope, artifact?.authority);
        const scoreFinal = 0.8 * semanticHybrid + 0.15 * authorityWeight + 0.05 * recencyWeight(artifact?.updatedAt);
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
          scope,
          originType: artifactEntry ? "artifact" : "document",
          artifactId: artifactEntry?.artifactId ?? null,
          artifactKind: artifactEntry?.kind ?? null,
          authority: artifact?.authority ?? (scope === "durable" ? "promoted_durable" : null),
          confidence: artifact?.confidence ?? null,
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
