import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { resolveSnapshotRef, writeSnapshotManifest } from "../src/core/manifest.js";
import { buildSnapshotManifest } from "../src/core/manifest.js";

const REPO_ROOT = process.cwd();

const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const runCli = (args: string[]): string =>
  execFileSync("pnpm", ["exec", "tsx", "src/cli.ts", ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }).trim();

const runCliExpectError = (args: string[]): string => {
  try {
    runCli(args);
    throw new Error("expected command to fail");
  } catch (error) {
    const stderr = error instanceof Error && "stderr" in error ? String((error as { stderr?: string }).stderr ?? "") : "";
    const stdout = error instanceof Error && "stdout" in error ? String((error as { stdout?: string }).stdout ?? "") : "";
    return `${stdout}\n${stderr}`;
  }
};

describe("CLI hardening and dry-run", () => {
  it(
    "keeps mutating commands side-effect free in dry-run mode",
    async () => {
      const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-cli-dry-run-"));
      git(temp, ["init"]);
      git(temp, ["config", "user.email", "ragit@example.com"]);
      git(temp, ["config", "user.name", "ragit-test"]);
      await writeFile(path.join(temp, "README.md"), "# temp\n", "utf8");
      await mkdir(path.join(temp, "docs"), { recursive: true });
      await writeFile(
        path.join(temp, "docs", "memory.plan.md"),
        `---
type: plan
---
# Memory
Dry-run should not mutate tracked state.`,
        "utf8",
      );
      git(temp, ["add", "."]);
      git(temp, ["commit", "-m", "init"]);
      await runInit(temp, { nonInteractive: true });

      await writeFile(
        path.join(temp, "wrap.json"),
        JSON.stringify(
          {
            goal: "stabilize dry-run",
            summary: "Preview wrap output before writing files.",
            constraints: ["do not mutate state in dry-run"],
            decisions: [],
            openLoops: [],
            nextActions: ["Verify dry-run output"],
            promotionCandidates: [],
          },
          null,
          2,
        ),
        "utf8",
      );
      await writeFile(
        path.join(temp, "promote.json"),
        JSON.stringify(
          {
            sourceSessionId: "session-preview",
            promotionCandidates: [
              {
                kind: "decision",
                title: "preview promotion",
                summary: "Dry-run should list target files without writing them.",
              },
            ],
          },
          null,
          2,
        ),
        "utf8",
      );
      await writeFile(path.join(temp, "ingest.json"), JSON.stringify({ all: true }, null, 2), "utf8");

      const wrapOutput = JSON.parse(runCli(["memory", "wrap", "--input", "wrap.json", "--dry-run", "--format", "json", "--cwd", temp]));
      expect(wrapOutput.data.dryRun).toBe(true);

      const promoteOutput = JSON.parse(runCli(["memory", "promote", "--input", "promote.json", "--dry-run", "--format", "json", "--cwd", temp]));
      expect(promoteOutput.data.dryRun).toBe(true);
      expect(promoteOutput.data.createdFiles).toHaveLength(0);
      expect(promoteOutput.data.plannedFiles[0]).toMatch(/^docs\/memory\/decisions\//);

      const ingestOutput = JSON.parse(runCli(["ingest", "--input", "ingest.json", "--dry-run", "--format", "json", "--cwd", temp]));
      expect(ingestOutput.data.mode).toBe("dry-run");
      expect(ingestOutput.data.plannedFiles).toContain("docs/memory.plan.md");

      const hooksOutput = JSON.parse(runCli(["hooks", "install", "--dry-run", "--format", "json", "--cwd", temp]));
      expect(hooksOutput.data.dryRun).toBe(true);

      expect((await readdir(path.join(temp, ".ragit", "manifest"))).filter((name) => name.endsWith(".json"))).toHaveLength(0);
      expect((await readdir(path.join(temp, ".ragit", "memory", "working"))).filter((name) => name.endsWith(".json"))).toHaveLength(0);
      expect((await readdir(path.join(temp, "docs"))).some((name) => name === "memory")).toBe(false);
      const hooksStatus = JSON.parse(runCli(["hooks", "status", "--cwd", temp, "--format", "json"]));
      expect(hooksStatus.ok).toBe(true);
    },
    20_000,
  );

  it("rejects unsafe input paths, control characters, invalid globs, and unexpected memory fields", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-cli-input-"));
    git(temp, ["init"]);
    git(temp, ["config", "user.email", "ragit@example.com"]);
    git(temp, ["config", "user.name", "ragit-test"]);
    await writeFile(path.join(temp, "README.md"), "# temp\n", "utf8");
    git(temp, ["add", "."]);
    git(temp, ["commit", "-m", "init"]);
    await runInit(temp, { nonInteractive: true });

    const outside = path.join(os.tmpdir(), `ragit-outside-${Date.now()}.json`);
    await writeFile(outside, JSON.stringify({ question: "outside" }, null, 2), "utf8");
    await writeFile(path.join(temp, "bad-query.json"), JSON.stringify({ question: "hello\u0007" }, null, 2), "utf8");
    await writeFile(path.join(temp, "bad-ingest.json"), JSON.stringify({ files: "../**/*.md" }, null, 2), "utf8");
    await writeFile(
      path.join(temp, "bad-wrap.json"),
      JSON.stringify(
        {
          goal: "bad wrap",
          summary: "unexpected field should fail",
          constraints: [],
          decisions: [],
          openLoops: [],
          nextActions: [],
          promotionCandidates: [],
          unexpected: true,
        },
        null,
        2,
      ),
      "utf8",
    );

    expect(runCliExpectError(["query", "--input", outside, "--cwd", temp, "--format", "json"])).toContain("repo 밖 input 경로");
    expect(runCliExpectError(["query", "--input", "bad-query.json", "--cwd", temp, "--format", "json"])).toContain("control character");
    expect(runCliExpectError(["ingest", "--input", "bad-ingest.json", "--cwd", temp, "--format", "json"])).toContain("repo 내부 glob");
    expect(runCliExpectError(["memory", "wrap", "--input", "bad-wrap.json", "--cwd", temp, "--format", "json"])).toContain("예상하지 못한 필드");
  });

  it("detects ambiguous snapshot prefixes", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-ambiguous-sha-"));
    await mkdir(path.join(temp, ".ragit", "manifest"), { recursive: true });
    const manifest = buildSnapshotManifest("abc111", null, [], []);
    await writeSnapshotManifest(temp, manifest);
    await writeSnapshotManifest(temp, { ...manifest, commitSha: "abc222" });

    await expect(resolveSnapshotRef(temp, "abc")).rejects.toThrow("모호");
  });
});
