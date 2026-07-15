import { access, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import * as zvecBinding from "@zvec/zvec";
import type { ZVecCollection, ZVecFieldSchema, ZVecVectorSchema } from "@zvec/zvec";
import { zeroVector } from "./embedding.js";
import { resolveRagitPaths } from "./project.js";
import { isZvecPlatformSupported, zvecPlatformUnsupportedMessage } from "./runtime.js";
import { ChunkRecord, DocumentRecord, RagitConfig } from "./types.js";

export {
  formatZvecPlatformSupport,
  getZvecPlatformSupport,
  isZvecPlatformSupported,
  zvecPlatformUnsupportedMessage,
} from "./runtime.js";
export type { ZvecPlatformSupport } from "./runtime.js";

const runtimeBinding = ((zvecBinding as typeof zvecBinding & { default?: typeof zvecBinding }).default ??
  zvecBinding) as typeof zvecBinding;

const {
  ZVecCollectionSchema,
  ZVecCreateAndOpen,
  ZVecDataType,
  ZVecIndexType,
  ZVecInitialize,
  ZVecLogLevel,
  ZVecMetricType,
  ZVecOpen,
} = runtimeBinding;

type ZVecCollectionSchemaInstance = InstanceType<typeof zvecBinding.ZVecCollectionSchema>;

const STORE_LAYOUT_VERSION = 1;
const STORE_SCHEMA_VERSION = 2;

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

interface CanonicalStorePaths {
  storeDir: string;
  storeMetaPath: string;
  documentsCollectionDir: string;
  chunksCollectionDir: string;
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

const resolveCanonicalStorePaths = (cwd: string, customStoreDir?: string): CanonicalStorePaths => {
  if (!customStoreDir) {
    const paths = resolveRagitPaths(cwd);
    return {
      storeDir: paths.storeDir,
      storeMetaPath: paths.storeMetaPath,
      documentsCollectionDir: paths.documentsCollectionDir,
      chunksCollectionDir: paths.chunksCollectionDir,
    };
  }
  const storeDir = path.resolve(customStoreDir);
  return {
    storeDir,
    storeMetaPath: path.join(storeDir, "meta.json"),
    documentsCollectionDir: path.join(storeDir, "documents"),
    chunksCollectionDir: path.join(storeDir, "chunks"),
  };
};

export const ensureZvecRuntime = (): void => {
  if (!isZvecPlatformSupported()) {
    throw new Error(zvecPlatformUnsupportedMessage());
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
      { name: "originType", dataType: ZVecDataType.STRING, indexParams: { indexType: ZVecIndexType.INVERT } },
      { name: "artifactId", dataType: ZVecDataType.STRING, indexParams: { indexType: ZVecIndexType.INVERT } },
      { name: "artifactKind", dataType: ZVecDataType.STRING, indexParams: { indexType: ZVecIndexType.INVERT } },
      { name: "tier", dataType: ZVecDataType.STRING, indexParams: { indexType: ZVecIndexType.INVERT } },
      { name: "status", dataType: ZVecDataType.STRING, indexParams: { indexType: ZVecIndexType.INVERT } },
      { name: "authority", dataType: ZVecDataType.STRING, indexParams: { indexType: ZVecIndexType.INVERT } },
      { name: "confidence", dataType: ZVecDataType.DOUBLE, indexParams: { indexType: ZVecIndexType.INVERT } },
      { name: "goalId", dataType: ZVecDataType.STRING, indexParams: { indexType: ZVecIndexType.INVERT } },
      { name: "episodeId", dataType: ZVecDataType.STRING, indexParams: { indexType: ZVecIndexType.INVERT } },
      { name: "sourceSessionId", dataType: ZVecDataType.STRING, indexParams: { indexType: ZVecIndexType.INVERT } },
      { name: "bindingStatus", dataType: ZVecDataType.STRING, indexParams: { indexType: ZVecIndexType.INVERT } },
      { name: "searchPolicy", dataType: ZVecDataType.STRING, indexParams: { indexType: ZVecIndexType.INVERT } },
    ],
  });

const buildLegacyChunkSchema = (dimensions: number): ZVecCollectionSchemaInstance =>
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

const normalizeExpectedScalarSchema = (schema: ZVecCollectionSchemaInstance): string =>
  schema
    .fields()
    .map((field: ZVecFieldSchema) => `${field.name}:${field.dataType}:${field.indexParams?.indexType ?? "none"}`)
    .sort()
    .join("|");

const normalizeExpectedVectorSchema = (schema: ZVecCollectionSchemaInstance): string =>
  schema
    .vectors()
    .map(
      (vector: ZVecVectorSchema) =>
        `${vector.name}:${vector.dataType}:${vector.dimension ?? 0}:${vector.indexParams?.indexType ?? "none"}:${"metricType" in (vector.indexParams ?? {}) ? vector.indexParams?.metricType ?? "none" : "none"}`,
    )
    .sort()
    .join("|");

const assertCollectionSchema = (
  collection: ZVecCollection,
  expected: ZVecCollectionSchemaInstance | ZVecCollectionSchemaInstance[],
  label: string,
): void => {
  const actualScalars = normalizeScalarSchema(collection);
  const actualVectors = normalizeVectorSchema(collection);
  const candidates = Array.isArray(expected) ? expected : [expected];
  const matched = candidates.some(
    (schema) =>
      normalizeExpectedScalarSchema(schema) === actualScalars && normalizeExpectedVectorSchema(schema) === actualVectors,
  );
  if (!matched) {
    throw new Error(`${label} collection schema가 현재 ragit 기대값과 다릅니다.`);
  }
};

const readStoreMeta = async (target: string): Promise<CanonicalStoreMeta | null> => {
  try {
    const content = await readFile(target, "utf8");
    return JSON.parse(content) as CanonicalStoreMeta;
  } catch {
    return null;
  }
};

const writeStoreMeta = async (target: string, meta: CanonicalStoreMeta): Promise<void> => {
  await writeFile(target, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
};

export const readCanonicalStoreMeta = async (cwd: string, customStoreDir?: string): Promise<CanonicalStoreMeta | null> =>
  readStoreMeta(resolveCanonicalStorePaths(cwd, customStoreDir).storeMetaPath);

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
  if (meta.schemaVersion !== 1 && meta.schemaVersion !== STORE_SCHEMA_VERSION) {
    throw new Error(`store schema version mismatch: ${meta.schemaVersion}`);
  }
  if (
    meta.embeddingContract.provider !== embedding.provider ||
    meta.embeddingContract.dimensions !== embedding.dimensions ||
    meta.embeddingContract.version !== embedding.version
  ) {
    throw new Error("embedding contract가 현재 설정과 다릅니다. `ragit migrate embeddings`를 실행해 주세요.");
  }
};

export const hasLegacyJsonStore = async (cwd: string): Promise<boolean> => fileExists(path.join(resolveRagitPaths(cwd).storeDir, "index.json"));

const openCanonicalStoreAtPath = async (
  cwd: string,
  embedding: EmbeddingContract,
  readOnly: boolean,
  customStoreDir?: string,
): Promise<CanonicalStore> => {
  const paths = resolveCanonicalStorePaths(cwd, customStoreDir);
  ensureZvecRuntime();
  const meta = await readStoreMeta(paths.storeMetaPath);
  const documentsExists = await fileExists(paths.documentsCollectionDir);
  const chunksExists = await fileExists(paths.chunksCollectionDir);
  const hasCollections = documentsExists || chunksExists;
  const documentsSchema = buildDocumentSchema(embedding.dimensions);
  const chunksSchema = buildChunkSchema(embedding.dimensions);
  const legacyChunkSchema = buildLegacyChunkSchema(embedding.dimensions);

  if (!hasCollections && !meta) {
    if (readOnly) {
      throw new Error("zvec store가 아직 초기화되지 않았습니다. 먼저 ragit init을 실행해 주세요.");
    }
    const documents = ZVecCreateAndOpen(paths.documentsCollectionDir, documentsSchema, { readOnly: false, enableMMAP: true });
    const chunks = ZVecCreateAndOpen(paths.chunksCollectionDir, chunksSchema, { readOnly: false, enableMMAP: true });
    const createdMeta = buildMeta(embedding);
    await writeStoreMeta(paths.storeMetaPath, createdMeta);
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
  assertCollectionSchema(chunks, [chunksSchema, legacyChunkSchema], "chunks");

  return {
    documents,
    chunks,
    meta,
    status: "loaded",
  };
};

export const bootstrapCanonicalStore = async (
  cwd: string,
  embedding: EmbeddingContract,
  readOnly = false,
): Promise<CanonicalStore> => {
  return openCanonicalStoreAtPath(cwd, embedding, readOnly);
};

export const openCanonicalStoreWithContract = async (
  cwd: string,
  embedding: EmbeddingContract,
  readOnly = false,
): Promise<CanonicalStore> => openCanonicalStoreAtPath(cwd, embedding, readOnly);

export const bootstrapCanonicalStoreAtPath = async (
  cwd: string,
  embedding: EmbeddingContract,
  readOnly = false,
  customStoreDir?: string,
): Promise<CanonicalStore> => openCanonicalStoreAtPath(cwd, embedding, readOnly, customStoreDir);

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

const toChunkInput = (collection: ZVecCollection, chunk: ChunkRecord) => {
  const availableFields = new Set(collection.schema.fields().map((field) => field.name));
  const fields: Record<string, string | number> = {};
  const addField = (name: string, value: string | number): void => {
    if (!availableFields.has(name)) return;
    fields[name] = value;
  };
  addField("id", chunk.id);
  addField("documentId", chunk.documentId);
  addField("documentVersionId", chunk.documentVersionId);
  addField("path", chunk.path);
  addField("docType", chunk.docType);
  addField("commitSha", chunk.commitSha);
  addField("sectionId", chunk.sectionId);
  addField("sectionTitle", chunk.sectionTitle);
  addField("text", chunk.text);
  addField("tokenCount", chunk.tokenCount);
  addField("originType", chunk.originType ?? "");
  addField("artifactId", chunk.artifactId ?? "");
  addField("artifactKind", chunk.artifactKind ?? "");
  addField("tier", chunk.tier ?? "");
  addField("status", chunk.status ?? "");
  addField("authority", chunk.authority ?? "");
  addField("confidence", chunk.confidence ?? -1);
  addField("goalId", chunk.goalId ?? "");
  addField("episodeId", chunk.episodeId ?? "");
  addField("sourceSessionId", chunk.sourceSessionId ?? "");
  addField("bindingStatus", chunk.bindingStatus ?? "");
  addField("searchPolicy", chunk.searchPolicy ?? "");
  return {
    id: chunk.id,
    vectors: {
      embedding: chunk.embedding,
    },
    fields,
  };
};

export const writeDocumentsToCanonicalStore = (store: CanonicalStore, documents: DocumentRecord[]): void => {
  if (documents.length === 0) return;
  store.documents.upsertSync(documents.map((document) => toDocumentInput(document, store.meta.embeddingContract.dimensions)));
};

export const writeChunksToCanonicalStore = (store: CanonicalStore, chunks: ChunkRecord[]): void => {
  if (chunks.length === 0) return;
  store.chunks.upsertSync(chunks.map((chunk) => toChunkInput(store.chunks, chunk)));
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
