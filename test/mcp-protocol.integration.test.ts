import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig, writeConfig } from "../src/core/config.js";
import { runIngest } from "../src/core/ingest.js";
import { ensureRagitStructure } from "../src/core/project.js";
import {
  MCP_HELP_TEXT,
  parseMcpStartupArgs,
} from "../src/mcp/startup.js";

const REPO_ROOT = process.cwd();
const MCP_ENTRY = path.join(REPO_ROOT, "src", "mcp-entry.ts");
const tempDirs: string[] = [];
const activeClients: Array<{ client: Client; transport: StdioClientTransport }> = [];

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const makeTempDir = async (prefix: string): Promise<string> => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(cwd);
  return cwd;
};

const snapshotTree = async (cwd: string, relative = ""): Promise<Record<string, string>> => {
  const result: Record<string, string> = {};
  const directory = path.join(cwd, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!relative && entry.name === ".git") continue;
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      Object.assign(result, await snapshotTree(cwd, child));
    } else if (entry.isFile()) {
      result[child] = createHash("sha256").update(await readFile(path.join(cwd, child))).digest("hex");
    }
  }
  return result;
};

const createIndexedRepository = async (): Promise<string> => {
  const cwd = await makeTempDir("ragit-mcp-protocol-");
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.email", "ragit@example.com"]);
  git(cwd, ["config", "user.name", "ragit-test"]);
  await mkdir(path.join(cwd, "docs"), { recursive: true });
  await writeFile(
    path.join(cwd, "docs", "mcp.spec.md"),
    "---\ntype: spec\narchitecture_view: lld\n---\n# MCP\nRead-only MCP retrieval preserves every repository byte.\n",
    "utf8",
  );
  git(cwd, ["add", "--", "docs/mcp.spec.md"]);
  git(cwd, ["commit", "-m", "seed MCP document"]);
  await ensureRagitStructure(cwd);
  await writeConfig(cwd, defaultConfig());
  await runIngest(cwd, { all: true });
  return cwd;
};

const createPlainGitRepository = async (): Promise<string> => {
  const cwd = await makeTempDir("ragit-mcp-plain-git-");
  git(cwd, ["init", "-b", "main"]);
  await writeFile(path.join(cwd, "README.md"), "# Plain Git repository\n", "utf8");
  return cwd;
};

const openStdioClient = async (cwd: string) => {
  const stderrChunks: string[] = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", MCP_ENTRY, "--cwd", cwd],
    cwd: REPO_ROOT,
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => stderrChunks.push(String(chunk)));
  const client = new Client({ name: "ragit-protocol-test", version: "1.0.0" });
  await client.connect(transport);
  activeClients.push({ client, transport });
  return {
    client,
    transport,
    stderr: () => stderrChunks.join(""),
  };
};

const callPreservingBytes = async <T>(cwd: string, call: () => Promise<T>): Promise<T> => {
  const before = await snapshotTree(cwd);
  const result = await call();
  expect(await snapshotTree(cwd)).toEqual(before);
  return result;
};

const envelopeFor = (rawResult: unknown): Record<string, unknown> => {
  const result = CallToolResultSchema.parse(rawResult);
  const content = result.content[0];
  if (!content || content.type !== "text") throw new Error("expected MCP text content");
  const envelope = JSON.parse(content.text) as Record<string, unknown>;
  expect(envelope).toEqual(result.structuredContent);
  return envelope;
};

afterEach(async () => {
  await Promise.all(
    activeClients.splice(0).map(({ client }) => client.close().catch(() => undefined)),
  );
  await Promise.all(tempDirs.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

describe("ragit-mcp startup parser", () => {
  it("parses omitted, separate, inline, and help arguments", () => {
    expect(parseMcpStartupArgs([])).toEqual({ cwd: undefined, help: false });
    expect(parseMcpStartupArgs(["--cwd", "./repo"])).toEqual({ cwd: "./repo", help: false });
    expect(parseMcpStartupArgs(["--cwd=./repo"])).toEqual({ cwd: "./repo", help: false });
    expect(parseMcpStartupArgs(["--help"])).toEqual({ cwd: undefined, help: true });
    expect(MCP_HELP_TEXT).toContain("ragit-mcp [--cwd");
  });

  it("rejects missing, duplicate, and unknown arguments", () => {
    expect(() => parseMcpStartupArgs(["--cwd"])).toThrow(/requires a non-empty path/);
    expect(() => parseMcpStartupArgs(["--cwd="])).toThrow(/requires a non-empty path/);
    expect(() => parseMcpStartupArgs(["--cwd", "one", "--cwd=two"])).toThrow(/only once/);
    expect(() => parseMcpStartupArgs(["--listen", "8080"])).toThrow(/unsupported ragit-mcp argument/);
  });
});

describe("ragit-mcp stdio protocol", () => {
  it(
    "serves all tools and failures without changing repository bytes",
    async () => {
      const cwd = await createIndexedRepository();
      const repositoryRoot = git(cwd, ["rev-parse", "--show-toplevel"]);
      const beforeStartup = await snapshotTree(cwd);
      const { client, transport, stderr } = await openStdioClient(cwd);
      expect(await snapshotTree(cwd)).toEqual(beforeStartup);

      const listed = await callPreservingBytes(cwd, () => client.listTools());
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        "ragit_status",
        "ragit_query",
        "ragit_context_pack",
      ]);

      const status = envelopeFor(await callPreservingBytes(cwd, () =>
        client.callTool({ name: "ragit_status", arguments: {} })));
      expect(status).toMatchObject({ ok: true, tool: "ragit_status", cwd: repositoryRoot });

      const query = envelopeFor(await callPreservingBytes(cwd, () =>
        client.callTool({
          name: "ragit_query",
          arguments: { question: "repository byte preservation", topK: 3, view: "minimal" },
        })));
      expect(query).toMatchObject({ ok: true, tool: "ragit_query", cwd: repositoryRoot });

      const context = envelopeFor(await callPreservingBytes(cwd, () =>
        client.callTool({
          name: "ragit_context_pack",
          arguments: { goal: "repository byte preservation", budget: 120, view: "minimal" },
        })));
      expect(context).toMatchObject({ ok: true, tool: "ragit_context_pack", cwd: repositoryRoot });

      const invalidResult = await callPreservingBytes(cwd, () =>
        client.callTool({ name: "ragit_query", arguments: { question: "auth", extra: true } }));
      expect(invalidResult.isError).toBe(true);
      expect(envelopeFor(invalidResult).error).toMatchObject({ code: "MCP_INVALID_INPUT" });

      const operationalResult = await callPreservingBytes(cwd, () =>
        client.callTool({ name: "ragit_query", arguments: { question: "auth", at: "missing-ref" } }));
      expect(operationalResult.isError).toBe(true);
      expect(envelopeFor(operationalResult).error).toMatchObject({ code: "SNAPSHOT_REF_INVALID" });

      expect(stderr()).toBe("");
      await client.close();
      expect(transport.pid).toBeNull();
      expect(stderr()).toBe("");
    },
    30_000,
  );

  it("does not create .ragit while reporting status for a plain Git repository", async () => {
    const cwd = await createPlainGitRepository();
    const repositoryRoot = git(cwd, ["rev-parse", "--show-toplevel"]);
    const { client, stderr } = await openStdioClient(cwd);

    const status = envelopeFor(await callPreservingBytes(cwd, () =>
      client.callTool({ name: "ragit_status", arguments: {} })));

    expect(status).toMatchObject({ ok: true, tool: "ragit_status", cwd: repositoryRoot });
    await expect(access(path.join(cwd, ".ragit"))).rejects.toThrow();
    expect(stderr()).toBe("");
  });
});
