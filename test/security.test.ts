import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/core/config.js";
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
});
