import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { KNOWN_DOC_TYPES, RagitConfig } from "./types.js";

export const RAGIT_DIR = ".ragit";
export const CONFIG_PATH = path.join(RAGIT_DIR, "config.toml");

export const defaultConfig = (): RagitConfig => ({
  project: {
    name: "ragit-project",
    default_branch: "main",
  },
  storage: {
    backend: "zvec",
    manifest_dir: ".ragit/manifest",
    vector_dir: ".ragit/store",
  },
  embedding: {
    provider: "local-placeholder",
    dimensions: 64,
    version: "v1",
  },
  ingest: {
    supported_types: [...KNOWN_DOC_TYPES],
    type_detection: "frontmatter-first",
    doc_globs: ["**/*.md", "**/*.mdx"],
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
  },
  output: {
    format: "both",
    language: "ko",
  },
});

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
  }
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
    const lines = Object.entries(sectionValues).map(([key, value]) => `${key} = ${toTomlValue(value)}`);
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
  if (!container || !(key in container)) {
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
    container[key] = value;
  }
  return config;
};
