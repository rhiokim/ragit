import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { EmbeddingProvider, KNOWN_DOC_TYPES, RagitConfig } from "./types.js";

export const RAGIT_DIR = ".ragit";
export const CONFIG_PATH = path.join(RAGIT_DIR, "config.toml");

export const defaultConfig = (): RagitConfig => ({
  project: {
    name: "ragit-project",
    default_branch: "main",
    mode: "auto",
  },
  init: {
    strategy: "balanced",
    merge_existing: true,
  },
  docs: {
    entrypoint: "RAGIT.md",
    workspace_map: "docs/workspace-map.md",
    ingestion_policy: "docs/ragit/ingestion-policy.md",
    known_gaps: "docs/known-gaps.md",
    adr_dir: "docs/adr",
  },
  docs_authority: {
    auto_refresh_on_hook: false,
    validate_on_ingest: true,
    canonical_root: "docs",
  },
  storage: {
    backend: "zvec",
    manifest_dir: ".ragit/manifest",
    vector_dir: ".ragit/store",
  },
  embedding: {
    provider: "local-placeholder",
    model: "placeholder-v1",
    timeout_ms: 30_000,
    cache_enabled: true,
    cache_dir: ".ragit/cache/embeddings",
    dimensions: 64,
    version: "v1",
  },
  ingest: {
    supported_types: [...KNOWN_DOC_TYPES],
    type_detection: "frontmatter-first",
    doc_globs: ["**/*.md", "**/*.mdx"],
    include: ["README.md", "docs/**"],
    exclude: ["**/.git/**", "**/.ragit/**", "**/node_modules/**", "**/dist/**", "**/coverage/**", "**/.next/**"],
  },
  hooks: {
    post_commit: true,
    post_merge: true,
  },
  retrieval: {
    alpha: 0.7,
    top_k: 5,
    keyword_enabled: true,
  },
  memory: {
    corpus_dir: "docs/memory",
    session_dir: ".ragit/memory/sessions",
    working_dir: ".ragit/memory/working",
    auto_ingest_promotions: true,
    recall_top_k: 8,
  },
  security: {
    secret_masking: true,
    remote_embedding_policy: "allow-sanitized",
    quarantine_on_redaction: true,
    admission_mode: "enforce",
  },
  output: {
    format: "both",
    language: "ko",
  },
});

const normalizeEmbeddingProvider = (value: unknown): EmbeddingProvider => {
  if (value === undefined || value === null || value === "") return defaultConfig().embedding.provider;
  if (value === "local-placeholder" || value === "openai" || value === "ollama") return value;
  throw new Error(`지원하지 않는 embedding provider입니다: ${String(value)}`);
};

const normalizeEmbeddingModel = (provider: EmbeddingProvider, value: unknown): string => {
  if (typeof value === "string" && value.trim()) {
    const normalized = value.trim();
    if (provider !== "local-placeholder" && normalized === "placeholder-v1") {
      return provider === "openai" ? "text-embedding-3-small" : "nomic-embed-text";
    }
    return normalized;
  }
  if (provider === "openai") return "text-embedding-3-small";
  if (provider === "ollama") return "nomic-embed-text";
  return "placeholder-v1";
};

const normalizeEmbeddingBaseUrl = (value: unknown): string | undefined => {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.trim();
};

const normalizeEmbeddingTimeout = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  return 30_000;
};

const normalizeEmbeddingCacheEnabled = (value: unknown): boolean => {
  if (typeof value === "boolean") return value;
  return true;
};

const normalizeEmbeddingCacheDir = (value: unknown): string => {
  if (typeof value === "string" && value.trim()) return value.trim();
  return ".ragit/cache/embeddings";
};

const normalizeEmbeddingDimensions = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  return undefined;
};

const normalizeEmbeddingVersion = (value: unknown): string | undefined => {
  if (typeof value === "string" && value.trim()) return value.trim();
  return undefined;
};

const normalizeRemoteEmbeddingPolicy = (value: unknown): RagitConfig["security"]["remote_embedding_policy"] => {
  if (value === "allow-sanitized" || value === "local-only") return value;
  return "allow-sanitized";
};

const normalizeQuarantineOnRedaction = (value: unknown): boolean => {
  if (typeof value === "boolean") return value;
  return true;
};

const normalizeAdmissionMode = (value: unknown): RagitConfig["security"]["admission_mode"] => {
  if (value === "report-only" || value === "enforce") return value;
  return "enforce";
};

const normalizeOutputFormat = (value: unknown): RagitConfig["output"]["format"] => {
  if (value === "json" || value === "both" || value === "text") return value;
  if (value === "markdown" || value === "table") return "text";
  return defaultConfig().output.format;
};

const parseValue = (raw: string): string | number | boolean | string[] => {
  const value = raw.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith("[") && value.endsWith("]")) {
    const body = value.slice(1, -1).trim();
    if (body.length === 0) return [];
    return body
      .split(",")
      .map((item) => item.trim())
      .map((item) => item.replace(/^"(.*)"$/, "$1"));
  }
  return value.replace(/^"(.*)"$/, "$1");
};

export const parseToml = (source: string): RagitConfig => {
  const result = defaultConfig() as unknown as Record<string, Record<string, unknown>>;
  const assignedKeys = new Set<string>();
  let currentSection: string | null = null;
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const sectionMatch = trimmed.match(/^\[([a-zA-Z0-9_.-]+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      if (!result[currentSection]) result[currentSection] = {};
      continue;
    }
    if (!currentSection) continue;
    const assignmentMatch = trimmed.match(/^([a-zA-Z0-9_.-]+)\s*=\s*(.+)$/);
    if (!assignmentMatch) continue;
    const [, key, rawValue] = assignmentMatch;
    result[currentSection][key] = parseValue(rawValue);
    assignedKeys.add(`${currentSection}.${key}`);
  }
  const output = result.output ?? {};
  output.format = normalizeOutputFormat(output.format);
  const embedding = result.embedding ?? {};
  const provider = normalizeEmbeddingProvider(embedding.provider);
  embedding.provider = provider;
  embedding.model = normalizeEmbeddingModel(provider, embedding.model);
  embedding.base_url = normalizeEmbeddingBaseUrl(embedding.base_url);
  embedding.timeout_ms = normalizeEmbeddingTimeout(embedding.timeout_ms);
  embedding.cache_enabled = normalizeEmbeddingCacheEnabled(embedding.cache_enabled);
  embedding.cache_dir = normalizeEmbeddingCacheDir(embedding.cache_dir);
  embedding.dimensions = normalizeEmbeddingDimensions(embedding.dimensions);
  embedding.version = normalizeEmbeddingVersion(embedding.version);
  const security = result.security ?? {};
  security.secret_masking = typeof security.secret_masking === "boolean" ? security.secret_masking : true;
  security.remote_embedding_policy = normalizeRemoteEmbeddingPolicy(security.remote_embedding_policy);
  security.quarantine_on_redaction = normalizeQuarantineOnRedaction(security.quarantine_on_redaction);
  security.admission_mode = assignedKeys.has("security.admission_mode")
    ? normalizeAdmissionMode(security.admission_mode)
    : "report-only";
  return result as unknown as RagitConfig;
};

const toTomlValue = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map((v) => `"${String(v)}"`).join(", ")}]`;
  if (typeof value === "string") return `"${value}"`;
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  return `"${String(value)}"`;
};

export const stringifyToml = (config: RagitConfig): string => {
  const sections = Object.entries(config).map(([sectionName, sectionValues]) => {
    const lines = Object.entries(sectionValues)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key} = ${toTomlValue(value)}`);
    return [`[${sectionName}]`, ...lines].join("\n");
  });
  return `${sections.join("\n\n")}\n`;
};

export const loadConfig = async (cwd: string): Promise<RagitConfig> => {
  const configPath = path.join(cwd, CONFIG_PATH);
  const content = await readFile(configPath, "utf8");
  return parseToml(content);
};

export const writeConfig = async (cwd: string, config: RagitConfig): Promise<void> => {
  const configPath = path.join(cwd, CONFIG_PATH);
  await writeFile(configPath, stringifyToml(config), "utf8");
};

export const setConfigValue = (config: RagitConfig, dottedKey: string, value: string): RagitConfig => {
  const segments = dottedKey.split(".");
  if (segments.length !== 2) {
    throw new Error(`지원하지 않는 key 형식입니다: ${dottedKey}`);
  }
  const [section, key] = segments;
  const container = (config as unknown as Record<string, Record<string, unknown>>)[section];
  const optionalEmbeddingKeys = new Set(["model", "base_url", "timeout_ms", "cache_enabled", "cache_dir", "dimensions", "version"]);
  if (!container || (!(key in container) && !(section === "embedding" && optionalEmbeddingKeys.has(key)))) {
    throw new Error(`알 수 없는 설정 키입니다: ${dottedKey}`);
  }
  const currentValue = container[key];
  if (Array.isArray(currentValue)) {
    container[key] = value.split(",").map((entry) => entry.trim());
  } else if (typeof currentValue === "boolean") {
    if (value !== "true" && value !== "false") {
      throw new Error(`boolean 값은 true/false만 허용됩니다: ${dottedKey}`);
    }
    container[key] = value === "true";
  } else if (typeof currentValue === "number") {
    const parsed = Number(value);
    if (Number.isNaN(parsed)) {
      throw new Error(`number 값으로 변환할 수 없습니다: ${dottedKey}`);
    }
    container[key] = parsed;
  } else {
    if (section === "output" && key === "format") {
      container[key] = normalizeOutputFormat(value);
    } else if (section === "embedding" && key === "provider") {
      container[key] = normalizeEmbeddingProvider(value);
    } else if (section === "embedding" && key === "timeout_ms") {
      container[key] = normalizeEmbeddingTimeout(Number(value));
    } else if (section === "embedding" && key === "cache_enabled") {
      if (value !== "true" && value !== "false") {
        throw new Error(`boolean 값은 true/false만 허용됩니다: ${dottedKey}`);
      }
      container[key] = normalizeEmbeddingCacheEnabled(value === "true");
    } else if (section === "embedding" && key === "cache_dir") {
      container[key] = normalizeEmbeddingCacheDir(value);
    } else if (section === "embedding" && key === "dimensions") {
      const parsed = normalizeEmbeddingDimensions(Number(value));
      if (parsed === undefined) {
        throw new Error(`number 값으로 변환할 수 없습니다: ${dottedKey}`);
      }
      container[key] = parsed;
    } else if (section === "embedding" && key === "version") {
      container[key] = normalizeEmbeddingVersion(value);
    } else if (section === "security" && key === "remote_embedding_policy") {
      container[key] = normalizeRemoteEmbeddingPolicy(value);
    } else if (section === "security" && key === "quarantine_on_redaction") {
      if (value !== "true" && value !== "false") {
        throw new Error(`boolean 값은 true/false만 허용됩니다: ${dottedKey}`);
      }
      container[key] = normalizeQuarantineOnRedaction(value === "true");
    } else if (section === "security" && key === "admission_mode") {
      container[key] = normalizeAdmissionMode(value);
    } else {
      container[key] = value;
    }
  }
  return config;
};
