import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { runMemoryWrap } from "../src/core/memory.js";
import { runIngest } from "../src/core/ingest.js";

const REPO_ROOT = process.cwd();

const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const runCli = (args: string[]): string =>
  execFileSync("pnpm", ["exec", "tsx", "src/cli.ts", ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }).trim();

describe("CLI machine contract", () => {
  it(
    "emits JSON envelopes for describe, query, context pack, memory recall, and status",
    async () => {
      const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-cli-contract-"));
      git(temp, ["init"]);
      git(temp, ["config", "user.email", "ragit@example.com"]);
      git(temp, ["config", "user.name", "ragit-test"]);

      await mkdir(path.join(temp, "docs"), { recursive: true });
      await writeFile(
        path.join(temp, "docs", "auth.adr.md"),
        `---
type: adr
---
# Auth Boundaries
Keep refresh token mutation outside snapshot-bound retrieval.`,
        "utf8",
      );
      await writeFile(
        path.join(temp, "docs", "memory.plan.md"),
        `---
type: plan
---
# Memory Plan
Recall packets should restore active work instead of replaying raw logs.`,
        "utf8",
      );
      git(temp, ["add", "."]);
      git(temp, ["commit", "-m", "seed docs"]);

      await runInit(temp, { nonInteractive: true });
      await runIngest(temp, { all: true });
      await runMemoryWrap(temp, {
        goal: "resume auth flow",
        summary: "Need to resume auth work with current constraints.",
        constraints: ["keep snapshot contracts intact"],
        decisions: [
          {
            id: "decision-1",
            title: "Use recall packets",
            summary: "Restore active work instead of replaying raw logs.",
          },
        ],
        openLoops: [
          {
            id: "loop-1",
            title: "Finalize refresh-token boundary",
            status: "open",
            nextAction: "Review auth ADR and patch docs",
          },
        ],
        nextActions: ["Run recall before coding"],
        promotionCandidates: [],
      });

      await writeFile(path.join(temp, "query.json"), JSON.stringify({ question: "restore active work", topK: 2 }, null, 2), "utf8");
      await writeFile(path.join(temp, "context-pack.json"), JSON.stringify({ goal: "resume auth flow", budget: 80 }, null, 2), "utf8");

      const describeOutput = JSON.parse(runCli(["describe", "query", "--format", "json"]));
      expect(describeOutput.command).toBe("describe");
      expect(describeOutput.ok).toBe(true);
      expect(describeOutput.data.spec.path).toBe("query");
      expect(describeOutput.data.spec.supportsRawJsonInput).toBe(true);

      const queryOutput = JSON.parse(runCli(["query", "--input", "query.json", "--cwd", temp, "--format", "json", "--view", "minimal"]));
      expect(queryOutput.command).toBe("query");
      expect(queryOutput.ok).toBe(true);
      expect(queryOutput.version).toBeTruthy();
      expect(queryOutput.cwd).toBe(temp);
      expect(queryOutput.data.hits[0].excerpt).toBeTruthy();
      expect(queryOutput.data.hits[0].text).toBeUndefined();

      const contextOutput = JSON.parse(
        runCli(["context", "pack", "--input", "context-pack.json", "--cwd", temp, "--format", "json", "--view", "minimal"]),
      );
      expect(contextOutput.command).toBe("context pack");
      expect(contextOutput.ok).toBe(true);
      expect(contextOutput.data.goal).toBe("resume auth flow");
      expect(contextOutput.data.selectedHits).toBeGreaterThan(0);

      const recallOutput = JSON.parse(
        runCli(["memory", "recall", "resume auth flow", "--cwd", temp, "--format", "json", "--view", "minimal"]),
      );
      expect(recallOutput.command).toBe("memory recall");
      expect(recallOutput.ok).toBe(true);
      expect(recallOutput.data.openLoops[0].title).toContain("refresh-token");
      expect(recallOutput.data.retrievedHits[0].excerpt).toBeTruthy();

      const statusOutput = JSON.parse(runCli(["status", "--cwd", temp, "--format", "json"]));
      expect(statusOutput.command).toBe("status");
      expect(statusOutput.ok).toBe(true);
      expect(statusOutput.data.zvec.searchReady).toBe(true);
    },
    20_000,
  );
});

