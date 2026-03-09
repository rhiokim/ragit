import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const rootDir = process.cwd();
const installDir = await mkdtemp(path.join(os.tmpdir(), "ragit-pack-install-"));
let tarballPath = null;

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
  console.log(`packed CLI smoke test verified (${packSummary.version})`);
} finally {
  if (tarballPath) {
    await rm(tarballPath, { force: true });
  }
  await rm(installDir, { force: true, recursive: true });
}
