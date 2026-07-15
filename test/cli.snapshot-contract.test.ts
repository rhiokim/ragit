import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCliFailureEnvelope,
  resolveCliFailureContext,
} from "../src/core/cliContract.js";
import { RagitOperationalError } from "../src/core/errors.js";
import { acquireStoreWriteLock } from "../src/core/store-write-lock.js";

const REPO_ROOT = process.cwd();
const cleanupPaths: string[] = [];

interface CliRunResult {
  status: number;
  stdout: string;
  stderr: string;
}

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const createRepository = async (prefix: string): Promise<{ cwd: string; headSha: string }> => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanupPaths.push(cwd);
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.email", "ragit@example.com"]);
  git(cwd, ["config", "user.name", "ragit-test"]);
  await mkdir(path.join(cwd, "docs"), { recursive: true });
  await writeFile(
    path.join(cwd, "docs", "snapshot.plan.md"),
    "---\ntype: plan\n---\n# Snapshot plan\nKeep snapshot selection deterministic.\n",
    "utf8",
  );
  git(cwd, ["add", "."]);
  git(cwd, ["commit", "-m", "seed docs"]);
  return {
    cwd: git(cwd, ["rev-parse", "--show-toplevel"]),
    headSha: git(cwd, ["rev-parse", "HEAD"]),
  };
};

const runCli = (args: string[]): CliRunResult => {
  const result = spawnSync("pnpm", ["exec", "tsx", "src/cli-entry.ts", ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? -1,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
};

const parseEnvelope = (output: CliRunResult): Record<string, any> =>
  JSON.parse(output.stdout) as Record<string, any>;

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

describe("CLI snapshot failure contract", () => {
  it("keeps status recovery fields additive in JSON and text output", async () => {
    const { cwd, headSha } = await createRepository("ragit-cli-status-recovery-");

    const json = runCli(["status", "--cwd", cwd, "--format", "json"]);
    expect(json.status).toBe(0);
    expect(parseEnvelope(json).data).toMatchObject({
      storeWriter: { state: expect.any(String), owner: null },
      ingestRecovery: {
        summary: { finalizationPending: 0 },
        pending: [],
        lastCompleted: null,
      },
    });

    const lock = await acquireStoreWriteLock(cwd, { command: "ingest", headSha });
    try {
      const text = runCli(["status", "--cwd", cwd, "--format", "text"]);
      expect(text.status).toBe(0);
      expect(text.stdout).toContain("store_writer_lock: active");
      expect(text.stdout).toContain(`pid=${lock.owner.pid}`);
      expect(text.stdout).toContain(`command=${lock.owner.command}`);
      expect(text.stdout).toContain(`head_sha=${headSha}`);
      expect(text.stdout).not.toContain(lock.owner.token);
      expect(text.stdout).toContain("ingest_recovery_pending:");
    } finally {
      await lock.release();
    }

    const repairHelp = runCli(["repair", "--help"]);
    expect(repairHelp.status).toBe(0);
    expect(repairHelp.stdout).toContain("ingest-recover");
    expect(repairHelp.stdout).toContain("store-rebuild");
  }, 20_000);

  it("emits invalid snapshot refs with exit 2 in JSON and text modes", async () => {
    const { cwd } = await createRepository("ragit-cli-invalid-ref-");

    const json = runCli(["query", "snapshot", "--at", "not-a-sha", "--cwd", cwd, "--format=json"]);
    expect(json.status).toBe(2);
    expect(json.stderr).toBe("");
    expect(parseEnvelope(json)).toMatchObject({
      command: "query",
      ok: false,
      cwd,
      data: null,
      warnings: [],
      error: {
        code: "SNAPSHOT_REF_INVALID",
        category: "invalid_input",
        retryable: false,
      },
    });

    const text = runCli(["query", "snapshot", "--format", "text", "--cwd", cwd, "--at", "not-a-sha"]);
    expect(text.status).toBe(2);
    expect(text.stdout).toBe("");
    expect(text.stderr).toContain("SNAPSHOT_REF_INVALID");
    expect(text.stderr).toContain("retryable: false");
    expect(text.stderr).toContain("recovery:");
  }, 20_000);

  it("keeps missing snapshot JSON, text, both, and invalid-format failures in parity", async () => {
    const { cwd, headSha } = await createRepository("ragit-cli-missing-snapshot-");

    const json = runCli(["query", "snapshot", "--format=json", "--cwd", cwd]);
    expect(json.status).toBe(3);
    expect(json.stderr).toBe("");
    const jsonEnvelope = parseEnvelope(json);
    expect(jsonEnvelope).toMatchObject({
      command: "query",
      ok: false,
      cwd,
      data: null,
      warnings: [],
      error: {
        code: "SNAPSHOT_NOT_INDEXED",
        category: "not_ready",
        retryable: false,
        details: { resolvedSha: headSha },
        recovery: { command: "ragit ingest --all" },
      },
    });

    const text = runCli(["query", "snapshot", "--cwd", cwd, "--format", "text"]);
    expect(text.status).toBe(3);
    expect(text.stdout).toBe("");
    expect(text.stderr).toContain("SNAPSHOT_NOT_INDEXED");
    expect(text.stderr).toContain("ragit ingest --all");

    const both = runCli(["query", "snapshot", "--cwd", cwd]);
    expect(both.status).toBe(3);
    expect(parseEnvelope(both).error).toEqual(jsonEnvelope.error);
    expect(both.stderr).toContain("SNAPSHOT_NOT_INDEXED");

    const invalidFormat = runCli(["query", "snapshot", "--format", "yaml", "--cwd", cwd]);
    expect(invalidFormat.status).toBe(3);
    expect(parseEnvelope(invalidFormat).error).toEqual(jsonEnvelope.error);
    expect(invalidFormat.stderr).toContain("SNAPSHOT_NOT_INDEXED");

    const optionLikeQuestion = runCli(["query", "--cwd", cwd, "--", "--format=json"]);
    expect(optionLikeQuestion.status).toBe(3);
    expect(parseEnvelope(optionLikeQuestion).error).toEqual(jsonEnvelope.error);
    expect(optionLikeQuestion.stderr).toContain("SNAPSHOT_NOT_INDEXED");
  }, 25_000);

  it("emits corrupt and future manifests with exit 4", async () => {
    const { cwd, headSha } = await createRepository("ragit-cli-corrupt-snapshot-");
    const manifestPath = path.join(cwd, ".ragit", "manifest", `${headSha}.json`);
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, '{"commitSha":', "utf8");

    const corrupt = runCli(["query", "snapshot", "--cwd", cwd, "--format", "json"]);
    expect(corrupt.status).toBe(4);
    expect(corrupt.stderr).toBe("");
    expect(parseEnvelope(corrupt).error.code).toBe("SNAPSHOT_MANIFEST_INVALID");

    await writeFile(
      manifestPath,
      `${JSON.stringify({
        commitSha: headSha,
        parentSha: null,
        createdAt: "2026-07-15T00:00:00.000Z",
        indexVersion: 999,
      })}\n`,
      "utf8",
    );
    const future = runCli(["query", "snapshot", "--format=text", "--cwd", cwd]);
    expect(future.status).toBe(4);
    expect(future.stdout).toBe("");
    expect(future.stderr).toContain("SNAPSHOT_SCHEMA_UNSUPPORTED");
  }, 20_000);

  it("uses ingest's JSON default and preserves text mode for dirty candidates", async () => {
    const { cwd } = await createRepository("ragit-cli-dirty-ingest-");
    await writeFile(
      path.join(cwd, "docs", "snapshot.plan.md"),
      "---\ntype: plan\n---\n# Snapshot plan\nThis tracked candidate is dirty.\n",
      "utf8",
    );

    const json = runCli(["ingest", `--cwd=${cwd}`, "--all"]);
    expect(json.status).toBe(3);
    expect(json.stderr).toBe("");
    expect(parseEnvelope(json)).toMatchObject({
      command: "ingest",
      ok: false,
      cwd,
      data: null,
      error: {
        code: "INGEST_CANDIDATES_DIRTY",
        category: "not_ready",
        retryable: false,
        details: { dirtyCandidates: ["docs/snapshot.plan.md"] },
        recovery: { command: "git status --short" },
      },
    });

    const text = runCli(["ingest", "--all", "--format=text", "--cwd", cwd]);
    expect(text.status).toBe(3);
    expect(text.stdout).toBe("");
    expect(text.stderr).toContain("INGEST_CANDIDATES_DIRTY");
    expect(text.stderr).toContain("docs/snapshot.plan.md");
  }, 20_000);

  it("projects a live store writer lock through ingest's JSON failure contract", async () => {
    const { cwd } = await createRepository("ragit-cli-store-write-lock-");
    const lock = await acquireStoreWriteLock(cwd, { command: "migrate-embeddings" });
    try {
      const result = runCli(["ingest", "--all", `--cwd=${cwd}`]);
      expect(result.status).toBe(3);
      expect(result.stderr).toBe("");
      expect(parseEnvelope(result)).toMatchObject({
        command: "ingest",
        ok: false,
        cwd,
        data: null,
        error: {
          code: "STORE_WRITE_BUSY",
          category: "transient",
          retryable: true,
          details: { lockState: "active", owner: { token: lock.owner.token } },
        },
      });
    } finally {
      await lock.release();
    }
  }, 20_000);

  it("resolves command, cwd, and safe format defaults regardless of option position", async () => {
    const { cwd } = await createRepository("ragit-cli-failure-context-");
    const nested = path.join(cwd, "packages", "app");
    await mkdir(nested, { recursive: true });
    const outside = await mkdtemp(path.join(os.tmpdir(), "ragit-cli-outside-"));
    cleanupPaths.push(outside);
    await expect(resolveCliFailureContext(["--format=json", "query", "goal", "--cwd", nested])).resolves.toEqual({
      command: "query",
      cwd,
      format: "json",
    });
    await expect(resolveCliFailureContext(["context", `--cwd=${nested}`, "pack", "goal"])).resolves.toEqual({
      command: "context pack",
      cwd,
      format: "both",
    });
    await expect(resolveCliFailureContext(["memory", "recall", "goal", "--format=bogus", "--cwd", nested])).resolves.toEqual({
      command: "memory recall",
      cwd,
      format: "both",
    });
    await expect(resolveCliFailureContext(["ingest", "--cwd", nested])).resolves.toEqual({
      command: "ingest",
      cwd,
      format: "json",
    });
    await expect(resolveCliFailureContext(["status", `--cwd=${outside}`])).resolves.toEqual({
      command: "status",
      cwd: path.resolve(outside),
      format: "text",
    });
    await expect(resolveCliFailureContext(["query", "--cwd", nested, "--", "--format=json"])).resolves.toEqual({
      command: "query",
      cwd,
      format: "both",
    });
  });

  it("projects repeat-state errors deterministically and leaves unexpected errors unwrapped", async () => {
    const { cwd } = await createRepository("ragit-cli-repeat-state-");
    const error = new RagitOperationalError(
      "REPOSITORY_STATE_CHANGED",
      "repository state changed while reading",
      {
        details: { before: "abc", after: "def" },
        recovery: { command: "ragit query snapshot" },
      },
    );

    const first = buildCliFailureEnvelope("query", cwd, error);
    const second = buildCliFailureEnvelope("query", cwd, error);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      command: "query",
      ok: false,
      cwd,
      data: null,
      warnings: [],
      error: {
        code: "REPOSITORY_STATE_CHANGED",
        retryable: true,
        details: { before: "abc", after: "def" },
      },
    });

    const unexpected = runCli(["query", "--cwd", cwd, "--format", "json"]);
    expect(unexpected.status).toBe(1);
    expect(unexpected.stdout).toBe("");
    expect(unexpected.stderr).toContain("[ragit] 오류: query 질문이 필요합니다.");
    expect(unexpected.stderr).not.toContain('"ok": false');
  }, 15_000);
});
