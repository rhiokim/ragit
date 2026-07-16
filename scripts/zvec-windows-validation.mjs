import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { access, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const mode = process.argv[2];
const rootDir = process.cwd();
const artifactDir = path.resolve(process.env.VALIDATION_ARTIFACT_DIR ?? path.join(rootDir, "validation-artifacts"));
const candidateVersion = "0.5.0";
const baselineVersion = "2.0.0";
const npm = process.platform === "win32"
  ? { file: process.execPath, argsPrefix: [path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")] }
  : { file: "npm", argsPrefix: [] };

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const parseJson = (output, label) => {
  try {
    return JSON.parse(output.trim());
  } catch (error) {
    throw new Error(`${label} did not emit JSON: ${output}`, { cause: error });
  }
};

const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();

const command = (file, args, options = {}) => {
  const result = spawnSync(file, args, { encoding: "utf8", stdio: "pipe", ...options });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

const mustRun = (file, args, options = {}) => {
  const result = command(file, args, options);
  if (result.status !== 0) {
    throw new Error(`${file} ${args.join(" ")} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
};

const runInstalled = (executable, args, options = {}) =>
  mustRun(executable.file, [...executable.argsPrefix, ...args], options);

const commandInstalled = (executable, args, options = {}) =>
  command(executable.file, [...executable.argsPrefix, ...args], options);

const runNpm = (args, options = {}) => mustRun(npm.file, [...npm.argsPrefix, ...args], options);

const treeHash = async (directory, relative = "") => {
  const result = {};
  const entries = await readdir(path.join(directory, relative), { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    const entryPath = path.join(directory, child);
    if (entry.isDirectory()) {
      Object.assign(result, await treeHash(directory, child));
    } else if (entry.isFile()) {
      result[child] = createHash("sha256").update(await readFile(entryPath)).digest("hex");
    }
  }
  return result;
};

const sameTree = (left, right) => JSON.stringify(left) === JSON.stringify(right);

const writeReport = async (name, report) => {
  await mkdir(artifactDir, { recursive: true });
  await writeFile(path.join(artifactDir, name), `${JSON.stringify(report, null, 2)}\n`, "utf8");
};

const packageVersion = async (packageJsonPath) => JSON.parse(await readFile(packageJsonPath, "utf8")).version;

const resolvedZvec = async (installDir) => {
  const requireFromInstall = createRequire(path.join(installDir, "package.json"));
  const packageJsonPath = requireFromInstall.resolve("@zvec/zvec/package.json");
  const entryPath = requireFromInstall.resolve("@zvec/zvec");
  const manifest = JSON.parse(await readFile(packageJsonPath, "utf8"));
  return { packageJsonPath, entryPath, version: manifest.version };
};

const createLegacyFixture = async () => {
  const report = {
    mode,
    startedAt: new Date().toISOString(),
    environment: { platform: process.platform, arch: process.arch, node: process.version },
    baseline: { ragit: baselineVersion, zvec: "0.2.1" },
    commands: [],
  };
  const installDir = await mkdtemp(path.join(os.tmpdir(), "ragit-zvec-legacy-install-"));
  const repositoryDir = path.join(artifactDir, "legacy-repository");
  try {
    await rm(repositoryDir, { recursive: true, force: true });
    await mkdir(artifactDir, { recursive: true });
    runNpm(["install", "--prefix", installDir, "--no-audit", "--no-fund", `ragit@${baselineVersion}`]);
    const zvec = await resolvedZvec(installDir);
    assert(zvec.version === "0.2.1", `baseline must resolve @zvec/zvec@0.2.1, resolved ${zvec.version}`);
    report.baseline.resolved = zvec;

    await mkdir(repositoryDir, { recursive: true });
    git(repositoryDir, ["init", "-b", "main"]);
    git(repositoryDir, ["config", "user.email", "ragit@example.com"]);
    git(repositoryDir, ["config", "user.name", "ragit-zvec-validation"]);
    const ragit = { file: process.execPath, argsPrefix: [path.join(installDir, "node_modules", "ragit", "dist", "cli.js")] };
    const init = parseJson(runInstalled(ragit, ["init", "--yes", "--output", "json"], { cwd: repositoryDir }), "baseline init");
    assert(init.ok === true, "baseline init envelope must succeed");
    const document = path.join(repositoryDir, "docs", "legacy-zvec-fixture.plan.md");
    await mkdir(path.dirname(document), { recursive: true });
    await writeFile(document, "---\ntype: plan\n---\n# Legacy zvec fixture\nRAGit 2.0.0 store data must reopen with the candidate.\n", "utf8");
    git(repositoryDir, ["add", "-A"]);
    git(repositoryDir, ["commit", "-m", "create legacy zvec fixture"]);
    const head = git(repositoryDir, ["rev-parse", "HEAD"]).toLowerCase();
    const ingest = parseJson(runInstalled(ragit, ["ingest", "--all", "--format", "json"], { cwd: repositoryDir }), "baseline ingest");
    assert(ingest.data?.commitSha === head, "baseline ingest must bind to the committed fixture");
    const query = parseJson(runInstalled(ragit, ["query", "legacy zvec fixture", "--format", "json"], { cwd: repositoryDir }), "baseline query");
    assert(query.data?.hits?.length > 0, "baseline fixture must be queryable");
    const storeTree = await treeHash(path.join(repositoryDir, ".ragit", "store"));
    report.fixture = { repositoryDir: "legacy-repository", head, queryHitIds: query.data.hits.map((hit) => hit.citation?.id), storeTree };
    report.finishedAt = new Date().toISOString();
    await writeReport("legacy-fixture-report.json", report);
  } finally {
    await rm(installDir, { recursive: true, force: true });
  }
};

const createValidationCandidate = async (workDir, report) => {
  const stageDir = path.join(workDir, "candidate-stage");
  const installDir = path.join(workDir, "candidate-install");
  await mkdir(stageDir, { recursive: true });
  await cp(path.join(rootDir, "dist"), path.join(stageDir, "dist"), { recursive: true });
  for (const file of ["README.md", "LICENSE"]) await cp(path.join(rootDir, file), path.join(stageDir, file));
  const manifest = JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8"));
  manifest.optionalDependencies["@zvec/zvec"] = candidateVersion;
  await writeFile(path.join(stageDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const runtimeDir = path.join(stageDir, "dist");
  const runtimeFile = (await readdir(runtimeDir)).find((file) => /^runtime-.*\.js$/.test(file));
  assert(runtimeFile, "packed candidate runtime chunk was not found");
  const runtimePath = path.join(runtimeDir, runtimeFile);
  const originalRuntime = await readFile(runtimePath, "utf8");
  const patchedRuntime = originalRuntime.replace(
    '["darwin/arm64", "linux/arm64"]',
    '["darwin/arm64", "linux/arm64", "win32/x64"]',
  );
  assert(patchedRuntime !== originalRuntime, "validation candidate did not patch the packed target list");
  await writeFile(runtimePath, patchedRuntime, "utf8");
  const packed = JSON.parse(runNpm(["pack", "--json"], { cwd: stageDir }));
  const tarball = path.join(stageDir, packed[0].filename);
  runNpm(["install", "--prefix", installDir, "--no-audit", "--no-fund", tarball]);
  const zvec = await resolvedZvec(installDir);
  assert(zvec.version === candidateVersion, `packed candidate must resolve @zvec/zvec@${candidateVersion}, resolved ${zvec.version}`);
  report.validationCandidate = {
    tarball: path.basename(tarball),
    ragitVersion: await packageVersion(path.join(installDir, "node_modules", "ragit", "package.json")),
    zvec,
    deliberateTemporaryChanges: [
      "package.json optionalDependencies.@zvec/zvec: 0.2.1 -> 0.5.0",
      "packed runtime target list: add win32/x64",
    ],
  };
  return {
    installDir,
    ragit: { file: process.execPath, argsPrefix: [path.join(installDir, "node_modules", "ragit", "dist", "cli.js")] },
    mcp: { file: process.execPath, argsPrefix: [path.join(installDir, "node_modules", "ragit", "dist", "mcp.js")] },
  };
};

const runMcp = async (mcp, repositoryDir) => {
  const transport = new StdioClientTransport({ command: mcp.file, args: [...mcp.argsPrefix, "--cwd", repositoryDir], cwd: repositoryDir, stderr: "pipe" });
  const stderr = [];
  transport.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
  const client = new Client({ name: "ragit-zvec-validation", version: "1.0.0" });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    assert(JSON.stringify(names) === JSON.stringify(["ragit_status", "ragit_query", "ragit_context_pack"]), `unexpected MCP tools: ${names.join(", ")}`);
    const status = await client.callTool({ name: "ragit_status", arguments: {} });
    const query = await client.callTool({ name: "ragit_query", arguments: { question: "legacy zvec fixture", topK: 3 } });
    const context = await client.callTool({ name: "ragit_context_pack", arguments: { goal: "legacy zvec fixture", budget: 160 } });
    for (const [name, value] of Object.entries({ status, query, context })) {
      assert(!value.isError && value.structuredContent?.ok === true, `MCP ${name} failed: ${JSON.stringify(value)}`);
    }
    return { tools: names, stderr: stderr.join("") };
  } finally {
    await client.close().catch(() => undefined);
  }
};

const runCandidateFlow = async (ragit, mcp, repositoryDir) => {
  await mkdir(repositoryDir, { recursive: true });
  git(repositoryDir, ["init", "-b", "main"]);
  git(repositoryDir, ["config", "user.email", "ragit@example.com"]);
  git(repositoryDir, ["config", "user.name", "ragit-zvec-validation"]);
  const init = parseJson(runInstalled(ragit, ["init", "--yes", "--output", "json"], { cwd: repositoryDir }), "candidate init");
  assert(init.ok === true, "candidate init envelope must succeed");
  const document = path.join(repositoryDir, "docs", "candidate-windows-smoke.plan.md");
  await mkdir(path.dirname(document), { recursive: true });
  await writeFile(document, "---\ntype: plan\n---\n# Windows candidate smoke\nThe packed candidate must resolve zvec 0.5.0.\n", "utf8");
  git(repositoryDir, ["add", "-A"]);
  git(repositoryDir, ["commit", "-m", "create Windows candidate smoke fixture"]);
  const head = git(repositoryDir, ["rev-parse", "HEAD"]).toLowerCase();
  const ingest = parseJson(runInstalled(ragit, ["ingest", "--all", "--format", "json"], { cwd: repositoryDir }), "candidate ingest");
  assert(ingest.data?.commitSha === head, "candidate ingest must bind to HEAD");
  const storeBeforeReads = await treeHash(path.join(repositoryDir, ".ragit", "store"));
  const query = parseJson(runInstalled(ragit, ["query", "Windows candidate smoke", "--format", "json"], { cwd: repositoryDir }), "candidate query");
  const context = parseJson(runInstalled(ragit, ["context", "pack", "Windows candidate smoke", "--budget", "160", "--format", "json"], { cwd: repositoryDir }), "candidate context");
  const status = parseJson(runInstalled(ragit, ["status", "--format", "json"], { cwd: repositoryDir }), "candidate status");
  assert(query.data?.hits?.length > 0, "candidate query must return an ingested hit");
  assert(context.data?.selectedHits > 0, "candidate context pack must select an ingested hit");
  assert(status.data?.zvec?.searchReady === true, "candidate status must report zvec search ready");
  const mcpResult = await runMcp(mcp, repositoryDir);
  assert(mcpResult.stderr === "", `candidate MCP stderr: ${mcpResult.stderr}`);
  const storeAfterReads = await treeHash(path.join(repositoryDir, ".ragit", "store"));
  assert(sameTree(storeBeforeReads, storeAfterReads), "candidate read-only CLI/MCP paths changed the canonical store tree");
  return { head, queryHitIds: query.data.hits.map((hit) => hit.citation?.id), mcp: mcpResult, storeTree: storeAfterReads };
};

const validateWindows = async () => {
  const report = {
    mode,
    startedAt: new Date().toISOString(),
    environment: { platform: process.platform, arch: process.arch, node: process.version, cwd: rootDir },
    checks: [],
    notTested: [],
  };
  const record = async (name, fn, critical = true) => {
    try {
      const detail = await fn();
      report.checks.push({ name, status: "PASS", critical, detail });
      return detail;
    } catch (error) {
      report.checks.push({ name, status: "FAIL", critical, error: error instanceof Error ? error.stack ?? error.message : String(error) });
      return undefined;
    }
  };
  const workDir = await mkdtemp(path.join(os.tmpdir(), "ragit-zvec-validation-"));
  try {
    assert(process.platform === "win32" && process.arch === "x64", `Windows x64 validation requires win32/x64, received ${process.platform}/${process.arch}`);
    const fixtureSource = path.resolve(process.env.LEGACY_FIXTURE_DIR ?? "");
    await access(path.join(fixtureSource, ".ragit", "store"));
    const candidate = await createValidationCandidate(workDir, report);

    await record("clean native CJS and ESM import", async () => {
      const zvec = await resolvedZvec(candidate.installDir);
      const requireFromInstall = createRequire(path.join(candidate.installDir, "package.json"));
      requireFromInstall("@zvec/zvec");
      await import(pathToFileURL(zvec.entryPath).href);
      return zvec;
    });

    const unicodeRoot = path.join(os.tmpdir(), "RAGit zvec 검증 with spaces", "long-path-".repeat(12));
    await rm(unicodeRoot, { recursive: true, force: true });
    const freshRepository = path.join(unicodeRoot, "fresh repository");
    const fresh = await record("packed candidate CLI/MCP init ingest query context status and canonical-store hashes", () =>
      runCandidateFlow(candidate.ragit, candidate.mcp, freshRepository));

    const legacyRepository = path.join(unicodeRoot, "legacy 2.0.0 store");
    await cp(fixtureSource, legacyRepository, { recursive: true });
    const legacyBefore = await treeHash(path.join(legacyRepository, ".ragit", "store"));
    await record("legacy RAGit 2.0.0 zvec 0.2.1 store reopen schema data query context status", async () => {
      const status = parseJson(runInstalled(candidate.ragit, ["status", "--format", "json"], { cwd: legacyRepository }), "legacy status");
      const query = parseJson(runInstalled(candidate.ragit, ["query", "legacy zvec fixture", "--format", "json"], { cwd: legacyRepository }), "legacy query");
      const context = parseJson(runInstalled(candidate.ragit, ["context", "pack", "legacy zvec fixture", "--budget", "160", "--format", "json"], { cwd: legacyRepository }), "legacy context");
      assert(status.data?.zvec?.searchReady === true, "legacy status must report search ready");
      assert(query.data?.hits?.length > 0, "legacy candidate query must return a hit");
      assert(context.data?.selectedHits > 0, "legacy candidate context must select a hit");
      return { meta: JSON.parse(await readFile(path.join(legacyRepository, ".ragit", "store", "meta.json"), "utf8")), queryHitIds: query.data.hits.map((hit) => hit.citation?.id) };
    });
    await record("legacy canonical store tree preserved after CLI read paths", async () => {
      const after = await treeHash(path.join(legacyRepository, ".ragit", "store"));
      assert(sameTree(legacyBefore, after), "legacy canonical store bytes changed after candidate status/query/context");
      return { before: legacyBefore, after };
    });
    await record("legacy canonical store tree preserved after MCP read paths", async () => {
      const before = await treeHash(path.join(legacyRepository, ".ragit", "store"));
      const mcpResult = await runMcp(candidate.mcp, legacyRepository);
      assert(mcpResult.stderr === "", `legacy MCP stderr: ${mcpResult.stderr}`);
      const after = await treeHash(path.join(legacyRepository, ".ragit", "store"));
      assert(sameTree(before, after), "legacy canonical store bytes changed after candidate MCP reads");
      return { mcp: mcpResult, before, after };
    });

    await record("close then rename and delete store copy", async () => {
      const handleRepository = path.join(unicodeRoot, "handle cleanup");
      await cp(fixtureSource, handleRepository, { recursive: true });
      parseJson(runInstalled(candidate.ragit, ["status", "--format", "json"], { cwd: handleRepository }), "handle status");
      const store = path.join(handleRepository, ".ragit", "store");
      const moved = path.join(handleRepository, ".ragit", "store-moved");
      await rename(store, moved);
      await rm(moved, { recursive: true });
      return { renamedAndDeleted: true };
    });

    await record("active writer excludes a second writer while readers remain available", async () => {
      const runtimeDir = path.join(legacyRepository, ".ragit", "runtime");
      const lockPath = path.join(runtimeDir, "store-write.lock");
      await mkdir(runtimeDir, { recursive: true });
      await writeFile(lockPath, `${JSON.stringify({ schemaVersion: 1, token: "validation-active-lock", pid: process.pid, hostname: os.hostname(), startedAt: new Date().toISOString(), command: "ingest" })}\n`, "utf8");
      try {
        const reader = parseJson(runInstalled(candidate.ragit, ["query", "legacy zvec fixture", "--format", "json"], { cwd: legacyRepository }), "reader while writer locked");
        assert(reader.data?.hits?.length > 0, "reader must remain available while writer lock is active");
        const writer = commandInstalled(candidate.ragit, ["ingest", "--all", "--format", "json"], { cwd: legacyRepository });
        assert(writer.status !== 0, "second writer must be excluded by active lock");
        const envelope = parseJson(writer.stdout, "writer exclusion");
        assert(envelope.error?.code === "STORE_WRITE_BUSY", `expected STORE_WRITE_BUSY, got ${envelope.error?.code}`);
        return { writerStatus: writer.status, writerCode: envelope.error.code };
      } finally {
        await rm(lockPath, { force: true });
      }
    });

    await record("deterministic rebuild from manifests on disposable legacy copy", async () => {
      const rebuildRepository = path.join(unicodeRoot, "deterministic rebuild");
      await cp(fixtureSource, rebuildRepository, { recursive: true });
      await rm(path.join(rebuildRepository, ".ragit", "store"), { recursive: true, force: true });
      const repair = parseJson(runInstalled(candidate.ragit, ["repair", "--apply", "--action", "store-rebuild", "--format", "json"], { cwd: rebuildRepository }), "store rebuild");
      assert(repair.data?.executedActions?.some((action) => action.action === "store-rebuild"), "store rebuild was not executed");
      const query = parseJson(runInstalled(candidate.ragit, ["query", "legacy zvec fixture", "--format", "json"], { cwd: rebuildRepository }), "rebuilt query");
      assert(query.data?.hits?.length > 0, "deterministically rebuilt store must be queryable");
      return { executedActions: repair.data.executedActions, queryHitIds: query.data.hits.map((hit) => hit.citation?.id) };
    });

    const crossDriveRoot = process.env.VALIDATION_CROSS_DRIVE_ROOT;
    if (crossDriveRoot) {
      await record("cross-drive legacy reopen and query", async () => {
        const crossRepository = path.join(crossDriveRoot, "RAGit zvec cross drive 한글", "legacy store");
        await rm(crossRepository, { recursive: true, force: true });
        await cp(fixtureSource, crossRepository, { recursive: true });
        const before = await treeHash(path.join(crossRepository, ".ragit", "store"));
        const query = parseJson(runInstalled(candidate.ragit, ["query", "legacy zvec fixture", "--format", "json"], { cwd: crossRepository }), "cross-drive query");
        const after = await treeHash(path.join(crossRepository, ".ragit", "store"));
        assert(query.data?.hits?.length > 0, "cross-drive query must return a hit");
        assert(sameTree(before, after), "cross-drive query changed canonical store bytes");
        return { crossRepository, queryHitIds: query.data.hits.map((hit) => hit.citation?.id) };
      });
    } else {
      report.notTested.push("C:/D: cross-drive: hosted runner exposed no second filesystem drive");
    }
    if (!fresh) report.notTested.push("Fresh candidate flow dependent checks were not used because its flow failed.");
  } catch (error) {
    report.checks.push({ name: "harness setup", status: "FAIL", critical: true, error: error instanceof Error ? error.stack ?? error.message : String(error) });
  } finally {
    report.finishedAt = new Date().toISOString();
    await writeReport("windows-validation-report.json", report);
    await rm(workDir, { recursive: true, force: true });
  }
  const failures = report.checks.filter((check) => check.status === "FAIL" && check.critical);
  if (failures.length > 0) {
    throw new Error(`zvec Windows validation recorded ${failures.length} critical failure(s); see ${path.join(artifactDir, "windows-validation-report.json")}`);
  }
};

if (mode === "create-legacy") {
  await createLegacyFixture();
} else if (mode === "validate-windows") {
  await validateWindows();
} else {
  throw new Error("usage: node scripts/zvec-windows-validation.mjs <create-legacy|validate-windows>");
}
