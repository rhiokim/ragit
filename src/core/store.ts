export {
  bootstrapCanonicalStore,
  bootstrapCanonicalStoreAtPath,
  canonicalStoreSummary,
  closeCanonicalStore,
  ensureZvecRuntime,
  hasLegacyJsonStore,
  openCanonicalStoreWithContract,
  readCanonicalStoreMeta,
  writeChunksToCanonicalStore,
  writeDocumentsToCanonicalStore,
} from "./zvec.js";
export type { CanonicalStore, CanonicalStoreBootstrapSummary, CanonicalStoreMeta, EmbeddingContract } from "./zvec.js";
export {
  formatZvecPlatformSupport,
  getZvecPlatformSupport,
  isZvecPlatformSupported,
  zvecPlatformUnsupportedMessage,
} from "./runtime.js";
export type { ZvecPlatformSupport } from "./runtime.js";
