import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig, loadConfig } from "../src/core/config.js";
import { resolveEmbeddingProfile } from "../src/core/embedding.js";
import {
  classifyEmbeddingEgress,
  sanitizeKnowledgeText,
  sanitizeStructuredValue,
} from "../src/core/security.js";

describe("security core", () => {
  it("keeps sanitizeKnowledgeText idempotent after the first masking pass", () => {
    const source = 'api_key: "super-secret-value"';
    const first = sanitizeKnowledgeText(source, "query.output", "query");
    const second = sanitizeKnowledgeText(first.text, "query.output", "query");

    expect(first.summary.applied).toBe(true);
    expect(second.text).toBe(first.text);
    expect(second.summary.applied).toBe(false);
  });

  it("sanitizes nested structured values without leaving raw secrets behind", () => {
    const source = {
      summary: "Use token=super-secret-value for the callback",
      nested: {
        url: "https://alice:supersecret@example.com/callback?access_token=abcdef1234567890",
      },
    };

    const sanitized = sanitizeStructuredValue(source, "memory.wrap", "payload");
    const rendered = JSON.stringify(sanitized.value);

    expect(sanitized.summary.applied).toBe(true);
    expect(rendered).not.toContain("super-secret-value");
    expect(rendered).not.toContain("supersecret@example.com");
    expect(rendered).toContain("***");
  });

  it("classifies embedding egress for local placeholder, openai, and ollama hosts", () => {
    const localConfig = defaultConfig();
    expect(classifyEmbeddingEgress(resolveEmbeddingProfile(localConfig))).toBe("local");

    const openAiConfig = defaultConfig();
    openAiConfig.embedding.provider = "openai";
    delete openAiConfig.embedding.dimensions;
    delete openAiConfig.embedding.version;
    expect(classifyEmbeddingEgress(resolveEmbeddingProfile(openAiConfig))).toBe("remote");

    const ollamaLocalConfig = defaultConfig();
    ollamaLocalConfig.embedding.provider = "ollama";
    ollamaLocalConfig.embedding.base_url = "http://127.0.0.1:11434";
    delete ollamaLocalConfig.embedding.dimensions;
    delete ollamaLocalConfig.embedding.version;
    expect(classifyEmbeddingEgress(resolveEmbeddingProfile(ollamaLocalConfig))).toBe("local");

    const ollamaRemoteConfig = defaultConfig();
    ollamaRemoteConfig.embedding.provider = "ollama";
    ollamaRemoteConfig.embedding.base_url = "https://ollama.example.com";
    delete ollamaRemoteConfig.embedding.dimensions;
    delete ollamaRemoteConfig.embedding.version;
    expect(classifyEmbeddingEgress(resolveEmbeddingProfile(ollamaRemoteConfig))).toBe("remote");
  });

  it("treats missing admission_mode in legacy config as report-only", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-config-legacy-"));
    try {
      await mkdir(path.join(temp, ".ragit"), { recursive: true });
      await writeFile(
        path.join(temp, ".ragit", "config.toml"),
        `[project]
name = "legacy"
default_branch = "main"
mode = "existing"

[init]
strategy = "balanced"
merge_existing = true

[docs]
entrypoint = "README.md"
workspace_map = "docs/workspace-map.md"
ingestion_policy = "docs/ingestion-policy.md"
known_gaps = "docs/known-gaps.md"
adr_dir = "docs/adr"

[docs_authority]
auto_refresh_on_hook = false
validate_on_ingest = true
canonical_root = "docs"

[storage]
backend = "zvec"

[ingest]
include = ["docs/**/*.md", "docs/**/*.mdx", "README.md"]
exclude = [".git/**", "node_modules/**", ".ragit/**"]
supported_types = ["adr", "spec", "plan", "glossary", "pbd"]
max_file_size_kb = 256
chunk_size = 900
chunk_overlap = 120
auto_bind_session_artifacts = true
doc_globs = ["docs/**/*.md", "docs/**/*.mdx", "README.md"]

[memory]
working_dir = ".ragit/memory/working"
longterm_dir = "docs/memory"
auto_ingest_promotions = true

[hooks]
enabled = false
managed = true
post_commit = false
pre_push = false

[output]
format = "both"

[embedding]
provider = "local-placeholder"
model = "ragit-local-placeholder-v1"

[security]
secret_masking = true
remote_embedding_policy = "allow-sanitized"
quarantine_on_redaction = true
`,
        "utf8",
      );

      const config = await loadConfig(temp);
      expect(config.security.admission_mode).toBe("report-only");
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});
