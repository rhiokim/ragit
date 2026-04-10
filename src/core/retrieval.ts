import {
  listArtifactRecords,
  loadArtifactRecord,
  loadRecallArtifacts,
  pathForArtifact,
} from "./artifacts.js";
import { loadConfig } from "./config.js";
import { getHeadSha } from "./git.js";
import { latestSnapshotSha, loadSnapshotManifest, resolveSnapshotRef } from "./manifest.js";
import { bootstrapCanonicalStore, closeCanonicalStore } from "./store.js";
import {
  ArtifactAuthority,
  ArtifactRecord,
  ArtifactStatus,
  ChunkRecord,
  RetrievalHit,
  RetrievalScope,
  SnapshotManifest,
} from "./types.js";
import {
  cosineSimilarity,
  embedText,
  embedTexts,
  resolveEmbeddingProfile,
  toEmbeddingContract,
  zvecCosineDistanceToSimilarity,
} from "./embedding.js";
import { toRepoPath } from "./identity.js";

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

const isRecoverableSnapshotError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("사용 가능한 snapshot이 없습니다.") ||
    message.includes("snapshot을 찾을 수 없습니다") ||
    message.includes("zvec store가 아직 초기화되지 않았습니다.")
  );
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

export interface UnifiedArtifactRetrievalOptions {
  mode: "explicit-scope" | "recall";
  scope?: "session" | "harness" | "evidence" | "all";
  goal?: string;
}

export interface UnifiedRetrievalRequest {
  query: string;
  topK?: number;
  at?: string;
  scope?: RetrievalScope;
  includeSnapshot?: boolean;
  artifactOptions?: UnifiedArtifactRetrievalOptions;
}

export interface UnifiedRetrievalResult {
  snapshotSha: string | null;
  hits: RetrievalHit[];
  warnings: string[];
}

type ArtifactCandidate = {
  artifact: ArtifactRecord;
  text: string;
  sectionTitle: string;
  path: string;
  scopeValue: "session" | "harness" | "evidence";
};

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
    const target =
      scope === "durable"
        ? scopes.durable
        : scope === "session"
          ? scopes.session
          : scope === "harness"
            ? scopes.harness
            : scopes.evidence;
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

const authorityWeightForArtifact = (
  artifact: ArtifactRecord,
  scopeValue: "session" | "harness" | "evidence",
): number => {
  if (artifact.tier === "durable" || artifact.status === "promoted") return 1;
  return authorityWeightForScope(scopeValue, artifact.authority);
};

const recencyWeight = (updatedAt?: string | null): number => {
  if (!updatedAt) return 1;
  const ageDays = Math.max(0, (Date.now() - new Date(updatedAt).getTime()) / (1000 * 60 * 60 * 24));
  return Math.max(0.2, 1 - Math.min(ageDays / 30, 0.8));
};

const explicitArtifactStatuses = (scope: "session" | "harness" | "evidence" | "all"): ArtifactStatus[] =>
  scope === "evidence" ? ["captured", "reviewed"] : ["reviewed", "promoted"];

const scopeMatchesArtifact = (artifact: ArtifactRecord, scope: "session" | "harness" | "evidence" | "all"): boolean => {
  if (scope === "all") return true;
  if (scope === "evidence") return artifact.evidenceRefs.length > 0;
  return artifact.artifactScope === scope;
};

const buildExplicitArtifactCandidates = async (
  cwd: string,
  scope: "session" | "harness" | "evidence" | "all",
): Promise<ArtifactCandidate[]> => {
  const artifacts = await listArtifactRecords(cwd, {
    statuses: explicitArtifactStatuses(scope),
  });
  const candidates: ArtifactCandidate[] = [];
  for (const artifact of artifacts) {
    if (!scopeMatchesArtifact(artifact, scope)) continue;
    if (artifact.status === "superseded" || artifact.status === "retracted" || artifact.status === "archived") continue;
    if (scope === "evidence") {
      for (const evidence of artifact.evidenceRefs) {
        candidates.push({
          artifact,
          text: evidence.excerpt,
          sectionTitle: "Evidence",
          path: `${pathForArtifact(cwd, artifact)}#${evidence.evidenceId}`,
          scopeValue: "evidence",
        });
      }
      continue;
    }
    candidates.push({
      artifact,
      text: artifact.text,
      sectionTitle: artifact.title,
      path: pathForArtifact(cwd, artifact),
      scopeValue: artifact.searchPolicy === "evidence" ? "evidence" : artifact.artifactScope,
    });
  }
  return candidates;
};

const buildRecallArtifactCandidates = async (cwd: string, goal: string): Promise<ArtifactCandidate[]> => {
  const artifacts = await loadRecallArtifacts(cwd, goal);
  return artifacts.map((artifact) => ({
    artifact,
    text: artifact.text,
    sectionTitle: artifact.title,
    path: pathForArtifact(cwd, artifact),
    scopeValue: artifact.searchPolicy === "evidence" ? "evidence" : artifact.artifactScope,
  }));
};

const buildArtifactHits = async (
  cwd: string,
  query: string,
  queryEmbedding: number[],
  alpha: number,
  embeddingProfile: ReturnType<typeof resolveEmbeddingProfile>,
  candidates: ArtifactCandidate[],
): Promise<RetrievalHit[]> => {
  if (candidates.length === 0) return [];
  const candidateEmbeddings = await embedTexts(
    candidates.map((candidate) => candidate.text),
    embeddingProfile,
    { cwd },
  );
  return candidates.map((candidate, index) => {
    const semantic = cosineSimilarity(queryEmbedding, candidateEmbeddings[index] ?? []);
    const keyword = keywordScore(query, candidate.text);
    const semanticHybrid = calculateHybridScore(semantic, keyword, alpha);
    const scoreFinal =
      0.8 * semanticHybrid +
      0.15 * authorityWeightForArtifact(candidate.artifact, candidate.scopeValue) +
      0.05 * recencyWeight(candidate.artifact.updatedAt);
    return {
      chunkId:
        candidate.scopeValue === "evidence"
          ? `${candidate.artifact.artifactId}:${escapeFilterLiteral(candidate.path)}`
          : candidate.artifact.artifactId,
      path: toRepoPath(cwd, candidate.path.replace(/#.*$/, "")),
      sectionTitle: candidate.sectionTitle,
      scoreVector: semantic,
      scoreKeyword: keyword,
      scoreFinal,
      text: candidate.text,
      scope: candidate.scopeValue,
      originType: "artifact" as const,
      artifactId: candidate.artifact.artifactId,
      artifactKind: candidate.artifact.kind,
      authority: candidate.artifact.authority,
      confidence: candidate.artifact.confidence,
    };
  });
};

const buildSnapshotHits = async (
  cwd: string,
  snapshotSha: string,
  query: string,
  queryEmbedding: number[],
  alpha: number,
  embeddingProfile: ReturnType<typeof resolveEmbeddingProfile>,
  topK: number,
  scope: RetrievalScope,
): Promise<RetrievalHit[]> => {
  const snapshot = await loadSnapshotManifest(cwd, snapshotSha);
  const { ids: manifestChunkIds, scopeById } = resolveChunkIdsForScope(snapshot, scope);
  const artifactEntryByChunkId = new Map(
    (snapshot.artifactEntries ?? []).flatMap((entry) => entry.chunkIds.map((chunkId) => [chunkId, entry] as const)),
  );
  if (manifestChunkIds.length === 0) return [];

  const store = await bootstrapCanonicalStore(cwd, toEmbeddingContract(embeddingProfile), true);
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
        const scoreKeyword = keywordScore(query, chunk.text);
        const semanticHybrid = calculateHybridScore(scoreVector, scoreKeyword, alpha);
        const hitScope = scopeById.get(chunk.id) ?? "durable";
        const artifactEntry = artifactEntryByChunkId.get(chunk.id);
        const artifact = artifactEntry ? await loadArtifactRecord(cwd, artifactEntry.artifactId) : null;
        const authorityWeight = authorityWeightForScope(hitScope, artifact?.authority);
        const scoreFinal = 0.8 * semanticHybrid + 0.15 * authorityWeight + 0.05 * recencyWeight(artifact?.updatedAt);
        const existing = candidates.get(chunk.id);
        if (existing && existing.scoreFinal >= scoreFinal) continue;
        candidates.set(chunk.id, {
          chunkId: chunk.id,
          path: chunk.path,
          sectionTitle: chunk.sectionTitle,
          scoreVector,
          scoreKeyword,
          scoreFinal,
          text: chunk.text,
          scope: hitScope,
          originType: artifactEntry ? "artifact" : "document",
          artifactId: artifactEntry?.artifactId ?? null,
          artifactKind: artifactEntry?.kind ?? null,
          authority: artifact?.authority ?? (hitScope === "durable" ? "promoted_durable" : null),
          confidence: artifact?.confidence ?? null,
        });
      }
    }

    return Array.from(candidates.values()).filter((hit) => scopedChunkIds.has(hit.chunkId));
  } finally {
    closeCanonicalStore(store);
  }
};

const retrievalIdentity = (hit: RetrievalHit): string =>
  hit.originType === "artifact" && hit.scope !== "evidence" && hit.artifactId ? hit.artifactId : hit.chunkId;

const finalizeHits = (hits: RetrievalHit[], topK: number): RetrievalHit[] => {
  const deduped = new Map<string, RetrievalHit>();
  for (const hit of hits) {
    const key = retrievalIdentity(hit);
    const existing = deduped.get(key);
    if (!existing || existing.scoreFinal < hit.scoreFinal) {
      deduped.set(key, hit);
    }
  }
  return Array.from(deduped.values())
    .sort((left, right) => right.scoreFinal - left.scoreFinal)
    .slice(0, topK);
};

const countTokens = (text: string): number => text.split(/\s+/).filter(Boolean).length;

export const selectHitsWithinBudget = (hits: RetrievalHit[], budget: number): { hits: RetrievalHit[]; usedTokens: number } => {
  const selected: RetrievalHit[] = [];
  let usedTokens = 0;
  for (const hit of hits) {
    const tokens = countTokens(hit.text);
    if (selected.length > 0 && usedTokens + tokens > budget) continue;
    selected.push(hit);
    usedTokens += tokens;
    if (usedTokens >= budget) break;
  }
  return { hits: selected, usedTokens };
};

export const runUnifiedRetrieval = async (cwd: string, request: UnifiedRetrievalRequest): Promise<UnifiedRetrievalResult> => {
  const config = await loadConfig(cwd);
  const embeddingProfile = resolveEmbeddingProfile(config);
  const topK = request.topK ?? config.retrieval.top_k;
  const queryEmbedding = await embedText(request.query, embeddingProfile, { cwd });
  const hits: RetrievalHit[] = [];
  const warnings: string[] = [];
  let snapshotSha: string | null = null;

  if (request.includeSnapshot !== false) {
    try {
      snapshotSha = await resolveSnapshotSha(cwd, request.at);
      hits.push(
        ...(await buildSnapshotHits(
          cwd,
          snapshotSha,
          request.query,
          queryEmbedding,
          config.retrieval.alpha,
          embeddingProfile,
          topK,
          request.scope ?? "durable",
        )),
      );
    } catch (error) {
      if (!request.artifactOptions || !isRecoverableSnapshotError(error)) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`검색 snapshot이 없어 artifact source만 사용했습니다: ${message}`);
    }
  }

  if (request.artifactOptions) {
    const candidates =
      request.artifactOptions.mode === "recall"
        ? await buildRecallArtifactCandidates(cwd, request.artifactOptions.goal ?? request.query)
        : await buildExplicitArtifactCandidates(cwd, request.artifactOptions.scope ?? "all");
    hits.push(
      ...(await buildArtifactHits(
        cwd,
        request.query,
        queryEmbedding,
        config.retrieval.alpha,
        embeddingProfile,
        candidates,
      )),
    );
  }

  return {
    snapshotSha,
    hits: finalizeHits(hits, topK),
    warnings,
  };
};

export const searchKnowledge = async (cwd: string, query: string, options: QueryOptions): Promise<QueryResult> => {
  const result = await runUnifiedRetrieval(cwd, {
    query,
    topK: options.topK,
    at: options.at,
    scope: options.scope,
    includeSnapshot: true,
  });
  if (!result.snapshotSha) {
    throw new Error("사용 가능한 snapshot이 없습니다.");
  }
  return {
    snapshotSha: result.snapshotSha,
    hits: result.hits,
  };
};
