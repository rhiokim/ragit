import { createHash } from "node:crypto";
import { EmbeddingConfiguredState, EmbeddingProfile, EmbeddingProvider, RagitConfig } from "./types.js";

type ModelSpec = {
  dimensions: number;
  version: string;
};

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

export type EmbeddingProviderErrorCode =
  | "CREDENTIAL_MISSING"
  | "PROVIDER_UNSUPPORTED"
  | "PROVIDER_UNREACHABLE"
  | "TIMEOUT"
  | "DIMENSION_MISMATCH";

export class EmbeddingProviderError extends Error {
  code: EmbeddingProviderErrorCode;
  provider: EmbeddingProvider;
  model: string;
  retryable: boolean;

  constructor(params: {
    code: EmbeddingProviderErrorCode;
    provider: EmbeddingProvider;
    model: string;
    message: string;
    retryable: boolean;
  }) {
    super(params.message);
    this.name = "EmbeddingProviderError";
    this.code = params.code;
    this.provider = params.provider;
    this.model = params.model;
    this.retryable = params.retryable;
  }
}

const normalizedTokens = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);

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

const normalizeEmbeddingVectors = (vectors: unknown, profile: EmbeddingProfile): number[][] => {
  if (!Array.isArray(vectors)) {
    throw new EmbeddingProviderError({
      code: "PROVIDER_UNREACHABLE",
      provider: profile.provider,
      model: profile.model,
      message: "embedding 응답 형식이 올바르지 않습니다.",
      retryable: true,
    });
  }
  return vectors.map((vector) => {
    if (!Array.isArray(vector)) {
      throw new EmbeddingProviderError({
        code: "PROVIDER_UNREACHABLE",
        provider: profile.provider,
        model: profile.model,
        message: "embedding 응답 벡터 형식이 올바르지 않습니다.",
        retryable: true,
      });
    }
    const normalized = vector.map((value) => Number(value));
    if (normalized.some((value) => Number.isNaN(value))) {
      throw new EmbeddingProviderError({
        code: "PROVIDER_UNREACHABLE",
        provider: profile.provider,
        model: profile.model,
        message: "embedding 응답에 숫자가 아닌 값이 포함되어 있습니다.",
        retryable: true,
      });
    }
    if (normalized.length !== profile.dimensions) {
      throw new EmbeddingProviderError({
        code: "DIMENSION_MISMATCH",
        provider: profile.provider,
        model: profile.model,
        message: `embedding 차원이 기대값과 다릅니다: expected=${profile.dimensions}, actual=${normalized.length}`,
        retryable: false,
      });
    }
    return normalized;
  });
};

const requestJson = async (input: RequestInfo | URL, init: RequestInit, profile: EmbeddingProfile): Promise<unknown> => {
  try {
    const response = await withTimeout(fetch(input, init), profile);
    if (!response.ok) {
      throw new EmbeddingProviderError({
        code: "PROVIDER_UNREACHABLE",
        provider: profile.provider,
        model: profile.model,
        message: `${profile.provider} embedding 요청이 실패했습니다: ${response.status} ${response.statusText}`,
        retryable: response.status >= 500 || response.status === 429,
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
  const payload = {
    model: profile.model,
    input: texts,
  };
  const body = await requestJson(
    `${profile.baseUrl}/v1/embeddings`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    },
    profile,
  );
  const data = (body as { data?: Array<{ embedding?: unknown }> }).data;
  return normalizeEmbeddingVectors(data?.map((entry) => entry.embedding) ?? [], profile);
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
  const embeddings = (body as { embeddings?: unknown }).embeddings;
  return normalizeEmbeddingVectors(embeddings, profile);
};

export const embedTexts = async (texts: string[], profile: EmbeddingProfile): Promise<number[][]> => {
  if (texts.length === 0) return [];
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

export const embedText = async (text: string, profile: EmbeddingProfile): Promise<number[]> => {
  const [vector] = await embedTexts([text], profile);
  return vector ?? zeroVector(profile.dimensions);
};
