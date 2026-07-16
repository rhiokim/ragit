import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/core/config.js";
import { EmbeddingCacheMissError, resolveEmbeddingProfile } from "../src/core/embedding.js";
import { RagitOperationalError } from "../src/core/errors.js";
import { READ_ONLY_RETRIEVAL_POLICY } from "../src/core/retrieval.js";
import {
  createRagitMcpServer,
  type McpReadDependencies,
} from "../src/mcp/server.js";

const FIXED_CWD = "/fixed/repository";
const connected: Array<{ client: Client; server: ReturnType<typeof createRagitMcpServer> }> = [];

const createDependencies = (): McpReadDependencies => ({
  status: vi.fn(async () => ({ data: { kind: "status" }, warnings: [] })),
  query: vi.fn(async () => ({ data: { kind: "query" }, warnings: ["query warning"] })),
  contextPack: vi.fn(async () => ({ data: { kind: "context" }, warnings: ["context warning"] })),
});

const connectClient = async (dependencies: McpReadDependencies) => {
  const server = createRagitMcpServer({ cwd: FIXED_CWD, dependencies });
  const client = new Client({ name: "ragit-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  connected.push({ client, server });
  return client;
};

const parsedEnvelope = (rawResult: unknown) => {
  const result = CallToolResultSchema.parse(rawResult);
  expect(result.content).toHaveLength(1);
  const content = result.content[0];
  expect(content?.type).toBe("text");
  if (!content || content.type !== "text") throw new Error("expected MCP text content");
  const parsed = JSON.parse(content.text) as Record<string, unknown>;
  expect(parsed).toEqual(result.structuredContent);
  return parsed;
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    connected.splice(0).flatMap(({ client, server }) => [
      client.close().catch(() => undefined),
      server.close().catch(() => undefined),
    ]),
  );
});

describe("read-only MCP server contract", () => {
  it("lists exactly three strict, bounded, read-only tools", async () => {
    const client = await connectClient(createDependencies());

    const listed = await client.listTools();

    expect(listed.tools.map((tool) => tool.name)).toEqual([
      "ragit_status",
      "ragit_query",
      "ragit_context_pack",
    ]);
    for (const tool of listed.tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    }
    const query = listed.tools.find((tool) => tool.name === "ragit_query");
    const context = listed.tools.find((tool) => tool.name === "ragit_context_pack");
    expect(query?.inputSchema.required).toEqual(["question"]);
    expect(query?.inputSchema.properties?.topK).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 50,
    });
    expect(context?.inputSchema.required).toEqual(["goal"]);
    expect(context?.inputSchema.properties?.budget).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 32_000,
    });
  });

  it("returns identical JSON text and structured content for all successful tools", async () => {
    const dependencies = createDependencies();
    const client = await connectClient(dependencies);

    const status = parsedEnvelope(await client.callTool({ name: "ragit_status", arguments: {} }));
    const query = parsedEnvelope(await client.callTool({
      name: "ragit_query",
      arguments: { question: "restore auth", topK: 3, view: "minimal", explain: true },
    }));
    const context = parsedEnvelope(await client.callTool({
      name: "ragit_context_pack",
      arguments: { goal: "restore auth", budget: 120, view: "full" },
    }));

    expect(status).toMatchObject({ ok: true, tool: "ragit_status", cwd: FIXED_CWD, data: { kind: "status" } });
    expect(query).toMatchObject({
      ok: true,
      tool: "ragit_query",
      cwd: FIXED_CWD,
      data: { kind: "query" },
      warnings: ["query warning"],
    });
    expect(context).toMatchObject({
      ok: true,
      tool: "ragit_context_pack",
      cwd: FIXED_CWD,
      data: { kind: "context" },
      warnings: ["context warning"],
    });
    expect(dependencies.status).toHaveBeenCalledWith(FIXED_CWD);
    expect(dependencies.query).toHaveBeenCalledWith(
      FIXED_CWD,
      { question: "restore auth", topK: 3, at: undefined, scope: undefined, explain: true },
      { view: "minimal", executionPolicy: READ_ONLY_RETRIEVAL_POLICY },
    );
    expect(dependencies.contextPack).toHaveBeenCalledWith(
      FIXED_CWD,
      { goal: "restore auth", budget: 120, at: undefined, scope: undefined },
      { view: "full", executionPolicy: READ_ONLY_RETRIEVAL_POLICY },
    );
  });

  it.each([
    ["ragit_status", { unexpected: true }],
    ["ragit_query", {}],
    ["ragit_query", { question: 42 }],
    ["ragit_query", { question: "auth", extra: true }],
    ["ragit_query", { question: "auth", topK: 1.5 }],
    ["ragit_query", { question: "auth", topK: 51 }],
    ["ragit_query", { question: "auth\u0000" }],
    ["ragit_context_pack", {}],
    ["ragit_context_pack", { goal: "auth", budget: 1.5 }],
    ["ragit_context_pack", { goal: "auth", budget: 32_001 }],
    ["ragit_context_pack", { goal: "auth", view: 42 }],
    ["unknown_tool", {}],
  ])("maps invalid %s input to a structured MCP_INVALID_INPUT error", async (name, args) => {
    const dependencies = createDependencies();
    const client = await connectClient(dependencies);

    const result = await client.callTool({ name, arguments: args });
    const envelope = parsedEnvelope(result);

    expect(result.isError).toBe(true);
    expect(envelope).toMatchObject({
      ok: false,
      tool: name,
      cwd: FIXED_CWD,
      data: null,
      error: {
        code: "MCP_INVALID_INPUT",
        category: "invalid_input",
        retryable: false,
      },
    });
    expect(dependencies.status).not.toHaveBeenCalled();
    expect(dependencies.query).not.toHaveBeenCalled();
    expect(dependencies.contextPack).not.toHaveBeenCalled();
  });

  it("passes an operational error payload through unchanged", async () => {
    const dependencies = createDependencies();
    const operational = new RagitOperationalError(
      "SNAPSHOT_NOT_INDEXED",
      "snapshot missing",
      {
        details: { resolvedSha: "a".repeat(40) },
        recovery: { command: "ragit ingest --all" },
      },
    );
    dependencies.query = vi.fn(async () => Promise.reject(operational));
    const client = await connectClient(dependencies);

    const result = await client.callTool({ name: "ragit_query", arguments: { question: "auth" } });
    const envelope = parsedEnvelope(result);

    expect(result.isError).toBe(true);
    expect(envelope.error).toEqual(operational.toPayload());
  });

  it("maps a remote cache miss without exposing input text", async () => {
    const dependencies = createDependencies();
    const profile = resolveEmbeddingProfile({
      ...defaultConfig(),
      embedding: { ...defaultConfig().embedding, provider: "openai", model: "text-embedding-3-small" },
    });
    dependencies.query = vi.fn(async () => Promise.reject(new EmbeddingCacheMissError(profile, 2)));
    const client = await connectClient(dependencies);

    const result = await client.callTool({
      name: "ragit_query",
      arguments: { question: "private uncached question" },
    });
    const envelope = parsedEnvelope(result);
    const serialized = JSON.stringify(envelope);

    expect(result.isError).toBe(true);
    expect(envelope.error).toMatchObject({
      code: "MCP_REMOTE_EMBEDDING_CACHE_MISS",
      category: "not_ready",
      retryable: false,
      details: { provider: "openai", model: "text-embedding-3-small", missingCount: 2 },
    });
    expect(serialized).not.toContain("private uncached question");
  });

  it("maps unexpected failures without serializing messages, stacks, or causes", async () => {
    const dependencies = createDependencies();
    const internal = new Error("secret internal detail", { cause: { token: "private-cause" } });
    dependencies.status = vi.fn(async () => Promise.reject(internal));
    const client = await connectClient(dependencies);

    const result = await client.callTool({ name: "ragit_status", arguments: {} });
    const envelope = parsedEnvelope(result);
    const serialized = JSON.stringify(envelope);

    expect(result.isError).toBe(true);
    expect(envelope.error).toMatchObject({
      code: "MCP_INTERNAL_ERROR",
      category: "transient",
      retryable: true,
      details: {},
    });
    expect(serialized).not.toContain("secret internal detail");
    expect(serialized).not.toContain("private-cause");
    expect(serialized).not.toContain("stack");
    expect(serialized).not.toContain("cause");
  });

  it("keeps the MCP source subtree free of generic and mutating command imports", async () => {
    const root = path.join(process.cwd(), "src", "mcp");
    const source = (await readdir(root))
      .filter((name) => name.endsWith(".ts"))
      .map(async (name) => readFile(path.join(root, name), "utf8"));
    const combined = (await Promise.all(source)).join("\n");

    expect(combined).not.toMatch(/(?:commandRegistry|cli\.js|ingest|repair|memory|artifact|migrate|hooks|security-purge)/);
  });
});
