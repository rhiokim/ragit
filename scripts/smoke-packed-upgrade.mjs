import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const baselineVersion = "1.1.2";
const rootDir = process.cwd();
const baselineInstallDir = await mkdtemp(path.join(os.tmpdir(), "ragit-upgrade-baseline-"));
const candidateInstallDir = await mkdtemp(path.join(os.tmpdir(), "ragit-upgrade-candidate-"));
const repositoryDir = await mkdtemp(path.join(os.tmpdir(), "ragit-upgrade-repo-"));
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

const binPath = (installDir) => path.join(installDir, "node_modules", ".bin", "ragit");
const runInstalled = (installDir, args) =>
  execFileSync(binPath(installDir), args, {
    cwd: repositoryDir,
    encoding: "utf8",
    stdio: "pipe",
  });

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

  execFileSync("npm", ["install", "--prefix", baselineInstallDir, "--no-audit", "--no-fund", `ragit@${baselineVersion}`], {
    cwd: rootDir,
    encoding: "utf8",
    stdio: "pipe",
  });
  execFileSync("npm", ["install", "--prefix", candidateInstallDir, "--no-audit", "--no-fund", tarballPath], {
    cwd: rootDir,
    encoding: "utf8",
    stdio: "pipe",
  });

  git(["init", "-b", "main"]);
  git(["config", "user.email", "ragit@example.com"]);
  git(["config", "user.name", "ragit-upgrade-smoke"]);

  const initialized = parseJson(
    runInstalled(baselineInstallDir, ["init", "--yes", "--output", "json"]),
    "baseline init",
  );
  assertEqual(initialized.ok, true, "baseline init envelope");

  const documentPath = path.join(repositoryDir, "docs", "upgrade-smoke.plan.md");
  await mkdir(path.dirname(documentPath), { recursive: true });
  await writeFile(
    documentPath,
    "---\ntype: plan\n---\n# Upgrade store contract\nReopen this committed snapshot with the candidate tarball.\n",
    "utf8",
  );
  git(["add", "-A"]);
  git(["commit", "-m", "initialize upgrade smoke repository"]);
  const head = git(["rev-parse", "HEAD"]).toLowerCase();

  const ingested = parseJson(
    runInstalled(baselineInstallDir, ["ingest", "--all", "--format", "json"]),
    "baseline ingest",
  );
  assertEqual(ingested.data?.commitSha, head, "baseline ingest commitSha");

  const storeMetaPath = path.join(repositoryDir, ".ragit", "store", "meta.json");
  const manifestPath = path.join(repositoryDir, ".ragit", "manifest", `${head}.json`);
  const storeMetaBefore = await readFile(storeMetaPath, "utf8");
  const manifestBefore = await readFile(manifestPath, "utf8");

  const status = parseJson(
    runInstalled(candidateInstallDir, ["status", "--format", "json"]),
    "candidate status",
  );
  assertEqual(status.data?.snapshot?.resolvedSha, head, "candidate status snapshot.resolvedSha");
  assertEqual(status.data?.snapshot?.status, "indexed", "candidate status snapshot.status");
  assertEqual(status.data?.zvec?.status, "loaded", "candidate status zvec.status");
  assertEqual(status.data?.runtime?.supported, true, "candidate status runtime.supported");

  const query = parseJson(
    runInstalled(candidateInstallDir, ["query", "upgrade store contract", "--format", "json"]),
    "candidate query",
  );
  assertEqual(query.data?.snapshotSha, head, "candidate query snapshotSha");
  assertEqual(query.data?.snapshot?.resolvedSha, head, "candidate query snapshot.resolvedSha");
  if (!(query.data?.hits?.length > 0)) {
    throw new Error("candidate query must return the baseline document");
  }

  assertEqual(await readFile(storeMetaPath, "utf8"), storeMetaBefore, "store metadata bytes");
  assertEqual(await readFile(manifestPath, "utf8"), manifestBefore, "manifest bytes");

  console.log(`packed upgrade smoke verified (${baselineVersion} -> ${packSummary.version}; existing store reopened)`);
} finally {
  if (tarballPath) {
    await rm(tarballPath, { force: true });
  }
  await rm(baselineInstallDir, { force: true, recursive: true });
  await rm(candidateInstallDir, { force: true, recursive: true });
  await rm(repositoryDir, { force: true, recursive: true });
}
