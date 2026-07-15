import { loadConfig } from "./config.js";
import { chunkSections } from "./chunk.js";
import { embedTexts, resolveEmbeddingProfile, toEmbeddingContract } from "./embedding.js";
import { RagitOperationalError } from "./errors.js";
import { deleteIngestTransaction } from "./ingest-transaction.js";
import { scanIngestTransactions } from "./ingest-recovery.js";
import { chunkVersionId } from "./identity.js";
import { listSnapshotShas, loadSnapshotManifest } from "./manifest.js";
import { readCanonicalStoreMeta, bootstrapCanonicalStoreAtPath, closeCanonicalStore, openCanonicalStoreWithContract, writeChunksToCanonicalStore, writeDocumentsToCanonicalStore } from "./store.js";
import { assertStoreSwapReady, promoteNextStore, removeNextStore, storeSwapPaths, StoreSwapDependencies } from "./store-swap.js";
import { ArtifactManifestEntry, ChunkRecord, DocumentRecord, EmbeddingProfile, SnapshotManifest } from "./types.js";

type RebuildChunk = Omit<ChunkRecord, "embedding">;

interface SnapshotChunkReference {
  id: string;
  documentId: string;
  documentVersionId: string;
}

interface ManifestRebuildPlan {
  manifests: number;
  documents: DocumentRecord[];
  references: Map<string, SnapshotChunkReference>;
  durableChunkIds: Set<string>;
  artifactChunks: Map<string, RebuildChunk>;
  legacyArtifacts: Map<string, string>;
}

export interface StoreRebuildInspection {
  manifests: number;
  documents: number;
  chunks: number;
  legacyChunks: number;
}

export interface StoreRebuildSummary extends StoreRebuildInspection {
  terminalTransactionsRemoved: number;
}

export interface StoreRebuildDependencies {
  swap?: StoreSwapDependencies;
}

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

const rebuildError = (
  code: "STORE_REBUILD_UNREBUILDABLE" | "STORE_REBUILD_VERIFICATION_FAILED" | "STORE_REBUILD_PROMOTION_FAILED",
  reason: string,
  details: Record<string, unknown> = {},
  cause?: unknown,
): RagitOperationalError =>
  new RagitOperationalError(code, `canonical store를 rebuild할 수 없습니다: ${reason}`, {
    details: { reason, ...details },
    recovery: { command: "ragit repair --apply --action store-rebuild" },
    ...(cause === undefined ? {} : { cause }),
  });

const same = (left: unknown, right: unknown): boolean => stableJson(left) === stableJson(right);

const addDocument = (documents: Map<string, DocumentRecord>, document: DocumentRecord): void => {
  const existing = documents.get(document.versionId);
  if (existing && !same(existing, document)) {
    throw rebuildError("STORE_REBUILD_UNREBUILDABLE", "같은 document version의 manifest 내용이 충돌합니다.", {
      documentVersionId: document.versionId,
    });
  }
  documents.set(document.versionId, document);
};

const addReference = (references: Map<string, SnapshotChunkReference>, reference: SnapshotChunkReference): void => {
  const existing = references.get(reference.id);
  if (existing && !same(existing, reference)) {
    throw rebuildError("STORE_REBUILD_UNREBUILDABLE", "같은 chunk id의 manifest 참조가 충돌합니다.", { chunkId: reference.id });
  }
  references.set(reference.id, reference);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isOptionalString = (value: unknown): value is string | null | undefined =>
  value === undefined || value === null || typeof value === "string";

const parsePayloadChunk = (value: unknown, artifactId: string): RebuildChunk => {
  if (!isRecord(value) || "embedding" in value) {
    throw rebuildError("STORE_REBUILD_UNREBUILDABLE", "artifact rebuild payload chunk 형식이 올바르지 않습니다.", { artifactId });
  }
  const required = ["id", "documentId", "documentVersionId", "sectionId", "sectionTitle", "path", "docType", "commitSha", "text"] as const;
  if (required.some((field) => typeof value[field] !== "string") ||
    typeof value.tokenCount !== "number" || !Number.isInteger(value.tokenCount) || value.tokenCount < 0 ||
    value.originType !== "artifact" || value.artifactId !== artifactId) {
    throw rebuildError("STORE_REBUILD_UNREBUILDABLE", "artifact rebuild payload chunk의 canonical 필드가 올바르지 않습니다.", { artifactId });
  }
  const stringOrNull = ["artifactKind", "tier", "status", "authority", "goalId", "episodeId", "sourceSessionId", "bindingStatus", "searchPolicy"] as const;
  if (stringOrNull.some((field) => !isOptionalString(value[field])) ||
    !(value.confidence === undefined || value.confidence === null || typeof value.confidence === "number")) {
    throw rebuildError("STORE_REBUILD_UNREBUILDABLE", "artifact rebuild payload의 optional 필드가 올바르지 않습니다.", { artifactId });
  }
  return {
    id: value.id as string,
    documentId: value.documentId as string,
    documentVersionId: value.documentVersionId as string,
    sectionId: value.sectionId as string,
    sectionTitle: value.sectionTitle as string,
    path: value.path as string,
    docType: value.docType as ChunkRecord["docType"],
    commitSha: value.commitSha as string,
    text: value.text as string,
    tokenCount: value.tokenCount as number,
    originType: "artifact",
    artifactId,
    ...(value.artifactKind === undefined ? {} : { artifactKind: value.artifactKind as ChunkRecord["artifactKind"] }),
    ...(value.tier === undefined ? {} : { tier: value.tier as ChunkRecord["tier"] }),
    ...(value.status === undefined ? {} : { status: value.status as ChunkRecord["status"] }),
    ...(value.authority === undefined ? {} : { authority: value.authority as ChunkRecord["authority"] }),
    ...(value.confidence === undefined ? {} : { confidence: value.confidence as number | null }),
    ...(value.goalId === undefined ? {} : { goalId: value.goalId as string | null }),
    ...(value.episodeId === undefined ? {} : { episodeId: value.episodeId as string | null }),
    ...(value.sourceSessionId === undefined ? {} : { sourceSessionId: value.sourceSessionId as string | null }),
    ...(value.bindingStatus === undefined ? {} : { bindingStatus: value.bindingStatus as ChunkRecord["bindingStatus"] }),
    ...(value.searchPolicy === undefined ? {} : { searchPolicy: value.searchPolicy as ChunkRecord["searchPolicy"] }),
  };
};

const checkedArtifactEntry = (value: unknown): ArtifactManifestEntry => {
  if (!isRecord(value) || typeof value.artifactId !== "string" || !Array.isArray(value.chunkIds) || value.chunkIds.some((id) => typeof id !== "string")) {
    throw rebuildError("STORE_REBUILD_UNREBUILDABLE", "artifact manifest entry 형식이 올바르지 않습니다.");
  }
  return value as unknown as ArtifactManifestEntry;
};

const validateArtifactPayload = (
  entry: ArtifactManifestEntry,
  references: Map<string, SnapshotChunkReference>,
  artifactChunks: Map<string, RebuildChunk>,
): void => {
  const payload = entry.rebuildPayload;
  if (!payload || payload.schemaVersion !== 1 || !Array.isArray(payload.chunks)) {
    throw rebuildError("STORE_REBUILD_UNREBUILDABLE", "artifact rebuild payload가 올바르지 않습니다.", { artifactId: entry.artifactId });
  }
  const expectedIds = new Set(entry.chunkIds);
  if (expectedIds.size !== entry.chunkIds.length || payload.chunks.length !== expectedIds.size) {
    throw rebuildError("STORE_REBUILD_UNREBUILDABLE", "artifact rebuild payload가 entry chunk ids를 완전히 설명하지 않습니다.", { artifactId: entry.artifactId });
  }
  const payloadIds = new Set<string>();
  for (const rawChunk of payload.chunks) {
    const chunk = parsePayloadChunk(rawChunk, entry.artifactId);
    if (payloadIds.has(chunk.id)) {
      throw rebuildError("STORE_REBUILD_UNREBUILDABLE", "artifact rebuild payload에 중복 chunk id가 있습니다.", {
        artifactId: entry.artifactId,
        chunkId: chunk.id,
      });
    }
    payloadIds.add(chunk.id);
    const reference = references.get(chunk.id);
    if (!expectedIds.has(chunk.id) || !reference ||
      reference.documentId !== chunk.documentId || reference.documentVersionId !== chunk.documentVersionId) {
      throw rebuildError("STORE_REBUILD_UNREBUILDABLE", "artifact rebuild payload와 manifest chunk 참조가 일치하지 않습니다.", {
        artifactId: entry.artifactId,
        chunkId: chunk.id,
      });
    }
    const existing = artifactChunks.get(chunk.id);
    if (existing && !same(existing, chunk)) {
      throw rebuildError("STORE_REBUILD_UNREBUILDABLE", "artifact rebuild payload chunk이 충돌합니다.", { chunkId: chunk.id });
    }
    artifactChunks.set(chunk.id, chunk);
  }
  if (payloadIds.size !== expectedIds.size || Array.from(expectedIds).some((id) => !payloadIds.has(id))) {
    throw rebuildError("STORE_REBUILD_UNREBUILDABLE", "artifact rebuild payload가 entry chunk ids를 완전히 설명하지 않습니다.", { artifactId: entry.artifactId });
  }
};

const collectManifestPlan = async (cwd: string): Promise<ManifestRebuildPlan> => {
  const documents = new Map<string, DocumentRecord>();
  const references = new Map<string, SnapshotChunkReference>();
  const durableChunkIds = new Set<string>();
  const manifests: SnapshotManifest[] = [];
  for (const sha of await listSnapshotShas(cwd)) {
    const manifest = await loadSnapshotManifest(cwd, sha);
    manifests.push(manifest);
    for (const document of manifest.docs) addDocument(documents, document);
    for (const chunk of manifest.chunks) addReference(references, chunk);
    for (const chunkId of manifest.chunkScopes?.durable ?? []) durableChunkIds.add(chunkId);
  }

  const artifactChunks = new Map<string, RebuildChunk>();
  const legacyArtifacts = new Map<string, string>();
  const artifactOwners = new Map<string, string>();
  for (const manifest of manifests) {
    for (const rawEntry of manifest.artifactEntries ?? []) {
      const entry = checkedArtifactEntry(rawEntry);
      for (const chunkId of entry.chunkIds) {
        const existingOwner = artifactOwners.get(chunkId);
        if (existingOwner && existingOwner !== entry.artifactId) {
          throw rebuildError("STORE_REBUILD_UNREBUILDABLE", "같은 artifact chunk id의 소유자가 충돌합니다.", { chunkId });
        }
        artifactOwners.set(chunkId, entry.artifactId);
      }
      if (entry.rebuildPayload !== undefined) {
        validateArtifactPayload(entry, references, artifactChunks);
      } else {
        for (const chunkId of entry.chunkIds) {
          if (!references.has(chunkId)) {
            throw rebuildError("STORE_REBUILD_UNREBUILDABLE", "legacy artifact chunk 참조가 누락되었습니다.", { chunkId });
          }
          const existingOwner = legacyArtifacts.get(chunkId);
          if (existingOwner && existingOwner !== entry.artifactId) {
            throw rebuildError("STORE_REBUILD_UNREBUILDABLE", "같은 legacy artifact chunk id의 소유자가 충돌합니다.", { chunkId });
          }
          legacyArtifacts.set(chunkId, entry.artifactId);
        }
      }
    }
  }
  for (const chunkId of durableChunkIds) {
    if (!references.has(chunkId)) throw rebuildError("STORE_REBUILD_UNREBUILDABLE", "durable chunk scope 참조가 누락되었습니다.", { chunkId });
    if (artifactOwners.has(chunkId)) durableChunkIds.delete(chunkId);
  }
  for (const chunkId of references.keys()) {
    if (!durableChunkIds.has(chunkId) && !artifactChunks.has(chunkId) && !legacyArtifacts.has(chunkId)) {
      throw rebuildError("STORE_REBUILD_UNREBUILDABLE", "manifest chunk의 rebuild source를 판별할 수 없습니다.", { chunkId });
    }
  }
  return {
    manifests: manifests.length,
    documents: Array.from(documents.values()).sort((left, right) => left.versionId.localeCompare(right.versionId)),
    references,
    durableChunkIds,
    artifactChunks,
    legacyArtifacts,
  };
};

const durableChunks = (plan: ManifestRebuildPlan): RebuildChunk[] => {
  const generated = new Map<string, RebuildChunk>();
  for (const document of plan.documents) {
    for (const [index, section] of chunkSections(document.sections).entries()) {
      const chunk: RebuildChunk = {
        id: chunkVersionId(document.versionId, section.sectionId, index, section.text),
        documentId: document.id,
        documentVersionId: document.versionId,
        sectionId: section.sectionId,
        sectionTitle: section.sectionTitle,
        path: document.path,
        docType: document.docType,
        commitSha: document.commitSha,
        text: section.text,
        tokenCount: section.tokenCount,
      };
      generated.set(chunk.id, chunk);
    }
  }
  const selected: RebuildChunk[] = [];
  for (const chunkId of Array.from(plan.durableChunkIds).sort((left, right) => left.localeCompare(right))) {
    const chunk = generated.get(chunkId);
    const reference = plan.references.get(chunkId);
    if (!chunk || !reference || chunk.documentId !== reference.documentId || chunk.documentVersionId !== reference.documentVersionId) {
      throw rebuildError("STORE_REBUILD_UNREBUILDABLE", "durable chunk을 manifest document sections에서 재생성할 수 없습니다.", { chunkId });
    }
    selected.push(chunk);
  }
  return selected;
};

const vectorToNumbers = (value: unknown): number[] => {
  if (Array.isArray(value)) return value.map((entry) => Number(entry));
  if (value && typeof value === "object" && "length" in value) return Array.from(value as ArrayLike<number>, (entry) => Number(entry));
  return [];
};

const fetchedArtifactChunk = (raw: { id: string; vectors: Record<string, unknown>; fields: Record<string, unknown> }): ChunkRecord => ({
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
  embedding: vectorToNumbers(raw.vectors.embedding),
  originType: raw.fields.originType === "artifact" ? "artifact" : undefined,
  artifactId: typeof raw.fields.artifactId === "string" && raw.fields.artifactId ? raw.fields.artifactId : null,
  artifactKind: typeof raw.fields.artifactKind === "string" && raw.fields.artifactKind ? raw.fields.artifactKind as ChunkRecord["artifactKind"] : null,
  tier: typeof raw.fields.tier === "string" && raw.fields.tier ? raw.fields.tier as ChunkRecord["tier"] : null,
  status: typeof raw.fields.status === "string" && raw.fields.status ? raw.fields.status as ChunkRecord["status"] : null,
  authority: typeof raw.fields.authority === "string" && raw.fields.authority ? raw.fields.authority as ChunkRecord["authority"] : null,
  confidence: typeof raw.fields.confidence === "number" && raw.fields.confidence >= 0 ? raw.fields.confidence : null,
  goalId: typeof raw.fields.goalId === "string" && raw.fields.goalId ? raw.fields.goalId : null,
  episodeId: typeof raw.fields.episodeId === "string" && raw.fields.episodeId ? raw.fields.episodeId : null,
  sourceSessionId: typeof raw.fields.sourceSessionId === "string" && raw.fields.sourceSessionId ? raw.fields.sourceSessionId : null,
  bindingStatus: typeof raw.fields.bindingStatus === "string" && raw.fields.bindingStatus ? raw.fields.bindingStatus as ChunkRecord["bindingStatus"] : null,
  searchPolicy: typeof raw.fields.searchPolicy === "string" && raw.fields.searchPolicy ? raw.fields.searchPolicy as ChunkRecord["searchPolicy"] : null,
});

const loadLegacyArtifactChunks = async (cwd: string, plan: ManifestRebuildPlan): Promise<RebuildChunk[]> => {
  const ids = Array.from(plan.legacyArtifacts.keys())
    .filter((id) => !plan.artifactChunks.has(id))
    .sort((left, right) => left.localeCompare(right));
  if (ids.length === 0) return [];
  let meta;
  try {
    meta = await readCanonicalStoreMeta(cwd);
  } catch (error) {
    throw rebuildError("STORE_REBUILD_UNREBUILDABLE", "legacy artifact source store meta를 읽을 수 없습니다.", {}, error);
  }
  if (!meta) throw rebuildError("STORE_REBUILD_UNREBUILDABLE", "legacy artifact chunk에는 기존 source store가 필요합니다.", { legacyChunks: ids.length });
  let store;
  try {
    store = await openCanonicalStoreWithContract(cwd, meta.embeddingContract, true);
    const fetched = store.chunks.fetchSync(ids);
    if (ids.some((id) => !(id in fetched))) {
      throw rebuildError("STORE_REBUILD_UNREBUILDABLE", "legacy artifact chunk을 source store에서 찾을 수 없습니다.", {
        missingChunkIds: ids.filter((id) => !(id in fetched)),
      });
    }
    return ids.map((id) => {
      const chunk = fetchedArtifactChunk(fetched[id]!);
      const reference = plan.references.get(id);
      if (chunk.originType !== "artifact" || chunk.artifactId !== plan.legacyArtifacts.get(id) || !reference ||
        chunk.documentId !== reference.documentId || chunk.documentVersionId !== reference.documentVersionId) {
        throw rebuildError("STORE_REBUILD_UNREBUILDABLE", "legacy artifact source record가 manifest와 일치하지 않습니다.", { chunkId: id });
      }
      const { embedding: _embedding, ...withoutEmbedding } = chunk;
      return withoutEmbedding;
    });
  } catch (error) {
    if (error instanceof RagitOperationalError) throw error;
    throw rebuildError("STORE_REBUILD_UNREBUILDABLE", "legacy artifact source store를 열 수 없습니다.", {}, error);
  } finally {
    if (store) closeCanonicalStore(store);
  }
};

const verifyNextStore = async (
  cwd: string,
  profile: EmbeddingProfile,
  documents: DocumentRecord[],
  chunks: ChunkRecord[],
): Promise<void> => {
  const next = await bootstrapCanonicalStoreAtPath(cwd, toEmbeddingContract(profile), true, storeSwapPaths(cwd).next);
  try {
    const documentIds = documents.map((document) => document.versionId);
    const chunkIds = chunks.map((chunk) => chunk.id);
    const fetchedDocuments = documentIds.length === 0 ? {} : next.documents.fetchSync(documentIds);
    const fetchedChunks = chunkIds.length === 0 ? {} : next.chunks.fetchSync(chunkIds);
    const missingDocumentVersionIds = documentIds.filter((id) => !(id in fetchedDocuments));
    const missingChunkIds = chunkIds.filter((id) => !(id in fetchedChunks));
    if (missingDocumentVersionIds.length > 0 || missingChunkIds.length > 0 ||
      next.documents.stats.docCount !== documents.length || next.chunks.stats.docCount !== chunks.length) {
      throw rebuildError("STORE_REBUILD_VERIFICATION_FAILED", "next store의 manifest union 검증에 실패했습니다.", {
        missingDocumentVersionIds,
        missingChunkIds,
        expectedDocuments: documents.length,
        actualDocuments: next.documents.stats.docCount,
        expectedChunks: chunks.length,
        actualChunks: next.chunks.stats.docCount,
      });
    }
  } finally {
    closeCanonicalStore(next);
  }
};

const removeTerminalTransactions = async (cwd: string): Promise<number> => {
  const diagnostics = await scanIngestTransactions(cwd);
  const removable = diagnostics.transactions.filter((transaction) =>
    transaction.classification === "completed" ||
    (transaction.classification === "precommit-incomplete" && transaction.status === "failed-precommit"),
  );
  for (const transaction of removable) await deleteIngestTransaction(cwd, transaction.transactionId);
  return removable.length;
};

export const inspectStoreRebuild = async (cwd: string): Promise<StoreRebuildInspection> => {
  const plan = await collectManifestPlan(cwd);
  return {
    manifests: plan.manifests,
    documents: plan.documents.length,
    chunks: plan.references.size,
    legacyChunks: Array.from(plan.legacyArtifacts.keys()).filter((id) => !plan.artifactChunks.has(id)).length,
  };
};

export const rebuildStoreFromManifests = async (
  cwd: string,
  dependencies: StoreRebuildDependencies = {},
): Promise<StoreRebuildSummary> => {
  await assertStoreSwapReady(cwd);
  const plan = await collectManifestPlan(cwd);
  const profile = resolveEmbeddingProfile(await loadConfig(cwd));
  const durable = durableChunks(plan);
  const legacy = await loadLegacyArtifactChunks(cwd, plan);
  const chunksById = new Map<string, RebuildChunk>();
  for (const chunk of [...durable, ...plan.artifactChunks.values(), ...legacy]) {
    const existing = chunksById.get(chunk.id);
    if (existing && !same(existing, chunk)) {
      throw rebuildError("STORE_REBUILD_UNREBUILDABLE", "rebuild chunk 내용이 충돌합니다.", { chunkId: chunk.id });
    }
    chunksById.set(chunk.id, chunk);
  }
  if (chunksById.size !== plan.references.size) {
    throw rebuildError("STORE_REBUILD_UNREBUILDABLE", "manifest chunk union을 완전히 재생성하지 못했습니다.", {
      expectedChunks: plan.references.size,
      rebuiltChunks: chunksById.size,
    });
  }
  const chunksWithoutEmbedding = Array.from(chunksById.values()).sort((left, right) => left.id.localeCompare(right.id));
  const embeddings = await embedTexts(chunksWithoutEmbedding.map((chunk) => chunk.text), profile, { cwd, cacheMode: "readwrite" });
  const chunks = chunksWithoutEmbedding.map((chunk, index) => ({ ...chunk, embedding: embeddings[index] ?? [] }));
  let promoted = false;
  try {
    const next = await bootstrapCanonicalStoreAtPath(cwd, toEmbeddingContract(profile), false, storeSwapPaths(cwd).next);
    try {
      writeDocumentsToCanonicalStore(next, plan.documents);
      writeChunksToCanonicalStore(next, chunks);
    } finally {
      closeCanonicalStore(next);
    }
    await verifyNextStore(cwd, profile, plan.documents, chunks);
    try {
      await promoteNextStore(cwd, dependencies.swap);
    } catch (error) {
      throw rebuildError("STORE_REBUILD_PROMOTION_FAILED", "next store promotion에 실패했습니다.", {}, error);
    }
    promoted = true;
    const terminalTransactionsRemoved = await removeTerminalTransactions(cwd);
    return {
      manifests: plan.manifests,
      documents: plan.documents.length,
      chunks: chunks.length,
      legacyChunks: Array.from(plan.legacyArtifacts.keys()).filter((id) => !plan.artifactChunks.has(id)).length,
      terminalTransactionsRemoved,
    };
  } catch (error) {
    if (!promoted) await removeNextStore(cwd);
    throw error;
  }
};
