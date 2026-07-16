import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

const rootDir = process.cwd();
const distDir = path.join(rootDir, "dist");
const expectedFiles = [
  "index.js",
  "cli.js",
  "mcp.js",
  "index.d.ts",
  "cli.d.ts",
  "mcp.d.ts",
];

for (const file of expectedFiles) {
  await access(path.join(distDir, file));
}

const executableEntries = ["cli.js", "mcp.js"];

for (const entry of executableEntries) {
  const entryPath = path.join(distDir, entry);
  const entryContent = await readFile(entryPath, "utf8");

  if (!entryContent.startsWith("#!/usr/bin/env node")) {
    throw new Error(`dist/${entry} must preserve the node shebang.`);
  }

  if (entryContent.includes("Prebuilt binary not found") || entryContent.includes("@zvec/zvec")) {
    throw new Error(`dist/${entry} must validate the runtime before loading zvec.`);
  }

  await access(entryPath, constants.X_OK);
}

console.log("build contract verified");
