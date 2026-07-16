import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const rootDir = process.cwd();
const installDir = await mkdtemp(path.join(os.tmpdir(), "ragit-pack-install-"));
const repositoryDir = await mkdtemp(path.join(os.tmpdir(), "ragit-pack-repo-"));
let tarballPath = null;
let mcpClient = null;

const assertEqual = (actual, expected, label) => {
  if (actual !== expected) {
    throw new Error(`${label}: expected=${expected} actual=${actual}`);
  }
};

const parseJson = (output, label) => {
  try {
    return JSON.parse(output.trim());
  } catch (error) {
    throw new Error(`${label} output is not valid JSON: ${output}`, { cause: error });
  }
};

const git = (args) =>
  execFileSync("git", args, {
    cwd: repositoryDir,
    encoding: "utf8",
    stdio: "pipe",
  }).trim();

const snapshotTree = async (cwd, relative = "") => {
  const result = {};
  const directory = path.join(cwd, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!relative && entry.name === ".git") continue;
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      Object.assign(result, await snapshotTree(cwd, child));
    } else if (entry.isFile()) {
      result[child] = createHash("sha256")
        .update(await readFile(path.join(cwd, child)))
        .digest("hex");
    }
  }
  return result;
};

const callPreservingBytes = async (call) => {
  const before = await snapshotTree(repositoryDir);
  const result = await call();
  const after = await snapshotTree(repositoryDir);
  if (JSON.stringify(after) !== JSON.stringify(before)) {
    throw new Error("packed MCP call changed repository-owned bytes.");
  }
  return result;
};

const assertMcpSuccess = (result, tool) => {
  if (result.isError || result.structuredContent?.ok !== true) {
    throw new Error(`packed MCP ${tool} call failed: ${JSON.stringify(result)}`);
  }
};

try {
  const output = execFileSync("npm", ["pack", "--json"], {
    cwd: rootDir,
    encoding: "utf8",
  });
  const [packSummary] = JSON.parse(output);
  if (!packSummary?.filename) {
    throw new Error("npm pack 결과에 tarball filename이 없습니다.");
  }

  tarballPath = path.join(rootDir, packSummary.filename);
  execFileSync("npm", ["install", "--prefix", installDir, tarballPath], {
    cwd: rootDir,
    encoding: "utf8",
    stdio: "pipe",
  });

  const binPath = path.join(installDir, "node_modules", ".bin", "ragit");
  const mcpBinPath = path.join(installDir, "node_modules", ".bin", "ragit-mcp");
  await access(mcpBinPath, constants.X_OK);
  const version = execFileSync(binPath, ["--version"], {
    cwd: rootDir,
    encoding: "utf8",
  }).trim();
  const help = execFileSync(binPath, ["--help"], {
    cwd: rootDir,
    encoding: "utf8",
  });

  if (version !== packSummary.version) {
    throw new Error(`packed CLI version mismatch: expected=${packSummary.version} actual=${version}`);
  }
  if (!help.includes("Usage: ragit")) {
    throw new Error("packed CLI help output does not contain the usage header.");
  }

  const runInstalled = (args) =>
    execFileSync(binPath, args, {
      cwd: repositoryDir,
      encoding: "utf8",
      stdio: "pipe",
    });

  git(["init", "-b", "main"]);
  git(["config", "user.email", "ragit@example.com"]);
  git(["config", "user.name", "ragit-pack-smoke"]);

  const init = parseJson(runInstalled(["init", "--yes", "--output", "json"]), "init");
  assertEqual(init.ok, true, "packed init envelope");

  const smokeDocument = path.join(repositoryDir, "docs", "packed-smoke.plan.md");
  await mkdir(path.dirname(smokeDocument), { recursive: true });
  await writeFile(
    smokeDocument,
    "---\ntype: plan\n---\n# Packed CLI snapshot plan\nKeep installed query selection exact.\n",
    "utf8",
  );
  git(["add", "-A"]);
  git(["commit", "-m", "initialize packed smoke repository"]);
  const mainHead = git(["rev-parse", "HEAD"]).toLowerCase();

  const ingest = parseJson(
    runInstalled(["ingest", "--all", "--format", "json"]),
    "ingest",
  );
  assertEqual(ingest.data?.commitSha, mainHead, "packed ingest commitSha");

  const mainQuery = parseJson(
    runInstalled(["query", "packed snapshot contract", "--format", "json"]),
    "main query",
  );
  assertEqual(mainQuery.data?.snapshotSha, mainHead, "packed query snapshotSha");
  assertEqual(
    mainQuery.data?.snapshot?.resolvedSha,
    mainHead,
    "packed query snapshot.resolvedSha",
  );

  const contextPack = parseJson(
    runInstalled(["context", "pack", "packed snapshot contract", "--format", "json"]),
    "context pack",
  );
  assertEqual(contextPack.ok, true, "packed context pack envelope");
  assertEqual(contextPack.data?.snapshotSha, mainHead, "packed context pack snapshotSha");
  assertEqual(
    contextPack.data?.snapshot?.resolvedSha,
    mainHead,
    "packed context pack snapshot.resolvedSha",
  );
  if (!(contextPack.data?.selectedHits > 0)) {
    throw new Error(`packed context pack selectedHits must be positive: ${contextPack.data?.selectedHits}`);
  }

  const status = parseJson(runInstalled(["status", "--format", "json"]), "status");
  assertEqual(status.ok, true, "packed status envelope");
  assertEqual(status.data?.snapshot?.resolvedSha, mainHead, "packed status snapshot.resolvedSha");
  assertEqual(status.data?.snapshot?.status, "indexed", "packed status snapshot.status");
  assertEqual(status.data?.zvec?.searchReady, true, "packed status zvec.searchReady");
  assertEqual(status.data?.runtime?.supported, true, "packed status runtime.supported");
  assertEqual(
    status.data?.runtime?.platform?.current,
    `${process.platform}/${process.arch}`,
    "packed status runtime.platform.current",
  );

  git(["switch", "-c", "divergent"]);
  await writeFile(
    smokeDocument,
    "---\ntype: plan\n---\n# Divergent packed CLI plan\nThis branch must not reuse the main snapshot.\n",
    "utf8",
  );
  git(["add", "--", "docs/packed-smoke.plan.md"]);
  git(["commit", "-m", "diverge packed smoke branch"]);
  const divergentHead = git(["rev-parse", "HEAD"]).toLowerCase();

  const missingQuery = spawnSync(
    binPath,
    ["query", "packed snapshot contract", "--format", "json"],
    {
      cwd: repositoryDir,
      encoding: "utf8",
      stdio: "pipe",
    },
  );
  if (missingQuery.error) throw missingQuery.error;
  assertEqual(missingQuery.status, 3, "divergent query exit status");
  assertEqual(missingQuery.stderr.trim(), "", "divergent query stderr");
  const missingEnvelope = parseJson(missingQuery.stdout, "divergent query");
  assertEqual(missingEnvelope.error?.code, "SNAPSHOT_NOT_INDEXED", "divergent query code");
  assertEqual(
    missingEnvelope.error?.details?.resolvedSha,
    divergentHead,
    "divergent query resolvedSha",
  );
  assertEqual(
    missingEnvelope.error?.details?.nearestIndexedAncestor,
    mainHead,
    "divergent query nearest indexed ancestor",
  );

  git(["switch", "main"]);
  const restoredQuery = parseJson(
    runInstalled(["query", "packed snapshot contract", "--format", "json"]),
    "restored main query",
  );
  assertEqual(restoredQuery.data?.snapshotSha, mainHead, "restored query snapshotSha");
  assertEqual(
    restoredQuery.data?.snapshot?.resolvedSha,
    mainHead,
    "restored query snapshot.resolvedSha",
  );

  const stderrChunks = [];
  const mcpTransport = new StdioClientTransport({
    command: mcpBinPath,
    args: ["--cwd", repositoryDir],
    cwd: rootDir,
    stderr: "pipe",
  });
  mcpTransport.stderr?.on("data", (chunk) => stderrChunks.push(String(chunk)));
  mcpClient = new Client({ name: "ragit-packed-smoke", version: "1.0.0" });
  await mcpClient.connect(mcpTransport);

  const listed = await callPreservingBytes(() => mcpClient.listTools());
  const toolNames = listed.tools.map((tool) => tool.name);
  if (JSON.stringify(toolNames) !== JSON.stringify(["ragit_status", "ragit_query", "ragit_context_pack"])) {
    throw new Error(`packed MCP tool list mismatch: ${JSON.stringify(toolNames)}`);
  }

  const mcpStatus = await callPreservingBytes(() =>
    mcpClient.callTool({ name: "ragit_status", arguments: {} }));
  assertMcpSuccess(mcpStatus, "ragit_status");

  const mcpQuery = await callPreservingBytes(() =>
    mcpClient.callTool({
      name: "ragit_query",
      arguments: { question: "packed snapshot contract", topK: 3 },
    }));
  assertMcpSuccess(mcpQuery, "ragit_query");

  const mcpContext = await callPreservingBytes(() =>
    mcpClient.callTool({
      name: "ragit_context_pack",
      arguments: { goal: "packed snapshot contract", budget: 120 },
    }));
  assertMcpSuccess(mcpContext, "ragit_context_pack");

  await mcpClient.close();
  mcpClient = null;
  assertEqual(stderrChunks.join(""), "", "packed MCP stderr");

  console.log(`packed CLI and MCP smoke verified (${packSummary.version}; strict branch isolation; byte-preserving reads)`);
} finally {
  if (mcpClient) {
    await mcpClient.close().catch(() => undefined);
  }
  if (tarballPath) {
    await rm(tarballPath, { force: true });
  }
  await rm(installDir, { force: true, recursive: true });
  await rm(repositoryDir, { force: true, recursive: true });
}
