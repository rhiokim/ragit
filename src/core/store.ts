export {
  bootstrapCanonicalStore,
  bootstrapCanonicalStoreAtPath,
  canonicalStoreSummary,
  closeCanonicalStore,
  ensureZvecRuntime,
  formatZvecPlatformSupport,
  getZvecPlatformSupport,
  hasLegacyJsonStore,
  isZvecPlatformSupported,
  openCanonicalStoreWithContract,
  readCanonicalStoreMeta,
  writeChunksToCanonicalStore,
  writeDocumentsToCanonicalStore,
  zvecPlatformUnsupportedMessage,
} from "./zvec.js";
export type { CanonicalStore, CanonicalStoreBootstrapSummary, CanonicalStoreMeta, EmbeddingContract, ZvecPlatformSupport } from "./zvec.js";
