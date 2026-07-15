import { constants } from "node:fs";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { EmbeddingConfiguredState, EmbeddingProfile, EmbeddingProvider, RagitConfig } from "./types.js";

type ModelSpec = {
  dimensions: number;
  version: string;
};

type CacheNamespaceManifest = {
  schemaVersion: 1;
  namespaceId: string;
  provider: EmbeddingProvider;
  model: string;
  version: string;
  dimensions: number;
  baseUrl: string | null;
  entryCount: number;
  createdAt: string;
  updatedAt: string;
};

type CacheEntryRecord = {
  schemaVersion: 1;
  cacheKey: string;
  provider: EmbeddingProvider;
  model: string;
  version: string;
  dimensions: number;
  baseUrl: string | null;
  textHash: string;
  embedding: number[];
  createdAt: string;
  updatedAt: string;
  lastHitAt: string;
  hitCount: number;
};

export type EmbeddingCacheMode = "readwrite" | "readonly" | "disabled";

export interface EmbeddingBatchPolicy {
  maxItems: number;
  maxBytes: number;
}

export interface EmbeddingRetryPolicy {
  retryAttempts: number;
  scheduleMs: number[];
}

export interface EmbeddingExecutionPolicy {
  batch: EmbeddingBatchPolicy;
  retry: EmbeddingRetryPolicy;
}

export interface EmbeddingCacheSummary {
  enabled: boolean;
  dir: string;
  namespaceId: string | null;
  entryCount: number;
  batchPolicy: EmbeddingBatchPolicy;
  retryPolicy: EmbeddingRetryPolicy;
  writable: boolean;
  namespaceReadable: boolean;
}

export interface EmbeddingExecutionOptions {
  cwd?: string;
  cacheMode?: EmbeddingCacheMode;
}

type EmbeddingCacheContext = {
  enabled: true;
  mode: Exclude<EmbeddingCacheMode, "disabled">;
  dir: string;
  repoRelativeDir: string;
  namespaceId: string;
  namespacePath: string;
  entriesDir: string;
  profile: EmbeddingProfile;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

const CACHE_SCHEMA_VERSION = 1;

const OPENAI_MODEL_SPECS: Record<string, ModelSpec> = {
  "text-embedding-3-small": {
    dimensions: 1536,
    version: "openai-text-embedding-3-small-1536",
  },
  "text-embedding-3-large": {
    dimensions: 3072,
    version: "openai-text-embedding-3-large-3072",
  },
};

const OLLAMA_MODEL_SPECS: Record<string, ModelSpec> = {
  "nomic-embed-text": {
    dimensions: 768,
    version: "ollama-nomic-embed-text-768",
  },
  "mxbai-embed-large": {
    dimensions: 1024,
    version: "ollama-mxbai-embed-large-1024",
  },
};

const inflightEmbeddings = new Map<string, Promise<number[]>>();

export type EmbeddingProviderErrorCode =
  | "CREDENTIAL_MISSING"
  | "PROVIDER_UNSUPPORTED"
  | "PROVIDER_UNREACHABLE"
  | "TIMEOUT"
  | "DIMENSION_MISMATCH"
  | "RESPONSE_INVALID";

export class EmbeddingProviderError extends Error {
  code: EmbeddingProviderErrorCode;
  provider: EmbeddingProvider;
  model: string;
  retryable: boolean;
  retryAfterMs?: number;

  constructor(params: {
    code: EmbeddingProviderErrorCode;
    provider: EmbeddingProvider;
    model: string;
    message: string;
    retryable: boolean;
    retryAfterMs?: number;
  }) {
    super(params.message);
    this.name = "EmbeddingProviderError";
    this.code = params.code;
    this.provider = params.provider;
    this.model = params.model;
    this.retryable = params.retryable;
    this.retryAfterMs = params.retryAfterMs;
  }
}

const normalizedTokens = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);

const sha1 = (...parts: string[]): string => createHash("sha1").update(parts.join(":")).digest("hex");

const stableJson = (value: unknown): string => JSON.stringify(value, null, 2);

const fileExists = async (target: string): Promise<boolean> => {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

const createDeferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const clampNonNegative = (value: number): number => (value > 0 ? value : 0);

export const normalizeEmbeddingCacheText = (text: string): string => text.replace(/\r\n/g, "\n");

const textHash = (text: string): string => sha1(normalizeEmbeddingCacheText(text));

const defaultModelForProvider = (provider: EmbeddingProvider): string => {
  if (provider === "openai") return "text-embedding-3-small";
  if (provider === "ollama") return "nomic-embed-text";
  return "placeholder-v1";
};

const defaultBaseUrlForProvider = (provider: EmbeddingProvider): string | null => {
  if (provider === "openai") return "https://api.openai.com";
  if (provider === "ollama") return "http://127.0.0.1:11434";
  return null;
};

const fallbackBaseUrlFromEnv = (provider: EmbeddingProvider): string | undefined => {
  if (provider === "openai") return process.env.OPENAI_BASE_URL;
  if (provider === "ollama") return process.env.OLLAMA_BASE_URL;
  return undefined;
};

const configuredBaseUrl = (provider: EmbeddingProvider, configValue?: string): string | null => {
  if (configValue?.trim()) return configValue.trim().replace(/\/+$/, "");
  const fallback = fallbackBaseUrlFromEnv(provider)?.trim();
  if (fallback) return fallback.replace(/\/+$/, "");
  return defaultBaseUrlForProvider(provider);
};

const modelSpecForProvider = (provider: EmbeddingProvider, model: string): ModelSpec => {
  if (provider === "local-placeholder") {
    return {
      dimensions: 64,
      version: "v1",
    };
  }
  if (provider === "openai") {
    const spec = OPENAI_MODEL_SPECS[model];
    if (spec) return spec;
    throw new EmbeddingProviderError({
      code: "PROVIDER_UNSUPPORTED",
      provider,
      model,
      message: `지원하지 않는 OpenAI embedding model입니다: ${model}`,
      retryable: false,
    });
  }
  const spec = OLLAMA_MODEL_SPECS[model];
  if (spec) return spec;
  throw new EmbeddingProviderError({
    code: "PROVIDER_UNSUPPORTED",
    provider,
    model,
    message: `지원하지 않는 Ollama embedding model입니다: ${model}`,
    retryable: false,
  });
};

export const zeroVector = (dimensions: number): number[] => new Array<number>(dimensions).fill(0);

export const embedWithLocalPlaceholder = (text: string, dimensions: number): number[] => {
  const vector = zeroVector(dimensions);
  const tokens = normalizedTokens(text);
  if (tokens.length === 0) return vector;
  for (const token of tokens) {
    const hash = createHash("sha1").update(token).digest();
    for (let index = 0; index < dimensions; index += 1) {
      const source = hash[index % hash.length];
      vector[index] += (source / 255) * 2 - 1;
    }
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
};

export const cosineSimilarity = (a: number[], b: number[]): number => {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    aNorm += a[index] ** 2;
    bNorm += b[index] ** 2;
  }
  if (aNorm === 0 || bNorm === 0) return 0;
  return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
};

export const zvecCosineDistanceToSimilarity = (distance: number): number => 1 - distance;

export const resolveEmbeddingConfiguredState = (config: RagitConfig): EmbeddingConfiguredState => {
  const provider = config.embedding.provider;
  const configuredModel = config.embedding.model?.trim();
  return {
    provider,
    model:
      configuredModel && !(provider !== "local-placeholder" && configuredModel === "placeholder-v1")
        ? configuredModel
        : defaultModelForProvider(provider),
    baseUrl: configuredBaseUrl(provider, config.embedding.base_url),
    timeoutMs: config.embedding.timeout_ms && config.embedding.timeout_ms > 0 ? config.embedding.timeout_ms : 30_000,
    cacheEnabled: config.embedding.cache_enabled !== false,
    cacheDir: config.embedding.cache_dir?.trim() || ".ragit/cache/embeddings",
    deprecatedDimensions: typeof config.embedding.dimensions === "number" ? config.embedding.dimensions : null,
    deprecatedVersion: typeof config.embedding.version === "string" && config.embedding.version.trim() ? config.embedding.version : null,
  };
};

export const resolveEmbeddingProfile = (config: RagitConfig): EmbeddingProfile => {
  const configured = resolveEmbeddingConfiguredState(config);
  if (configured.provider === "local-placeholder") {
    return {
      provider: configured.provider,
      model: configured.model,
      dimensions: configured.deprecatedDimensions ?? 64,
      version: configured.deprecatedVersion ?? "v1",
      baseUrl: null,
      timeoutMs: configured.timeoutMs,
      cacheEnabled: configured.cacheEnabled,
      cacheDir: configured.cacheDir,
      ignoredLegacyFields: [],
    };
  }

  const spec = modelSpecForProvider(configured.provider, configured.model);
  return {
    provider: configured.provider,
    model: configured.model,
    dimensions: spec.dimensions,
    version: spec.version,
    baseUrl: configured.baseUrl,
    timeoutMs: configured.timeoutMs,
    cacheEnabled: configured.cacheEnabled,
    cacheDir: configured.cacheDir,
    ignoredLegacyFields: [
      ...(configured.deprecatedDimensions !== null ? (["dimensions"] as const) : []),
      ...(configured.deprecatedVersion !== null ? (["version"] as const) : []),
    ],
  };
};

export const toEmbeddingContract = (
  profile: EmbeddingProfile,
): {
  provider: EmbeddingProvider;
  dimensions: number;
  version: string;
} => ({
  provider: profile.provider,
  dimensions: profile.dimensions,
  version: profile.version,
});

export const resolveEmbeddingExecutionPolicy = (profile: EmbeddingProfile): EmbeddingExecutionPolicy => {
  if (profile.provider === "local-placeholder") {
    return {
      batch: { maxItems: 256, maxBytes: 4 * 1024 * 1024 },
      retry: { retryAttempts: 0, scheduleMs: [] },
    };
  }
  if (profile.provider === "openai") {
    return {
      batch: { maxItems: 96, maxBytes: 1024 * 1024 },
      retry: { retryAttempts: 4, scheduleMs: [250, 500, 1000, 2000] },
    };
  }
  return {
    batch: { maxItems: 32, maxBytes: 256 * 1024 },
    retry: { retryAttempts: 5, scheduleMs: [150, 300, 600, 1200, 2400] },
  };
};

export const resolveEmbeddingCacheNamespaceId = (profile: EmbeddingProfile): string =>
  sha1(
    String(CACHE_SCHEMA_VERSION),
    profile.provider,
    profile.model,
    profile.version,
    String(profile.dimensions),
    profile.baseUrl ?? "none",
  ).slice(0, 16);

const createCacheKey = (profile: EmbeddingProfile, normalizedText: string): string =>
  [
    CACHE_SCHEMA_VERSION,
    profile.provider,
    profile.model,
    profile.version,
    profile.dimensions,
    profile.baseUrl ?? "none",
    textHash(normalizedText),
  ].join(":");

const batchByteSize = (text: string): number => Buffer.byteLength(normalizeEmbeddingCacheText(text), "utf8");

export const splitEmbeddingBatches = (texts: string[], policy: EmbeddingBatchPolicy): string[][] => {
  if (texts.length === 0) return [];
  const batches: string[][] = [];
  let current: string[] = [];
  let currentBytes = 0;
  for (const text of texts) {
    const normalized = normalizeEmbeddingCacheText(text);
    const bytes = batchByteSize(normalized);
    const wouldOverflowItems = current.length >= policy.maxItems;
    const wouldOverflowBytes = current.length > 0 && currentBytes + bytes > policy.maxBytes;
    if (current.length > 0 && (wouldOverflowItems || wouldOverflowBytes)) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(normalized);
    currentBytes += bytes;
    if (bytes > policy.maxBytes) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
};

const parseRetryAfterMs = (value: string | null): number | undefined => {
  if (!value) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 0) {
    return Math.round(numeric * 1000);
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return undefined;
  return clampNonNegative(parsed - Date.now());
};

const requireApiKey = (provider: EmbeddingProvider, model: string): string => {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (provider === "openai" && !apiKey) {
    throw new EmbeddingProviderError({
      code: "CREDENTIAL_MISSING",
      provider,
      model,
      message: "OPENAI_API_KEY가 필요합니다.",
      retryable: false,
    });
  }
  return apiKey ?? "";
};

const withTimeout = async <T>(promise: Promise<T>, profile: EmbeddingProfile): Promise<T> => {
  let timeoutId: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(
            new EmbeddingProviderError({
              code: "TIMEOUT",
              provider: profile.provider,
              model: profile.model,
              message: `embedding 요청이 시간 초과되었습니다: ${profile.timeoutMs}ms`,
              retryable: true,
            }),
          );
        }, profile.timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
};

const invalidEmbeddingResponse = (profile: EmbeddingProfile, message: string): EmbeddingProviderError =>
  new EmbeddingProviderError({
    code: "RESPONSE_INVALID",
    provider: profile.provider,
    model: profile.model,
    message,
    retryable: false,
  });

const normalizeEmbeddingVectors = (vectors: unknown, profile: EmbeddingProfile, expectedCount: number): number[][] => {
  if (!Array.isArray(vectors) || vectors.length !== expectedCount) {
    throw invalidEmbeddingResponse(profile, "embedding 응답 벡터 수가 요청 수와 일치하지 않습니다.");
  }
  return vectors.map((vector) => {
    if (!Array.isArray(vector)) {
      throw invalidEmbeddingResponse(profile, "embedding 응답 벡터 형식이 올바르지 않습니다.");
    }
    if (vector.length !== profile.dimensions) {
      throw new EmbeddingProviderError({
        code: "DIMENSION_MISMATCH",
        provider: profile.provider,
        model: profile.model,
        message: `embedding 차원이 기대값과 다릅니다: expected=${profile.dimensions}, actual=${vector.length}`,
        retryable: false,
      });
    }
    if (vector.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
      throw invalidEmbeddingResponse(profile, "embedding 응답에 유효하지 않은 숫자 값이 포함되어 있습니다.");
    }
    return vector;
  });
};

const requestJson = async (input: RequestInfo | URL, init: RequestInit, profile: EmbeddingProfile): Promise<unknown> => {
  try {
    const response = await withTimeout(fetch(input, init), profile);
    if (!response.ok) {
      const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
      throw new EmbeddingProviderError({
        code: "PROVIDER_UNREACHABLE",
        provider: profile.provider,
        model: profile.model,
        message: `${profile.provider} embedding 요청이 실패했습니다: ${response.status} ${response.statusText}`,
        retryable: response.status >= 500 || response.status === 429,
        retryAfterMs,
      });
    }
    return response.json();
  } catch (error) {
    if (error instanceof EmbeddingProviderError) throw error;
    throw new EmbeddingProviderError({
      code: "PROVIDER_UNREACHABLE",
      provider: profile.provider,
      model: profile.model,
      message: error instanceof Error ? error.message : String(error),
      retryable: true,
    });
  }
};

const embedWithOpenAi = async (texts: string[], profile: EmbeddingProfile): Promise<number[][]> => {
  const apiKey = requireApiKey(profile.provider, profile.model);
  const body = await requestJson(
    `${profile.baseUrl}/v1/embeddings`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: profile.model,
        input: texts,
      }),
    },
    profile,
  );
  const data = typeof body === "object" && body !== null ? (body as { data?: unknown }).data : undefined;
  if (!Array.isArray(data) || data.length !== texts.length) {
    throw invalidEmbeddingResponse(profile, "OpenAI embedding 응답 항목 수가 요청 수와 일치하지 않습니다.");
  }
  const vectors = new Array<unknown>(texts.length);
  const indexes = new Set<number>();
  for (const entry of data) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw invalidEmbeddingResponse(profile, "OpenAI embedding 응답 항목 형식이 올바르지 않습니다.");
    }
    const { index, embedding } = entry as { index?: unknown; embedding?: unknown };
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= texts.length || indexes.has(index)) {
      throw invalidEmbeddingResponse(profile, "OpenAI embedding 응답 index가 올바르지 않습니다.");
    }
    indexes.add(index);
    vectors[index] = embedding;
  }
  if (indexes.size !== texts.length || vectors.some((vector) => vector === undefined)) {
    throw invalidEmbeddingResponse(profile, "OpenAI embedding 응답 index가 요청을 모두 포함하지 않습니다.");
  }
  return normalizeEmbeddingVectors(vectors, profile, texts.length);
};

const embedWithOllama = async (texts: string[], profile: EmbeddingProfile): Promise<number[][]> => {
  const body = await requestJson(
    `${profile.baseUrl}/api/embed`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: profile.model,
        input: texts,
      }),
    },
    profile,
  );
  const embeddings = typeof body === "object" && body !== null ? (body as { embeddings?: unknown }).embeddings : undefined;
  return normalizeEmbeddingVectors(embeddings, profile, texts.length);
};

const executeProviderBatch = async (texts: string[], profile: EmbeddingProfile): Promise<number[][]> => {
  if (profile.provider === "local-placeholder") {
    return texts.map((text) => embedWithLocalPlaceholder(text, profile.dimensions));
  }
  if (profile.provider === "openai") {
    return embedWithOpenAi(texts, profile);
  }
  if (profile.provider === "ollama") {
    return embedWithOllama(texts, profile);
  }
  throw new EmbeddingProviderError({
    code: "PROVIDER_UNSUPPORTED",
    provider: profile.provider,
    model: profile.model,
    message: `지원하지 않는 embedding provider입니다: ${profile.provider}`,
    retryable: false,
  });
};

const isRetryableEmbeddingError = (error: unknown): error is EmbeddingProviderError =>
  error instanceof EmbeddingProviderError && error.retryable;

const resolveRetryDelayMs = (error: EmbeddingProviderError, policy: EmbeddingRetryPolicy, attempt: number): number => {
  const configuredDelay = policy.scheduleMs[Math.min(attempt, policy.scheduleMs.length - 1)] ?? 0;
  const base = error.retryAfterMs !== undefined ? Math.max(error.retryAfterMs, configuredDelay) : configuredDelay;
  if (base <= 0) return 0;
  const jitter = 0.85 + Math.random() * 0.3;
  return Math.round(base * jitter);
};

const executeProviderBatchWithRetry = async (
  texts: string[],
  profile: EmbeddingProfile,
  policy: EmbeddingRetryPolicy,
): Promise<number[][]> => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await executeProviderBatch(texts, profile);
    } catch (error) {
      if (!isRetryableEmbeddingError(error) || attempt >= policy.retryAttempts) {
        throw error;
      }
      const delay = resolveRetryDelayMs(error, policy, attempt);
      if (delay > 0) {
        await sleep(delay);
      }
    }
  }
};

const resolveCacheContext = async (
  cwd: string | undefined,
  profile: EmbeddingProfile,
  mode: EmbeddingCacheMode,
): Promise<EmbeddingCacheContext | null> => {
  if (!cwd || !profile.cacheEnabled || mode === "disabled") return null;
  const root = path.resolve(cwd);
  const resolvedDir = path.resolve(root, profile.cacheDir);
  if (!(resolvedDir === root || resolvedDir.startsWith(`${root}${path.sep}`))) {
    return null;
  }
  const namespaceId = resolveEmbeddingCacheNamespaceId(profile);
  const namespaceDir = path.join(resolvedDir, "v1", namespaceId);
  return {
    enabled: true,
    mode,
    dir: resolvedDir,
    repoRelativeDir: path.relative(root, resolvedDir).replaceAll(path.sep, "/") || ".",
    namespaceId,
    namespacePath: path.join(namespaceDir, "namespace.json"),
    entriesDir: path.join(namespaceDir, "entries"),
    profile,
  };
};

const loadNamespaceManifest = async (context: EmbeddingCacheContext): Promise<CacheNamespaceManifest | null> => {
  try {
    const content = await readFile(context.namespacePath, "utf8");
    const parsed = JSON.parse(content) as CacheNamespaceManifest;
    if (
      parsed.schemaVersion !== CACHE_SCHEMA_VERSION ||
      parsed.namespaceId !== context.namespaceId ||
      parsed.provider !== context.profile.provider ||
      parsed.model !== context.profile.model ||
      parsed.version !== context.profile.version ||
      parsed.dimensions !== context.profile.dimensions ||
      parsed.baseUrl !== context.profile.baseUrl
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

const countExistingEntries = async (entriesDir: string): Promise<number> => {
  try {
    const files = await readdir(entriesDir);
    return files.filter((name) => name.endsWith(".json")).length;
  } catch {
    return 0;
  }
};

const ensureNamespaceManifest = async (context: EmbeddingCacheContext): Promise<CacheNamespaceManifest> => {
  const existing = await loadNamespaceManifest(context);
  if (existing) return existing;
  await mkdir(context.entriesDir, { recursive: true });
  const now = new Date().toISOString();
  const manifest: CacheNamespaceManifest = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    namespaceId: context.namespaceId,
    provider: context.profile.provider,
    model: context.profile.model,
    version: context.profile.version,
    dimensions: context.profile.dimensions,
    baseUrl: context.profile.baseUrl,
    entryCount: await countExistingEntries(context.entriesDir),
    createdAt: now,
    updatedAt: now,
  };
  await writeFile(context.namespacePath, `${stableJson(manifest)}\n`, "utf8");
  return manifest;
};

const writeNamespaceManifest = async (context: EmbeddingCacheContext, manifest: CacheNamespaceManifest): Promise<void> => {
  await mkdir(path.dirname(context.namespacePath), { recursive: true });
  await writeFile(context.namespacePath, `${stableJson(manifest)}\n`, "utf8");
};

const entryPathForHash = (context: EmbeddingCacheContext, hash: string): string => path.join(context.entriesDir, `${hash}.json`);

const loadCacheEntry = async (context: EmbeddingCacheContext, normalizedText: string): Promise<CacheEntryRecord | null> => {
  const hash = textHash(normalizedText);
  try {
    const content = await readFile(entryPathForHash(context, hash), "utf8");
    const parsed = JSON.parse(content) as CacheEntryRecord;
    if (
      parsed.schemaVersion !== CACHE_SCHEMA_VERSION ||
      parsed.provider !== context.profile.provider ||
      parsed.model !== context.profile.model ||
      parsed.version !== context.profile.version ||
      parsed.dimensions !== context.profile.dimensions ||
      parsed.baseUrl !== context.profile.baseUrl ||
      parsed.textHash !== hash ||
      !Array.isArray(parsed.embedding) ||
      parsed.embedding.length !== context.profile.dimensions ||
      parsed.embedding.some((value) => typeof value !== "number" || !Number.isFinite(value))
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

const touchCacheEntry = async (context: EmbeddingCacheContext, entry: CacheEntryRecord): Promise<void> => {
  if (context.mode !== "readwrite") return;
  const next: CacheEntryRecord = {
    ...entry,
    lastHitAt: new Date().toISOString(),
    hitCount: entry.hitCount + 1,
    updatedAt: new Date().toISOString(),
  };
  try {
    await writeFile(entryPathForHash(context, entry.textHash), `${stableJson(next)}\n`, "utf8");
  } catch {
    // cache touch is best-effort
  }
};

const writeCacheEntry = async (context: EmbeddingCacheContext, normalizedText: string, embedding: number[]): Promise<void> => {
  if (context.mode !== "readwrite") return;
  try {
    await mkdir(context.entriesDir, { recursive: true });
    const manifest = await ensureNamespaceManifest(context);
    const hash = textHash(normalizedText);
    const target = entryPathForHash(context, hash);
    const alreadyExists = await fileExists(target);
    const now = new Date().toISOString();
    const record: CacheEntryRecord = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      cacheKey: createCacheKey(context.profile, normalizedText),
      provider: context.profile.provider,
      model: context.profile.model,
      version: context.profile.version,
      dimensions: context.profile.dimensions,
      baseUrl: context.profile.baseUrl,
      textHash: hash,
      embedding,
      createdAt: alreadyExists ? now : now,
      updatedAt: now,
      lastHitAt: now,
      hitCount: 1,
    };
    await writeFile(target, `${stableJson(record)}\n`, "utf8");
    if (!alreadyExists) {
      await writeNamespaceManifest(context, {
        ...manifest,
        entryCount: manifest.entryCount + 1,
        updatedAt: now,
      });
    }
  } catch {
    // cache writes are best-effort and must not fail the embedding request
  }
};

export const readEmbeddingCacheSummary = async (cwd: string, profile: EmbeddingProfile): Promise<EmbeddingCacheSummary> => {
  const policy = resolveEmbeddingExecutionPolicy(profile);
  const context = await resolveCacheContext(cwd, profile, profile.cacheEnabled ? "readwrite" : "disabled");
  if (!context) {
    return {
      enabled: false,
      dir: profile.cacheDir,
      namespaceId: null,
      entryCount: 0,
      batchPolicy: policy.batch,
      retryPolicy: policy.retry,
      writable: false,
      namespaceReadable: false,
    };
  }
  const manifest = await loadNamespaceManifest(context);
  let writable = false;
  try {
    if (await fileExists(context.dir)) {
      await access(context.dir, constants.W_OK);
      writable = true;
    } else {
      await access(path.dirname(context.dir), constants.W_OK);
      writable = true;
    }
  } catch {
    writable = false;
  }
  return {
    enabled: true,
    dir: context.repoRelativeDir,
    namespaceId: context.namespaceId,
    entryCount: manifest?.entryCount ?? 0,
    batchPolicy: policy.batch,
    retryPolicy: policy.retry,
    writable,
    namespaceReadable: manifest !== null,
  };
};

export const checkEmbeddingCacheHealth = async (
  cwd: string,
  profile: EmbeddingProfile,
): Promise<{
  enabled: boolean;
  writable: boolean;
  namespaceReadable: boolean;
  dir: string;
  namespaceId: string | null;
  entryCount: number;
  invalidConfig: boolean;
}> => {
  const context = await resolveCacheContext(cwd, profile, profile.cacheEnabled ? "readwrite" : "disabled");
  if (!context) {
    return {
      enabled: profile.cacheEnabled,
      writable: false,
      namespaceReadable: false,
      dir: profile.cacheDir,
      namespaceId: null,
      entryCount: 0,
      invalidConfig: profile.cacheEnabled,
    };
  }
  const summary = await readEmbeddingCacheSummary(cwd, profile);
  return {
    enabled: summary.enabled,
    writable: summary.writable,
    namespaceReadable: summary.namespaceReadable,
    dir: summary.dir,
    namespaceId: summary.namespaceId,
    entryCount: summary.entryCount,
    invalidConfig: false,
  };
};

type PendingRequest = {
  key: string;
  normalizedText: string;
  indices: number[];
  deferred: Deferred<number[]>;
  fresh: boolean;
};

export const embedTexts = async (
  texts: string[],
  profile: EmbeddingProfile,
  options: EmbeddingExecutionOptions = {},
): Promise<number[][]> => {
  if (texts.length === 0) return [];
  const cacheMode = options.cacheMode ?? (profile.cacheEnabled ? "readwrite" : "disabled");
  const context = await resolveCacheContext(options.cwd, profile, cacheMode);
  const policy = resolveEmbeddingExecutionPolicy(profile);
  const results = new Array<number[]>(texts.length);
  const pendingRequests: PendingRequest[] = [];
  const waiters = new Map<string, Promise<number[]>>();

  for (const [index, text] of texts.entries()) {
    const normalizedText = normalizeEmbeddingCacheText(text);
    const key = createCacheKey(profile, normalizedText);
    const existingPending = pendingRequests.find((request) => request.key === key);
    if (existingPending) {
      existingPending.indices.push(index);
      continue;
    }

    if (context) {
      const cached = await loadCacheEntry(context, normalizedText);
      if (cached) {
        results[index] = cached.embedding;
        void touchCacheEntry(context, cached);
        continue;
      }
    }

    const inflight = inflightEmbeddings.get(key);
    if (inflight) {
      waiters.set(key, inflight);
      pendingRequests.push({
        key,
        normalizedText,
        indices: [index],
        deferred: {
          promise: inflight,
          resolve: () => undefined,
          reject: () => undefined,
        },
        fresh: false,
      });
      continue;
    }

    const deferred = createDeferred<number[]>();
    void deferred.promise.catch(() => undefined);
    inflightEmbeddings.set(key, deferred.promise);
    waiters.set(key, deferred.promise);
    pendingRequests.push({
      key,
      normalizedText,
      indices: [index],
      deferred,
      fresh: true,
    });
  }

  const freshRequests = pendingRequests.filter((request) => request.fresh);
  try {
    const batches = splitEmbeddingBatches(
      freshRequests.map((request) => request.normalizedText),
      policy.batch,
    );
    let offset = 0;
    for (const batch of batches) {
      const batchRequests = freshRequests.slice(offset, offset + batch.length);
      offset += batch.length;
      try {
        const vectors = await executeProviderBatchWithRetry(
          batchRequests.map((request) => request.normalizedText),
          profile,
          policy.retry,
        );
        if (vectors.length !== batchRequests.length) {
          throw invalidEmbeddingResponse(profile, "embedding 내부 결과 수가 요청 수와 일치하지 않습니다.");
        }
        for (const [index, request] of batchRequests.entries()) {
          const vector = vectors[index];
          if (vector === undefined) {
            throw invalidEmbeddingResponse(profile, "embedding 내부 결과가 누락되었습니다.");
          }
          request.deferred.resolve(vector);
          if (context) {
            await writeCacheEntry(context, request.normalizedText, vector);
          }
        }
      } catch (error) {
        for (const request of batchRequests) {
          request.deferred.reject(error);
        }
      } finally {
        for (const request of batchRequests) {
          inflightEmbeddings.delete(request.key);
        }
      }
    }
  } catch (error) {
    for (const request of freshRequests) {
      request.deferred.reject(error);
      inflightEmbeddings.delete(request.key);
    }
  }

  for (const request of pendingRequests) {
    if (results[request.indices[0]!] !== undefined) continue;
    const vector = await (waiters.get(request.key) ?? request.deferred.promise);
    for (const index of request.indices) {
      results[index] = vector;
    }
  }
  return Array.from({ length: results.length }, (_, index) => {
    const vector = results[index];
    if (vector === undefined) {
      throw invalidEmbeddingResponse(profile, "embedding 내부 결과가 누락되었습니다.");
    }
    return vector;
  });
};

export const embedText = async (
  text: string,
  profile: EmbeddingProfile,
  options: EmbeddingExecutionOptions = {},
): Promise<number[]> => {
  const [vector] = await embedTexts([text], profile, options);
  if (vector === undefined) {
    throw invalidEmbeddingResponse(profile, "embedding 내부 결과가 누락되었습니다.");
  }
  return vector;
};
