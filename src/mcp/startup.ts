import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveCwd } from "../commands/bootstrap.js";
import { createRagitMcpServer } from "./server.js";

export interface McpStartupOptions {
  cwd?: string;
  help: boolean;
}

export const MCP_HELP_TEXT = `Usage: ragit-mcp [--cwd <repository>]

Run the fixed-repository, read-only RAGit MCP server over stdio.

Options:
  --cwd <repository>  Repository path (defaults to the current directory)
  --help              Show this help
`;

export const parseMcpStartupArgs = (argv: string[]): McpStartupOptions => {
  let cwd: string | undefined;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      help = true;
      continue;
    }
    if (argument === "--cwd") {
      if (cwd !== undefined) {
        throw new Error("--cwd may be provided only once");
      }
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--") || !value.trim()) {
        throw new Error("--cwd requires a non-empty path");
      }
      cwd = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--cwd=")) {
      if (cwd !== undefined) {
        throw new Error("--cwd may be provided only once");
      }
      const value = argument.slice("--cwd=".length);
      if (!value.trim()) {
        throw new Error("--cwd requires a non-empty path");
      }
      cwd = value;
      continue;
    }
    throw new Error(`unsupported ragit-mcp argument: ${argument}`);
  }

  return { cwd, help };
};

export const runMcpStdio = async (argv: string[]): Promise<void> => {
  const options = parseMcpStartupArgs(argv);
  if (options.help) {
    process.stdout.write(MCP_HELP_TEXT);
    return;
  }
  const cwd = await resolveCwd(options.cwd);
  const server = createRagitMcpServer({ cwd });
  await server.connect(new StdioServerTransport());
};
