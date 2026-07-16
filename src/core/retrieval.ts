import { constants } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  listArtifactRecords,
  loadArtifactRecord,
  loadRecallArtifacts,
  pathForArtifact,
} from "./artifacts.js";
import { loadConfig } from "./config.js";
import { isRagitOperationalError, RagitOperationalError, type RagitErrorCode } from "./errors.js";
import {
  bootstrapCanonicalStoreAtPath,
  closeCanonicalStore,
  openCanonicalStoreWithContract,
  type CanonicalStore,
} from "./store.js";
import {
  resolveRepositoryContext,
  selectSnapshot,
  snapshotMetadataForUnavailable,
  type SnapshotMetadata,
  type SnapshotSelection,
} from "./snapshot.js";
import {
  ArtifactAuthority,
  ArtifactRecord,
  ArtifactStatus,
  ChunkRecord,
  RedactionSummary,
  RetrievalHit,
  RetrievalScope,
  SnapshotManifest,
  type EmbeddingProfile,
} from "./types.js";
import {
  cosineSimilarity,
  embedText,
  embedTexts,
  resolveEmbeddingProfile,
  toEmbeddingContract,
  zvecCosineDistanceToSimilarity,
  type EmbeddingCacheMode,
  type EmbeddingExecutionOptions,
  type EmbeddingProviderOnCacheMiss,
} from "./embedding.js";
import { toRepoPath } from "./identity.js";
import { resolveRagitPaths } from "./project.js";
import {
  canUseRemoteEmbedding,
  classifyEmbeddingEgress,
  mergeRedactionSummaries,
  sanitizeKnowledgeText,
  sanitizeStructuredValue,
} from "./security.js";
import {
  buildRetrievalCitation,
  buildRetrievalScoreBreakdown,
  calculateHybridScore,
  compareRetrievalHits,
} from "./retrieval-explanation.js";

export { calculateHybridScore };

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

export interface QueryOptions {
  topK?: number;
  at?: string;
  scope?: RetrievalScope;
  executionPolicy?: RetrievalExecutionPolicy;
}

export interface QueryResult {
  snapshotSha: string;
  snapshot: SnapshotMetadata;
  hits: RetrievalHit[];
  warnings: string[];
  redactionSummary: RedactionSummary;
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
  executionPolicy?: RetrievalExecutionPolicy;
}

export interface RetrievalExecutionPolicy {
  embeddingCacheMode?: EmbeddingCacheMode;
  remoteProviderOnCacheMiss?: EmbeddingProviderOnCacheMiss;
}

export const READ_ONLY_RETRIEVAL_POLICY: Readonly<RetrievalExecutionPolicy> = {
  embeddingCacheMode: "readonly",
  remoteProviderOnCacheMiss: "deny",
};

export interface UnifiedRetrievalResult {
  snapshotSha: string | null;
  snapshot: SnapshotMetadata;
  hits: RetrievalHit[];
  warnings: string[];
  redactionSummary: RedactionSummary;
}

interface ArtifactSemanticContext {
  queryEmbedding: number[];
  embeddingProfile: ReturnType<typeof resolveEmbeddingProfile>;
  embeddingOptions: EmbeddingExecutionOptions;
  config: Awaited<ReturnType<typeof loadConfig>>;
}

const embeddingOptionsForRetrieval = (
  cwd: string,
  profile: EmbeddingProfile,
  policy?: RetrievalExecutionPolicy,
): EmbeddingExecutionOptions => ({
  cwd,
  cacheMode: policy?.embeddingCacheMode,
  providerOnCacheMiss:
    policy?.remoteProviderOnCacheMiss === "deny" && classifyEmbeddingEgress(profile) === "remote"
      ? "deny"
      : "allow",
});

const openStoreForRetrieval = async (
  cwd: string,
  profile: EmbeddingProfile,
  policy?: RetrievalExecutionPolicy,
): Promise<{ store: CanonicalStore; isolatedRoot: string | null }> => {
  const contract = toEmbeddingContract(profile);
  if (policy?.embeddingCacheMode !== "readonly") {
    return {
      store: await openCanonicalStoreWithContract(cwd, contract, true),
      isolatedRoot: null,
    };
  }

  // zvec 0.2.1 can rotate RocksDB metadata even when opened read-only, so query a
  // copy-on-write clone to keep every repository-owned byte unchanged.
  const isolatedRoot = await mkdtemp(path.join(os.tmpdir(), "ragit-readonly-store-"));
  const isolatedStoreDir = path.join(isolatedRoot, "store");
  try {
    await cp(resolveRagitPaths(cwd).storeDir, isolatedStoreDir, {
      recursive: true,
      mode: constants.COPYFILE_FICLONE,
    });
    return {
      store: await bootstrapCanonicalStoreAtPath(cwd, contract, true, isolatedStoreDir),
      isolatedRoot,
    };
  } catch (error) {
    await rm(isolatedRoot, { recursive: true, force: true });
    throw error;
  }
};

const DEGRADABLE_RECALL_CODES = new Set<RagitErrorCode>([
  "SNAPSHOT_NOT_INDEXED",
  "SNAPSHOT_MANIFEST_INVALID",
  "SNAPSHOT_SCHEMA_UNSUPPORTED",
  "SNAPSHOT_STORE_UNAVAILABLE",
  "REPOSITORY_STATE_CHANGED",
]);

const resolveArtifactOptionsForScope = (
  scope?: RetrievalScope,
): UnifiedArtifactRetrievalOptions | undefined => {
  if (!scope || scope === "durable") return undefined;
  return {
    mode: "explicit-scope",
    scope: scope === "all" ? "all" : scope,
  };
};

type ArtifactCandidate = {
  artifact: ArtifactRecord;
  text: string;
  sectionTitle: string;
  path: string;
  scopeValue: "session" | "harness" | "evidence";
  evidenceId: string | null;
};

const escapeFilterLiteral = (value: string): string => value.replaceAll("'", "''");

const buildSnapshotPathFilter = (paths: string[]): string =>
  `path IN (${paths.map((entry) => `'${escapeFilterLiteral(entry)}'`).join(",")})`;

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

const SNAPSHOT_QUERY_OUTPUT_FIELDS = [
  "documentId",
  "documentVersionId",
  "sectionId",
  "sectionTitle",
  "path",
  "docType",
  "commitSha",
  "text",
  "tokenCount",
] as const;

const buildSnapshotHit = async (
  cwd: string,
  raw: { id: string; score: number; fields: Record<string, unknown> },
  query: string,
  alpha: number,
  scopeById: Map<string, RetrievalScope>,
  artifactEntryByChunkId: Map<string, NonNullable<SnapshotManifest["artifactEntries"]>[number]>,
): Promise<RetrievalHit> => {
  const chunk = hydrateChunk(raw);
  const scoreVector = zvecCosineDistanceToSimilarity(raw.score);
  const scoreKeyword = keywordScore(query, chunk.text);
  const hitScope = scopeById.get(chunk.id) ?? "durable";
  const artifactEntry = artifactEntryByChunkId.get(chunk.id);
  const artifact = artifactEntry ? await loadArtifactRecord(cwd, artifactEntry.artifactId) : null;
  const authority = authorityWeightForScope(hitScope, artifact?.authority);
  const recency = recencyWeight(artifact?.updatedAt);
  const scoreBreakdown = buildRetrievalScoreBreakdown({
    mode: "hybrid",
    scoreVector,
    scoreKeyword,
    alpha,
    authority,
    recency,
  });
  const sourceType = artifactEntry
    ? hitScope === "evidence" ? "evidence" : "artifact"
    : "document";
  const citation = buildRetrievalCitation({
    sourceType,
    sourceId: chunk.id,
    sourceVersion: chunk.documentVersionId,
    sourceSha: chunk.commitSha,
  });
  return {
    chunkId: chunk.id,
    path: chunk.path,
    sectionTitle: chunk.sectionTitle,
    scoreVector,
    scoreKeyword,
    scoreFinal: scoreBreakdown.final,
    scoreBreakdown,
    citation,
    text: chunk.text,
    scope: hitScope,
    originType: artifactEntry ? "artifact" : "document",
    artifactId: artifactEntry?.artifactId ?? null,
    artifactKind: artifactEntry?.kind ?? null,
    authority: artifact?.authority ?? (hitScope === "durable" ? "promoted_durable" : null),
    confidence: artifact?.confidence ?? null,
  };
};

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
          evidenceId: evidence.evidenceId,
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
      evidenceId: null,
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
    evidenceId: null,
  }));
};

const sourceShaForArtifact = (artifact: ArtifactRecord): string | null =>
  artifact.boundHeadSha ?? artifact.sourceHeadSha ?? artifact.captureHeadSha;

const buildArtifactHits = async (
  cwd: string,
  query: string,
  alpha: number,
  candidates: ArtifactCandidate[],
  semanticContext: ArtifactSemanticContext | null,
): Promise<RetrievalHit[]> => {
  if (candidates.length === 0) return [];
  const payloadClass = candidates.some((candidate) => candidate.scopeValue === "evidence") ? "evidence" : "artifact";
  const canEmbedCandidates =
    semanticContext !== null &&
    canUseRemoteEmbedding(semanticContext.config, semanticContext.embeddingProfile, payloadClass);
  const candidateEmbeddings = canEmbedCandidates
    ? await embedTexts(
        candidates.map((candidate) => candidate.text),
        semanticContext.embeddingProfile,
        semanticContext.embeddingOptions,
      )
    : [];
  return candidates.map((candidate, index) => {
    const semantic = canEmbedCandidates
      ? cosineSimilarity(semanticContext.queryEmbedding, candidateEmbeddings[index] ?? [])
      : 0;
    const keyword = keywordScore(query, candidate.text);
    const scoreBreakdown = buildRetrievalScoreBreakdown({
      mode: canEmbedCandidates ? "hybrid" : "keyword",
      scoreVector: semantic,
      scoreKeyword: keyword,
      alpha,
      authority: authorityWeightForArtifact(candidate.artifact, candidate.scopeValue),
      recency: recencyWeight(candidate.artifact.updatedAt),
    });
    const citation = buildRetrievalCitation({
      sourceType: candidate.evidenceId ? "evidence" : "artifact",
      sourceId: candidate.evidenceId
        ? `${candidate.artifact.artifactId}:${candidate.evidenceId}`
        : candidate.artifact.artifactId,
      sourceVersion: candidate.artifact.provenance.contentHash,
      sourceSha: sourceShaForArtifact(candidate.artifact),
    });
    return {
      chunkId:
        candidate.scopeValue === "evidence"
          ? `${candidate.artifact.artifactId}:${escapeFilterLiteral(candidate.path)}`
          : candidate.artifact.artifactId,
      path: toRepoPath(cwd, candidate.path.replace(/#.*$/, "")),
      sectionTitle: candidate.sectionTitle,
      scoreVector: semantic,
      scoreKeyword: keyword,
      scoreFinal: scoreBreakdown.final,
      scoreBreakdown,
      citation,
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
  store: CanonicalStore,
  snapshot: SnapshotManifest,
  query: string,
  queryEmbedding: number[],
  alpha: number,
  topK: number,
  scope: RetrievalScope,
): Promise<RetrievalHit[]> => {
  const { ids: manifestChunkIds, scopeById } = resolveChunkIdsForScope(snapshot, scope);
  const artifactEntryByChunkId = new Map(
    (snapshot.artifactEntries ?? []).flatMap((entry) => entry.chunkIds.map((chunkId) => [chunkId, entry] as const)),
  );
  const scopedVersionIds = new Set(
    snapshot.chunks
      .filter((chunk) => manifestChunkIds.includes(chunk.id))
      .map((chunk) => chunk.documentVersionId),
  );
  const scopedPaths = Array.from(
    new Set(snapshot.docs.filter((document) => scopedVersionIds.has(document.versionId)).map((document) => document.path)),
  );
  if (manifestChunkIds.length === 0 || scopedPaths.length === 0) return [];

  const batchSize = 200;
  const candidateLimit = Math.min(manifestChunkIds.length, Math.max(topK * 20, 100));
  const candidates = new Map<string, RetrievalHit>();

  for (let cursor = 0; cursor < scopedPaths.length; cursor += batchSize) {
    const slice = scopedPaths.slice(cursor, cursor + batchSize);
    const filter = buildSnapshotPathFilter(slice);
    const result = store.chunks.querySync({
      fieldName: "embedding",
      vector: queryEmbedding,
      topk: candidateLimit,
      filter,
      outputFields: SNAPSHOT_QUERY_OUTPUT_FIELDS as unknown as string[],
    });
    for (const raw of result) {
      const chunk = hydrateChunk(raw);
      if (!scopedVersionIds.has(chunk.documentVersionId)) continue;
      const hit = await buildSnapshotHit(cwd, raw, query, alpha, scopeById, artifactEntryByChunkId);
      const existing = candidates.get(hit.chunkId);
      if (existing && existing.scoreFinal >= hit.scoreFinal) continue;
      candidates.set(hit.chunkId, hit);
    }
  }

  return Array.from(candidates.values());
};

const retrievalIdentity = (hit: RetrievalHit): string =>
  hit.originType === "artifact" && hit.scope !== "evidence" && hit.artifactId ? hit.artifactId : hit.chunkId;

const finalizeHits = (hits: RetrievalHit[], topK: number): RetrievalHit[] => {
  const deduped = new Map<string, RetrievalHit>();
  for (const hit of hits) {
    const key = retrievalIdentity(hit);
    const existing = deduped.get(key);
    if (!existing || compareRetrievalHits(hit, existing) < 0) {
      deduped.set(key, hit);
    }
  }
  return Array.from(deduped.values())
    .sort(compareRetrievalHits)
    .slice(0, topK);
};

const unavailableSnapshotMetadata = (at?: string): SnapshotMetadata => ({
  requestedRef: at ?? "HEAD",
  resolvedSha: null,
  selection: at === undefined ? "head-exact" : "explicit-exact",
  status: "unavailable",
  branch: null,
  detached: false,
  worktreeDirty: false,
});

const snapshotStoreUnavailable = (
  selection: SnapshotSelection,
  error: unknown,
): RagitOperationalError =>
  new RagitOperationalError(
    "SNAPSHOT_STORE_UNAVAILABLE",
    `snapshot의 canonical store를 열 수 없습니다: ${selection.snapshotSha}`,
    {
      details: {
        resolvedSha: selection.snapshotSha,
        reason: error instanceof Error ? error.message : String(error),
      },
      recovery: { command: "ragit ingest --all" },
      cause: error,
    },
  );

const isDegradableRecallError = (
  error: unknown,
  recallMode: boolean,
): error is RagitOperationalError =>
  recallMode &&
  isRagitOperationalError(error) &&
  DEGRADABLE_RECALL_CODES.has(error.code);

const recallDegradationWarning = (error: RagitOperationalError): string =>
  `[${error.code}] snapshot을 사용할 수 없어 working memory와 artifact-derived content만 사용했습니다: ${error.message}`;

export const runUnifiedRetrieval = async (cwd: string, request: UnifiedRetrievalRequest): Promise<UnifiedRetrievalResult> => {
  const warnings: string[] = [];
  const recallMode = request.artifactOptions?.mode === "recall";
  let retrievalRoot = cwd;
  let selection: SnapshotSelection | null = null;
  let store: CanonicalStore | null = null;
  let isolatedStoreRoot: string | null = null;
  let snapshotSha: string | null = null;
  let snapshot = unavailableSnapshotMetadata(request.at);
  let degradedError: RagitOperationalError | null = null;

  if (request.includeSnapshot !== false) {
    try {
      selection = await selectSnapshot(cwd, request.at);
      retrievalRoot = selection.context.gitRoot;
      snapshot = selection.snapshot;
      warnings.push(...selection.warnings);
    } catch (error) {
      if (!isDegradableRecallError(error, recallMode)) throw error;
      degradedError = error;
      const context = await resolveRepositoryContext(cwd);
      retrievalRoot = context.gitRoot;
      snapshot = snapshotMetadataForUnavailable(context, request.at);
      warnings.push(recallDegradationWarning(error));
    }
  }

  const config = await loadConfig(retrievalRoot);
  let embeddingProfile: ReturnType<typeof resolveEmbeddingProfile> | null = null;

  if (degradedError === null) {
    embeddingProfile = resolveEmbeddingProfile(config);
    if (!canUseRemoteEmbedding(config, embeddingProfile, "query")) {
      throw new Error("현재 embedding provider는 remote egress가 필요하지만 security.remote_embedding_policy=local-only 입니다.");
    }
  }

  if (selection !== null && embeddingProfile !== null) {
    try {
      const opened = await openStoreForRetrieval(retrievalRoot, embeddingProfile, request.executionPolicy);
      store = opened.store;
      isolatedStoreRoot = opened.isolatedRoot;
      snapshotSha = selection.snapshotSha;
    } catch (error) {
      const mapped = snapshotStoreUnavailable(selection, error);
      if (!isDegradableRecallError(mapped, recallMode)) throw mapped;
      degradedError = mapped;
      snapshotSha = null;
      snapshot = { ...selection.snapshot, status: "unavailable" };
      warnings.push(recallDegradationWarning(mapped));
    }
  }

  try {
    const topK = request.topK ?? config.retrieval.top_k;
    const sanitizedQuery = sanitizeKnowledgeText(request.query, "retrieval.query", "query");
    let semanticContext: ArtifactSemanticContext | null = null;
    if (degradedError === null && embeddingProfile !== null) {
      const embeddingOptions = embeddingOptionsForRetrieval(
        retrievalRoot,
        embeddingProfile,
        request.executionPolicy,
      );
      semanticContext = {
        queryEmbedding: await embedText(sanitizedQuery.text, embeddingProfile, embeddingOptions),
        embeddingProfile,
        embeddingOptions,
        config,
      };
    }
    const hits: RetrievalHit[] = [];

    if (selection !== null && store !== null && semanticContext !== null) {
      hits.push(
        ...(await buildSnapshotHits(
          retrievalRoot,
          store,
          selection.manifest,
          sanitizedQuery.text,
          semanticContext.queryEmbedding,
          config.retrieval.alpha,
          topK,
          request.scope ?? "durable",
        )),
      );
    }

    if (request.artifactOptions) {
      const candidates =
        request.artifactOptions.mode === "recall"
          ? await buildRecallArtifactCandidates(
              retrievalRoot,
              request.artifactOptions.goal ?? sanitizedQuery.text,
            )
          : await buildExplicitArtifactCandidates(
              retrievalRoot,
              request.artifactOptions.scope ?? "all",
            );
      const allowsArtifactEmbedding =
        semanticContext !== null &&
        canUseRemoteEmbedding(
          config,
          semanticContext.embeddingProfile,
          request.artifactOptions.scope === "evidence" ? "evidence" : "artifact",
        );
      if (semanticContext !== null && !allowsArtifactEmbedding && candidates.length > 0) {
        warnings.push("security policy 때문에 artifact/evidence semantic embedding을 건너뛰고 keyword fallback으로 검색했습니다.");
      }
      hits.push(
        ...(await buildArtifactHits(
          retrievalRoot,
          sanitizedQuery.text,
          config.retrieval.alpha,
          candidates,
          semanticContext,
        )),
      );
    }

    const finalizedHits = finalizeHits(hits, topK);
    const sanitizedHits = sanitizeStructuredValue(finalizedHits, "retrieval.hit", "hits");

    return {
      snapshotSha,
      snapshot,
      hits: sanitizedHits.value,
      warnings,
      redactionSummary: mergeRedactionSummaries(sanitizedQuery.summary, sanitizedHits.summary),
    };
  } finally {
    try {
      if (store !== null) closeCanonicalStore(store);
    } finally {
      if (isolatedStoreRoot !== null) {
        await rm(isolatedStoreRoot, { recursive: true, force: true });
      }
    }
  }
};

export const searchKnowledge = async (cwd: string, query: string, options: QueryOptions): Promise<QueryResult> => {
  const result = await runUnifiedRetrieval(cwd, {
    query,
    topK: options.topK,
    at: options.at,
    scope: options.scope,
    includeSnapshot: true,
    artifactOptions: resolveArtifactOptionsForScope(options.scope),
    executionPolicy: options.executionPolicy,
  });
  if (!result.snapshotSha) {
    throw new Error("사용 가능한 snapshot이 없습니다.");
  }
  return {
    snapshotSha: result.snapshotSha,
    snapshot: result.snapshot,
    hits: result.hits,
    warnings: result.warnings,
    redactionSummary: result.redactionSummary,
  };
};
