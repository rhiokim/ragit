import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

const rootDir = process.cwd();
const distDir = path.join(rootDir, "dist");
const expectedFiles = [
  "index.js",
  "cli.js",
  "index.d.ts",
  "cli.d.ts",
];

for (const file of expectedFiles) {
  await access(path.join(distDir, file));
}

const cliPath = path.join(distDir, "cli.js");
const cliContent = await readFile(cliPath, "utf8");

if (!cliContent.startsWith("#!/usr/bin/env node")) {
  throw new Error("dist/cli.js must preserve the node shebang.");
}

await access(cliPath, constants.X_OK);

console.log("build contract verified");
