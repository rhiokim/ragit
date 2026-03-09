import { execFileSync } from "node:child_process";

const rootDir = process.cwd();
const requiredFiles = new Set([
  "LICENSE",
  "README.md",
  "dist/cli.d.ts",
  "dist/cli.js",
  "dist/index.d.ts",
  "dist/index.js",
  "package.json",
]);
const forbiddenPrefixes = [".github/", ".ragit/", "apps/", "docs/", "src/", "test/", "testbed/"];

const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
  cwd: rootDir,
  encoding: "utf8",
});

const [packSummary] = JSON.parse(output);
if (!packSummary || !Array.isArray(packSummary.files)) {
  throw new Error("npm pack --dry-run 결과를 해석하지 못했습니다.");
}

const filePaths = packSummary.files.map((entry) => entry.path);
for (const requiredFile of requiredFiles) {
  if (!filePaths.includes(requiredFile)) {
    throw new Error(`pack 결과에 필수 파일이 없습니다: ${requiredFile}`);
  }
}

for (const filePath of filePaths) {
  if (forbiddenPrefixes.some((prefix) => filePath.startsWith(prefix))) {
    throw new Error(`pack 결과에 금지된 경로가 포함되었습니다: ${filePath}`);
  }

  const isAllowed =
    filePath === "package.json" ||
    filePath === "README.md" ||
    filePath === "LICENSE" ||
    (filePath.startsWith("dist/") && (filePath.endsWith(".js") || filePath.endsWith(".d.ts")));

  if (!isAllowed) {
    throw new Error(`pack 결과에 허용되지 않은 파일이 포함되었습니다: ${filePath}`);
  }
}

console.log(`pack contract verified (${filePaths.length} files)`);
