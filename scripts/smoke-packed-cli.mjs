import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const rootDir = process.cwd();
const installDir = await mkdtemp(path.join(os.tmpdir(), "ragit-pack-install-"));
const repositoryDir = await mkdtemp(path.join(os.tmpdir(), "ragit-pack-repo-"));
let tarballPath = null;

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

  console.log(`packed CLI smoke test verified (${packSummary.version}; strict branch isolation)`);
} finally {
  if (tarballPath) {
    await rm(tarballPath, { force: true });
  }
  await rm(installDir, { force: true, recursive: true });
  await rm(repositoryDir, { force: true, recursive: true });
}
