import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { buildSnapshotManifest } from "../src/core/manifest.js";
import { selectSnapshot } from "../src/core/snapshot.js";

const SAMPLES = 30;
const MANIFEST_COUNT = 1_000;
const MAX_P95_MS = 100;

const repositoryDir = await mkdtemp(path.join(os.tmpdir(), "ragit-snapshot-benchmark-"));

const git = (args: string[]): string =>
  execFileSync("git", args, {
    cwd: repositoryDir,
    encoding: "utf8",
    stdio: "pipe",
  }).trim();

try {
  git(["init", "-b", "main"]);
  git(["config", "user.email", "ragit@example.com"]);
  git(["config", "user.name", "ragit-snapshot-benchmark"]);
  await writeFile(
    path.join(repositoryDir, ".gitignore"),
    ".ragit/manifest/\n",
    "utf8",
  );
  git(["add", ".gitignore"]);
  git(["commit", "-m", "initialize snapshot benchmark"]);

  const headSha = git(["rev-parse", "HEAD"]).toLowerCase();
  const manifestShas = new Set<string>([headSha]);
  for (let index = 0; manifestShas.size < MANIFEST_COUNT; index += 1) {
    manifestShas.add(index.toString(16).padStart(40, "0"));
  }

  const manifestDir = path.join(repositoryDir, ".ragit", "manifest");
  await mkdir(manifestDir, { recursive: true });
  for (const sha of manifestShas) {
    const manifest = buildSnapshotManifest(sha, null, [], []);
    await writeFile(
      path.join(manifestDir, `${sha}.json`),
      `${JSON.stringify(manifest)}\n`,
      "utf8",
    );
  }

  for (let index = 0; index < 5; index += 1) {
    await selectSnapshot(repositoryDir);
  }

  const durations: number[] = [];
  for (let index = 0; index < SAMPLES; index += 1) {
    const startedAt = performance.now();
    await selectSnapshot(repositoryDir);
    durations.push(performance.now() - startedAt);
  }

  durations.sort((left, right) => left - right);
  const p95Index = Math.ceil(durations.length * 0.95) - 1;
  const result = {
    samples: durations.length,
    manifestCount: manifestShas.size,
    p95Ms: Number(durations[p95Index].toFixed(3)),
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);

  if (result.p95Ms > MAX_P95_MS) {
    throw new Error(`snapshot selection p95 exceeded ${MAX_P95_MS}ms: ${result.p95Ms}ms`);
  }
} finally {
  await rm(repositoryDir, { recursive: true, force: true });
}
