import { access, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import * as zvecBinding from "@zvec/zvec";
import type { ZVecCollection, ZVecFieldSchema, ZVecVectorSchema } from "@zvec/zvec";
import { zeroVector } from "./embedding.js";
import { resolveRagitPaths } from "./project.js";
import { ChunkRecord, DocumentRecord, RagitConfig } from "./types.js";

const {
  ZVecCollectionSchema,
  ZVecCreateAndOpen,
  ZVecDataType,
  ZVecIndexType,
  ZVecInitialize,
  ZVecLogLevel,
  ZVecMetricType,
  ZVecOpen,
} = zvecBinding;

type ZVecCollectionSchemaInstance = InstanceType<typeof zvecBinding.ZVecCollectionSchema>;

const STORE_LAYOUT_VERSION = 1;
const STORE_SCHEMA_VERSION = 1;

export interface EmbeddingContract {
  provider: RagitConfig["embedding"]["provider"];
  dimensions: number;
  version: string;
}

export interface CanonicalStoreMeta {
  layoutVersion: number;
  schemaVersion: number;
  backend: "zvec";
  collections: {
    documents: string;
    chunks: string;
  };
  embeddingContract: EmbeddingContract;
}

export interface CanonicalStoreBootstrapSummary {
  backend: "zvec";
  status: "created" | "loaded";
  collections: string[];
  searchReady: boolean;
  migrationRequired: boolean;
  schemaVersion: number;
}

export interface CanonicalStore {
  documents: ZVecCollection;
  chunks: ZVecCollection;
  meta: CanonicalStoreMeta;
  status: "created" | "loaded";
}

let runtimeInitialized = false;

const fileExists = async (target: string): Promise<boolean> => {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

export const isZvecPlatformSupported = (): boolean => {
  if (process.platform === "darwin") return process.arch === "arm64";
  if (process.platform === "linux") return process.arch === "arm64" || process.arch === "x64";
  return false;
};

export const ensureZvecRuntime = (): void => {
  if (!isZvecPlatformSupported()) {
    throw new Error(`현재 플랫폼에서는 zvec를 지원하지 않습니다: ${process.platform}/${process.arch}`);
  }
  if (runtimeInitialized) return;
  ZVecInitialize({
    logLevel: ZVecLogLevel.ERROR,
  });
  runtimeInitialized = true;
};

const buildDocumentSchema = (dimensions: number): ZVecCollectionSchemaInstance =>
  new ZVecCollectionSchema({
    name: "documents",
    vectors: {
      name: "embedding",
      dataType: ZVecDataType.VECTOR_FP32,
      dimension: dimensions,
      indexParams: {
        indexType: ZVecIndexType.FLAT,
        metricType: ZVecMetricType.COSINE,
      },
    },
    fields: [
      { name: "id", dataType: ZVecDataType.STRING, indexParams: { indexType: ZVecIndexType.INVERT } },
      { name: "versionId", dataType: ZVecDataType.STRING, indexParams: { indexType: ZVecIndexType.INVERT } },
      { name: "path", dataType: ZVecDataType.STRING, indexParams: { indexType: ZVecIndexType.INVERT } },
      { name: "docType", dataType: ZVecDataType.STRING, indexParams: { indexType: ZVecIndexType.INVERT } },
      { name: "commitSha", dataType: ZVecDataType.STRING, indexParams: { indexType: ZVecIndexType.INVERT } },
      { name: "hash", dataType: ZVecDataType.STRING, indexParams: { indexType: ZVecIndexType.INVERT } },
    ],
  });

const buildChunkSchema = (dimensions: number): ZVecCollectionSchemaInstance =>
  new ZVecCollectionSchema({
    name: "chunks",
    vectors: {
      name: "embedding",
      dataType: ZVecDataType.VECTOR_FP32,
      dimension: dimensions,
      indexParams: {
        indexType: ZVecIndexType.FLAT,
        metricType: ZVecMetricType.COSINE,
      },
    },
    fields: [
      { name: "id", dataType: ZVecDataType.STRING, indexParams: { indexType: ZVecIndexType.INVERT } },
      { name: "documentId", dataType: ZVecDataType.STRING, indexParams: { indexType: ZVecIndexType.INVERT } },
      { name: "documentVersionId", dataType: ZVecDataType.STRING, indexParams: { indexType: ZVecIndexType.INVERT } },
      { name: "path", dataType: ZVecDataType.STRING, indexParams: { indexType: ZVecIndexType.INVERT } },
      { name: "docType", dataType: ZVecDataType.STRING, indexParams: { indexType: ZVecIndexType.INVERT } },
      { name: "commitSha", dataType: ZVecDataType.STRING, indexParams: { indexType: ZVecIndexType.INVERT } },
      { name: "sectionId", dataType: ZVecDataType.STRING, indexParams: { indexType: ZVecIndexType.INVERT } },
      { name: "sectionTitle", dataType: ZVecDataType.STRING, indexParams: { indexType: ZVecIndexType.INVERT } },
      { name: "text", dataType: ZVecDataType.STRING, indexParams: { indexType: ZVecIndexType.INVERT } },
      { name: "tokenCount", dataType: ZVecDataType.INT64, indexParams: { indexType: ZVecIndexType.INVERT } },
    ],
  });

const normalizeScalarSchema = (collection: ZVecCollection): string =>
  collection.schema
    .fields()
    .map((field: ZVecFieldSchema) => ({
      dataType: field.dataType,
      indexType: field.indexParams?.indexType ?? null,
      name: field.name,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((field) => `${field.name}:${field.dataType}:${field.indexType ?? "none"}`)
    .join("|");

const normalizeVectorSchema = (collection: ZVecCollection): string =>
  collection.schema
    .vectors()
    .map((vector: ZVecVectorSchema) => ({
      dataType: vector.dataType,
      dimension: vector.dimension ?? 0,
      indexType: vector.indexParams?.indexType ?? null,
      metricType: "metricType" in (vector.indexParams ?? {}) ? vector.indexParams?.metricType ?? null : null,
      name: vector.name,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((vector) => `${vector.name}:${vector.dataType}:${vector.dimension}:${vector.indexType ?? "none"}:${vector.metricType ?? "none"}`)
    .join("|");

const assertCollectionSchema = (collection: ZVecCollection, expected: ZVecCollectionSchemaInstance, label: string): void => {
  const expectedScalars = expected
    .fields()
    .map((field: ZVecFieldSchema) => `${field.name}:${field.dataType}:${field.indexParams?.indexType ?? "none"}`)
    .sort()
    .join("|");
  const expectedVectors = expected
    .vectors()
    .map(
      (vector: ZVecVectorSchema) =>
        `${vector.name}:${vector.dataType}:${vector.dimension ?? 0}:${vector.indexParams?.indexType ?? "none"}:${"metricType" in (vector.indexParams ?? {}) ? vector.indexParams?.metricType ?? "none" : "none"}`,
    )
    .sort()
    .join("|");
  const actualScalars = normalizeScalarSchema(collection);
  const actualVectors = normalizeVectorSchema(collection);
  if (expectedScalars !== actualScalars || expectedVectors !== actualVectors) {
    throw new Error(`${label} collection schema가 현재 ragit 기대값과 다릅니다.`);
  }
};

const readStoreMeta = async (cwd: string): Promise<CanonicalStoreMeta | null> => {
  const target = resolveRagitPaths(cwd).storeMetaPath;
  try {
    const content = await readFile(target, "utf8");
    return JSON.parse(content) as CanonicalStoreMeta;
  } catch {
    return null;
  }
};

const writeStoreMeta = async (cwd: string, meta: CanonicalStoreMeta): Promise<void> => {
  const target = resolveRagitPaths(cwd).storeMetaPath;
  await writeFile(target, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
};

const buildMeta = (embedding: EmbeddingContract): CanonicalStoreMeta => ({
  layoutVersion: STORE_LAYOUT_VERSION,
  schemaVersion: STORE_SCHEMA_VERSION,
  backend: "zvec",
  collections: {
    documents: "documents",
    chunks: "chunks",
  },
  embeddingContract: embedding,
});

const assertMetaCompatible = (meta: CanonicalStoreMeta, embedding: EmbeddingContract): void => {
  if (meta.backend !== "zvec") {
    throw new Error(`지원하지 않는 store backend 입니다: ${meta.backend}`);
  }
  if (meta.layoutVersion !== STORE_LAYOUT_VERSION) {
    throw new Error(`store layout version mismatch: ${meta.layoutVersion}`);
  }
  if (meta.schemaVersion !== STORE_SCHEMA_VERSION) {
    throw new Error(`store schema version mismatch: ${meta.schemaVersion}`);
  }
  if (
    meta.embeddingContract.provider !== embedding.provider ||
    meta.embeddingContract.dimensions !== embedding.dimensions ||
    meta.embeddingContract.version !== embedding.version
  ) {
    throw new Error("embedding contract가 현재 설정과 다릅니다.");
  }
};

export const hasLegacyJsonStore = async (cwd: string): Promise<boolean> => fileExists(path.join(resolveRagitPaths(cwd).storeDir, "index.json"));

export const bootstrapCanonicalStore = async (
  cwd: string,
  embedding: EmbeddingContract,
  readOnly = false,
): Promise<CanonicalStore> => {
  const paths = resolveRagitPaths(cwd);
  ensureZvecRuntime();
  const meta = await readStoreMeta(cwd);
  const documentsExists = await fileExists(paths.documentsCollectionDir);
  const chunksExists = await fileExists(paths.chunksCollectionDir);
  const hasCollections = documentsExists || chunksExists;
  const documentsSchema = buildDocumentSchema(embedding.dimensions);
  const chunksSchema = buildChunkSchema(embedding.dimensions);

  if (!hasCollections && !meta) {
    if (readOnly) {
      throw new Error("zvec store가 아직 초기화되지 않았습니다. 먼저 ragit init을 실행해 주세요.");
    }
    const documents = ZVecCreateAndOpen(paths.documentsCollectionDir, documentsSchema, { readOnly: false, enableMMAP: true });
    const chunks = ZVecCreateAndOpen(paths.chunksCollectionDir, chunksSchema, { readOnly: false, enableMMAP: true });
    const createdMeta = buildMeta(embedding);
    await writeStoreMeta(cwd, createdMeta);
    return {
      documents,
      chunks,
      meta: createdMeta,
      status: "created",
    };
  }

  if (!documentsExists || !chunksExists || !meta) {
    throw new Error("zvec store가 부분 초기화 상태입니다. .ragit/store를 정리하거나 migrate를 실행해 주세요.");
  }

  assertMetaCompatible(meta, embedding);
  const documents = ZVecOpen(paths.documentsCollectionDir, { readOnly, enableMMAP: true });
  const chunks = ZVecOpen(paths.chunksCollectionDir, { readOnly, enableMMAP: true });
  assertCollectionSchema(documents, documentsSchema, "documents");
  assertCollectionSchema(chunks, chunksSchema, "chunks");

  return {
    documents,
    chunks,
    meta,
    status: "loaded",
  };
};

export const closeCanonicalStore = (store: CanonicalStore): void => {
  store.documents.closeSync();
  store.chunks.closeSync();
};

const toDocumentInput = (document: DocumentRecord, dimensions: number) => ({
  id: document.versionId,
  vectors: {
    embedding: zeroVector(dimensions),
  },
  fields: {
    id: document.id,
    versionId: document.versionId,
    path: document.path,
    docType: document.docType,
    commitSha: document.commitSha,
    hash: document.hash,
  },
});

const toChunkInput = (chunk: ChunkRecord) => ({
  id: chunk.id,
  vectors: {
    embedding: chunk.embedding,
  },
  fields: {
    id: chunk.id,
    documentId: chunk.documentId,
    documentVersionId: chunk.documentVersionId,
    path: chunk.path,
    docType: chunk.docType,
    commitSha: chunk.commitSha,
    sectionId: chunk.sectionId,
    sectionTitle: chunk.sectionTitle,
    text: chunk.text,
    tokenCount: chunk.tokenCount,
  },
});

export const writeDocumentsToCanonicalStore = (store: CanonicalStore, documents: DocumentRecord[]): void => {
  if (documents.length === 0) return;
  store.documents.upsertSync(documents.map((document) => toDocumentInput(document, store.meta.embeddingContract.dimensions)));
};

export const writeChunksToCanonicalStore = (store: CanonicalStore, chunks: ChunkRecord[]): void => {
  if (chunks.length === 0) return;
  store.chunks.upsertSync(chunks.map((chunk) => toChunkInput(chunk)));
};

export const canonicalStoreSummary = async (
  cwd: string,
  embedding: EmbeddingContract,
  readOnly = true,
): Promise<CanonicalStoreBootstrapSummary> => {
  const store = await bootstrapCanonicalStore(cwd, embedding, readOnly);
  try {
    return {
      backend: "zvec",
      status: store.status,
      collections: [store.meta.collections.documents, store.meta.collections.chunks],
      searchReady: false,
      migrationRequired: await hasLegacyJsonStore(cwd),
      schemaVersion: store.meta.schemaVersion,
    };
  } finally {
    closeCanonicalStore(store);
  }
};
