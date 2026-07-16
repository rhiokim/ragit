import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import {
  readCommandExecutor,
  type ReadCommandOptions,
} from "../core/readCommands.js";
import { READ_ONLY_RETRIEVAL_POLICY } from "../core/retrieval.js";
import { RAGIT_VERSION } from "../core/version.js";
import {
  executionFailureToolResult,
  invalidInputToolResult,
  isRagitMcpToolName,
  normalizeMcpContextPackInput,
  normalizeMcpQueryInput,
  normalizeMcpStatusInput,
  RAGIT_MCP_TOOLS,
  successToolResult,
  type RagitMcpToolName,
} from "./contracts.js";

export interface McpReadExecutionResult {
  data: unknown;
  warnings: string[];
}

export interface McpReadDependencies {
  status(cwd: string): Promise<McpReadExecutionResult>;
  query(cwd: string, value: unknown, options?: ReadCommandOptions): Promise<McpReadExecutionResult>;
  contextPack(cwd: string, value: unknown, options?: ReadCommandOptions): Promise<McpReadExecutionResult>;
}

const defaultMcpReadDependencies: McpReadDependencies = {
  status: (cwd) => readCommandExecutor.status(cwd),
  query: (cwd, value, options) => readCommandExecutor.query(cwd, value, options),
  contextPack: (cwd, value, options) => readCommandExecutor.contextPack(cwd, value, options),
};

export interface CreateRagitMcpServerOptions {
  cwd: string;
  dependencies?: McpReadDependencies;
}

interface ExecuteRagitMcpToolOptions {
  tool: RagitMcpToolName;
  raw: unknown;
  cwd: string;
  dependencies: McpReadDependencies;
}

export const executeRagitMcpTool = async ({
  tool,
  raw,
  cwd,
  dependencies,
}: ExecuteRagitMcpToolOptions): Promise<CallToolResult> => {
  if (tool === "ragit_status") {
    try {
      normalizeMcpStatusInput(raw);
    } catch {
      return invalidInputToolResult(tool, cwd);
    }
    try {
      const executed = await dependencies.status(cwd);
      return successToolResult(tool, cwd, executed.data, executed.warnings);
    } catch (error) {
      return executionFailureToolResult(tool, cwd, error);
    }
  }

  if (tool === "ragit_query") {
    let normalized: ReturnType<typeof normalizeMcpQueryInput>;
    try {
      normalized = normalizeMcpQueryInput(raw);
    } catch {
      return invalidInputToolResult(tool, cwd);
    }
    try {
      const executed = await dependencies.query(cwd, normalized.input, {
        view: normalized.view,
        executionPolicy: READ_ONLY_RETRIEVAL_POLICY,
      });
      return successToolResult(tool, cwd, executed.data, executed.warnings);
    } catch (error) {
      return executionFailureToolResult(tool, cwd, error);
    }
  }

  let normalized: ReturnType<typeof normalizeMcpContextPackInput>;
  try {
    normalized = normalizeMcpContextPackInput(raw);
  } catch {
    return invalidInputToolResult(tool, cwd);
  }
  try {
    const executed = await dependencies.contextPack(cwd, normalized.input, {
      view: normalized.view,
      executionPolicy: READ_ONLY_RETRIEVAL_POLICY,
    });
    return successToolResult(tool, cwd, executed.data, executed.warnings);
  } catch (error) {
    return executionFailureToolResult(tool, cwd, error);
  }
};

export const createRagitMcpServer = ({
  cwd,
  dependencies = defaultMcpReadDependencies,
}: CreateRagitMcpServerOptions): Server => {
  const server = new Server(
    { name: "ragit", version: RAGIT_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: RAGIT_MCP_TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = request.params.name;
    const raw = request.params.arguments ?? {};
    if (!isRagitMcpToolName(tool)) {
      return invalidInputToolResult(tool, cwd);
    }
    return executeRagitMcpTool({ tool, raw, cwd, dependencies });
  });

  return server;
};
