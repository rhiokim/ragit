import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { normalizeCliView, type CliView } from "../core/cliContract.js";
import { assertAllowedKeys, assertNoControlCharacters } from "../core/cliInput.js";
import {
  normalizeContextPackCommandInput,
  normalizeQueryCommandInput,
  type ContextPackCommandInput,
  type QueryCommandInput,
} from "../core/commandInputs.js";
import { EmbeddingCacheMissError } from "../core/embedding.js";
import {
  isRagitOperationalError,
  type RagitErrorCategory,
  type RagitErrorPayload,
} from "../core/errors.js";
import { RAGIT_VERSION } from "../core/version.js";

export const RAGIT_MCP_TOOL_NAMES = [
  "ragit_status",
  "ragit_query",
  "ragit_context_pack",
] as const;

export type RagitMcpToolName = typeof RAGIT_MCP_TOOL_NAMES[number];

export const isRagitMcpToolName = (value: string): value is RagitMcpToolName =>
  RAGIT_MCP_TOOL_NAMES.includes(value as RagitMcpToolName);

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const RETRIEVAL_SCOPE_SCHEMA = {
  type: "string",
  enum: ["durable", "session", "harness", "evidence", "all"],
} as const;

const VIEW_SCHEMA = {
  type: "string",
  enum: ["minimal", "default", "full"],
} as const;

export const RAGIT_MCP_TOOLS: Tool[] = [
  {
    name: "ragit_status",
    description: "Read the fixed repository's current RAGit status.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: "ragit_query",
    description: "Query indexed knowledge from the fixed repository without writing repository state.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", minLength: 1 },
        topK: { type: "integer", minimum: 1, maximum: 50 },
        at: { type: "string", minLength: 1 },
        scope: RETRIEVAL_SCOPE_SCHEMA,
        view: VIEW_SCHEMA,
        explain: { type: "boolean" },
      },
      required: ["question"],
      additionalProperties: false,
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: "ragit_context_pack",
    description: "Build a bounded context pack from the fixed repository without writing repository state.",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", minLength: 1 },
        budget: { type: "integer", minimum: 1, maximum: 32_000 },
        at: { type: "string", minLength: 1 },
        scope: RETRIEVAL_SCOPE_SCHEMA,
        view: VIEW_SCHEMA,
      },
      required: ["goal"],
      additionalProperties: false,
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
];

export type McpOwnedErrorCode =
  | "MCP_INVALID_INPUT"
  | "MCP_REMOTE_EMBEDDING_CACHE_MISS"
  | "MCP_INTERNAL_ERROR";

export interface McpOwnedErrorPayload {
  code: McpOwnedErrorCode;
  category: RagitErrorCategory;
  message: string;
  retryable: boolean;
  details: Record<string, unknown>;
  recovery: { command: string };
}

export interface RagitMcpEnvelope<T> {
  ok: boolean;
  tool: string;
  version: string;
  cwd: string;
  data: T | null;
  warnings: string[];
  error?: RagitErrorPayload | McpOwnedErrorPayload;
}

const toolResultFromEnvelope = <T>(
  envelope: RagitMcpEnvelope<T>,
  isError = false,
): CallToolResult => {
  const structuredContent: Record<string, unknown> = { ...envelope };
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
    ...(isError ? { isError: true } : {}),
  };
};

export const successToolResult = <T>(
  tool: RagitMcpToolName,
  cwd: string,
  data: T,
  warnings: string[],
): CallToolResult =>
  toolResultFromEnvelope({
    ok: true,
    tool,
    version: RAGIT_VERSION,
    cwd,
    data,
    warnings,
  });

export const failureToolResult = (
  tool: string,
  cwd: string,
  error: RagitErrorPayload | McpOwnedErrorPayload,
): CallToolResult =>
  toolResultFromEnvelope(
    {
      ok: false,
      tool,
      version: RAGIT_VERSION,
      cwd,
      data: null,
      warnings: [],
      error,
    },
    true,
  );

const ownedErrorPayload = (
  code: McpOwnedErrorCode,
  details: Record<string, unknown> = {},
): McpOwnedErrorPayload => {
  if (code === "MCP_INVALID_INPUT") {
    return {
      code,
      category: "invalid_input",
      message: "MCP tool input is invalid.",
      retryable: false,
      details,
      recovery: { command: "Correct the tool arguments and retry." },
    };
  }
  if (code === "MCP_REMOTE_EMBEDDING_CACHE_MISS") {
    return {
      code,
      category: "not_ready",
      message: "The read-only remote embedding cache is incomplete.",
      retryable: false,
      details,
      recovery: {
        command: "Run the equivalent CLI query outside MCP to populate the configured remote cache, then retry.",
      },
    };
  }
  return {
    code,
    category: "transient",
    message: "The MCP tool failed unexpectedly.",
    retryable: true,
    details,
    recovery: { command: "ragit doctor" },
  };
};

export const invalidInputToolResult = (
  tool: string,
  cwd: string,
): CallToolResult => failureToolResult(tool, cwd, ownedErrorPayload("MCP_INVALID_INPUT"));

export const executionFailureToolResult = (
  tool: RagitMcpToolName,
  cwd: string,
  error: unknown,
): CallToolResult => {
  if (isRagitOperationalError(error)) {
    return failureToolResult(tool, cwd, error.toPayload());
  }
  if (error instanceof EmbeddingCacheMissError) {
    return failureToolResult(
      tool,
      cwd,
      ownedErrorPayload("MCP_REMOTE_EMBEDDING_CACHE_MISS", {
        provider: error.provider,
        model: error.model,
        missingCount: error.missingCount,
      }),
    );
  }
  return failureToolResult(tool, cwd, ownedErrorPayload("MCP_INTERNAL_ERROR"));
};

const requirePlainObject = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} input must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} input must be a plain object`);
  }
  return value as Record<string, unknown>;
};

const normalizeView = (value: unknown): CliView => {
  if (value !== undefined && typeof value !== "string") {
    throw new Error("view must be a string");
  }
  return normalizeCliView(value, "default");
};

const assertBoundedSafeInteger = (
  value: number | undefined,
  maximum: number,
  label: string,
): void => {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value > maximum) {
    throw new Error(`${label} must be a safe integer between 1 and ${maximum}`);
  }
};

export const normalizeMcpStatusInput = (value: unknown): Record<string, never> => {
  const raw = requirePlainObject(value, "ragit_status");
  assertNoControlCharacters(raw, "ragit_status");
  assertAllowedKeys(raw, [], "ragit_status");
  return {};
};

export const normalizeMcpQueryInput = (
  value: unknown,
): { input: QueryCommandInput; view: CliView } => {
  const raw = requirePlainObject(value, "ragit_query");
  assertNoControlCharacters(raw, "ragit_query");
  assertAllowedKeys(raw, ["question", "topK", "at", "scope", "view", "explain"], "ragit_query");
  const { view, ...commandValue } = raw;
  const input = normalizeQueryCommandInput(commandValue);
  assertBoundedSafeInteger(input.topK, 50, "ragit_query.topK");
  return { input, view: normalizeView(view) };
};

export const normalizeMcpContextPackInput = (
  value: unknown,
): { input: ContextPackCommandInput; view: CliView } => {
  const raw = requirePlainObject(value, "ragit_context_pack");
  assertNoControlCharacters(raw, "ragit_context_pack");
  assertAllowedKeys(raw, ["goal", "budget", "at", "scope", "view"], "ragit_context_pack");
  const { view, ...commandValue } = raw;
  const input = normalizeContextPackCommandInput(commandValue);
  assertBoundedSafeInteger(input.budget, 32_000, "ragit_context_pack.budget");
  return { input, view: normalizeView(view) };
};
