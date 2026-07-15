import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const cliPath = path.join(process.cwd(), "dist", "cli.js");
const cliUrl = pathToFileURL(cliPath).href;

const runSimulated = ({ nodeVersion, platform, arch }) => {
  const source = [
    `Object.defineProperty(process.versions, "node", { value: ${JSON.stringify(nodeVersion)} });`,
    `Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} });`,
    `Object.defineProperty(process, "arch", { value: ${JSON.stringify(arch)} });`,
    `process.argv = [process.execPath, ${JSON.stringify(cliPath)}, "--version"];`,
    `await import(${JSON.stringify(cliUrl)});`,
  ].join("\n");
  return spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    encoding: "utf8",
    stdio: "pipe",
  });
};

const assertFailure = (result, expectedMessage, label) => {
  if (result.error) throw result.error;
  if (result.status !== 1) {
    throw new Error(`${label} exit status: expected=1 actual=${result.status}`);
  }
  if (result.stdout !== "") {
    throw new Error(`${label} stdout must be empty: ${result.stdout}`);
  }
  if (!result.stderr.includes(`[ragit] 오류: ${expectedMessage}`)) {
    throw new Error(`${label} diagnostic mismatch: ${result.stderr}`);
  }
  if (result.stderr.includes("Prebuilt binary not found")) {
    throw new Error(`${label} loaded zvec before the RAGit runtime guard.`);
  }
};

assertFailure(
  runSimulated({ nodeVersion: "22.13.1", platform: "linux", arch: "x64" }),
  "지원되지 않는 Node.js 런타임입니다: 22.13.1 (필수: >=22.14.0)",
  "old Node runtime",
);

assertFailure(
  runSimulated({ nodeVersion: "24.0.0", platform: "linux", arch: "x64" }),
  "현재 플랫폼에서는 zvec를 지원하지 않습니다: linux/x64 unsupported (supported: darwin/arm64, linux/arm64)",
  "unsupported Linux x64 target",
);

assertFailure(
  runSimulated({ nodeVersion: "24.0.0", platform: "win32", arch: "x64" }),
  "현재 플랫폼에서는 zvec를 지원하지 않습니다: win32/x64 unsupported (supported: darwin/arm64, linux/arm64)",
  "unsupported Windows x64 target",
);

console.log("runtime guard contract verified");
