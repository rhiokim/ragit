import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const executableEntries = [
  { name: "cli", path: path.join(process.cwd(), "dist", "cli.js"), prefix: "[ragit] 오류:" },
  { name: "mcp", path: path.join(process.cwd(), "dist", "mcp.js"), prefix: "[ragit-mcp] error:" },
];

const runSimulated = ({ entryPath, nodeVersion, platform, arch }) => {
  const entryUrl = pathToFileURL(entryPath).href;
  const source = [
    `Object.defineProperty(process.versions, "node", { value: ${JSON.stringify(nodeVersion)} });`,
    `Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} });`,
    `Object.defineProperty(process, "arch", { value: ${JSON.stringify(arch)} });`,
    `process.argv = [process.execPath, ${JSON.stringify(entryPath)}, "--help"];`,
    `await import(${JSON.stringify(entryUrl)});`,
  ].join("\n");
  return spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    encoding: "utf8",
    stdio: "pipe",
  });
};

const assertFailure = (result, expectedMessage, expectedPrefix, label) => {
  if (result.error) throw result.error;
  if (result.status !== 1) {
    throw new Error(`${label} exit status: expected=1 actual=${result.status}`);
  }
  if (result.stdout !== "") {
    throw new Error(`${label} stdout must be empty: ${result.stdout}`);
  }
  if (!result.stderr.includes(`${expectedPrefix} ${expectedMessage}`)) {
    throw new Error(`${label} diagnostic mismatch: ${result.stderr}`);
  }
  if (result.stderr.includes("Prebuilt binary not found")) {
    throw new Error(`${label} loaded zvec before the RAGit runtime guard.`);
  }
};

for (const entry of executableEntries) {
  assertFailure(
    runSimulated({ entryPath: entry.path, nodeVersion: "22.13.1", platform: "linux", arch: "x64" }),
    "지원되지 않는 Node.js 런타임입니다: 22.13.1 (필수: >=22.14.0)",
    entry.prefix,
    `${entry.name} old Node runtime`,
  );

  assertFailure(
    runSimulated({ entryPath: entry.path, nodeVersion: "24.0.0", platform: "linux", arch: "x64" }),
    "현재 플랫폼에서는 zvec를 지원하지 않습니다: linux/x64 unsupported (supported: darwin/arm64, linux/arm64)",
    entry.prefix,
    `${entry.name} unsupported Linux x64 target`,
  );

  assertFailure(
    runSimulated({ entryPath: entry.path, nodeVersion: "24.0.0", platform: "win32", arch: "x64" }),
    "현재 플랫폼에서는 zvec를 지원하지 않습니다: win32/x64 unsupported (supported: darwin/arm64, linux/arm64)",
    entry.prefix,
    `${entry.name} unsupported Windows x64 target`,
  );
}

console.log("runtime guard contract verified");
