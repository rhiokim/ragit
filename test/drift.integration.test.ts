import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { reviewArtifacts, sessionMaterialize } from "../src/core/artifacts.js";
import { runDrift } from "../src/core/drift.js";
import { captureHarness, runHarness } from "../src/core/harness.js";
import { runIngest } from "../src/core/ingest.js";
import { runInit } from "../src/commands/init.js";

const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const sha1 = (...parts: string[]): string => createHash("sha1").update(parts.join(":")).digest("hex");
const harnessArtifactId = (kind: string, goal: string, title: string): string => `art_harness_${kind}_${sha1(kind, goal, title).slice(0, 16)}`;

describe("drift integration", () => {
  it(
    "returns suspect baseline when no manifest exists",
    async () => {
      const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-drift-baseline-"));
      git(temp, ["init"]);
      git(temp, ["config", "user.email", "ragit@example.com"]);
      git(temp, ["config", "user.name", "ragit-test"]);
      await writeFile(path.join(temp, "README.md"), "# drift baseline\n", "utf8");
      git(temp, ["add", "."]);
      git(temp, ["commit", "-m", "init"]);

      const result = await runDrift(temp, {});

      expect(result.overallStatus).toBe("suspect");
      expect(result.baseline.reasonCodes).toContain("no_baseline");
      expect(result.items[0]?.itemType).toBe("baseline");
      expect(result.items[0]?.reasonCodes).toContain("no_baseline");
    },
    15_000,
  );

  it(
    "marks durable docs and reviewed memory artifacts stale when related paths changed",
    async () => {
      const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-drift-doc-memory-"));
      git(temp, ["init"]);
      git(temp, ["config", "user.email", "ragit@example.com"]);
      git(temp, ["config", "user.name", "ragit-test"]);
      await mkdir(path.join(temp, "docs"), { recursive: true });
      await writeFile(path.join(temp, "docs", "auth.adr.md"), "---\ntype: adr\n---\n# Auth Memory\n\nrestore active work.\n", "utf8");
      git(temp, ["add", "."]);
      git(temp, ["commit", "-m", "init"]);

      await runInit(temp, { nonInteractive: true });
      git(temp, ["add", "-A"]);
      git(temp, ["commit", "-m", "initialize ragit"]);
      await runIngest(temp, { all: true });

      const materialized = await sessionMaterialize(temp, {
        goal: "resume auth migration",
        relatedPaths: ["docs/auth.adr.md"],
        createdAt: "2026-04-10T09:00:00.000Z",
        turns: [
          {
            turnId: "turn-1",
            role: "user",
            content: "Please keep answers concise.",
            createdAt: "2026-04-10T09:00:00.000Z",
          },
        ],
      });

      await reviewArtifacts(temp, {
        updates: [
          {
            artifactId: materialized.artifactIds[0]!,
            nextStatus: "reviewed",
            reason: "confirmed for drift test",
          },
        ],
      });

      await writeFile(path.join(temp, "docs", "auth.adr.md"), "---\ntype: adr\n---\n# Auth Memory\n\nrestore active work with refreshed packet.\n", "utf8");
      git(temp, ["add", "docs/auth.adr.md"]);
      git(temp, ["commit", "-m", "update auth memory"]);
      const diffBefore = git(temp, ["diff", "--name-only", "HEAD", "--"]);

      const durable = await runDrift(temp, { scope: "durable" });
      const durableDoc = durable.items.find((item) => item.itemType === "document");
      expect(durableDoc?.status).toBe("stale");
      expect(durableDoc?.reasonCodes).toContain("tracked_path_changed");

      const memory = await runDrift(temp, { scope: "memory" });
      const memoryItem = memory.items.find((item) => item.itemType === "memoryArtifact");
      expect(memoryItem?.status).toBe("stale");
      expect(memoryItem?.reasonCodes).toContain("related_path_changed");
      expect(memoryItem?.affectedPaths).toContain("docs/auth.adr.md");
      const diffAfter = git(temp, ["diff", "--name-only", "HEAD", "--"]);
      expect(diffAfter).toBe(diffBefore);
    },
    20_000,
  );

  it(
    "marks reviewed artifacts suspect when bindings are still pending",
    async () => {
      const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-drift-pending-"));
      git(temp, ["init"]);
      git(temp, ["config", "user.email", "ragit@example.com"]);
      git(temp, ["config", "user.name", "ragit-test"]);
      await writeFile(path.join(temp, "README.md"), "# pending drift\n", "utf8");

      const materialized = await sessionMaterialize(temp, {
        goal: "bootstrap without head",
        relatedPaths: ["README.md"],
        createdAt: "2026-04-10T09:10:00.000Z",
        turns: [
          {
            turnId: "turn-1",
            role: "user",
            content: "Please keep this blocker visible.",
            createdAt: "2026-04-10T09:10:00.000Z",
          },
        ],
      });

      await reviewArtifacts(temp, {
        updates: [
          {
            artifactId: materialized.artifactIds[0]!,
            nextStatus: "reviewed",
            reason: "reviewed before first commit",
          },
        ],
      });

      const result = await runDrift(temp, { scope: "memory" });
      const item = result.items.find((entry) => entry.itemType === "memoryArtifact");
      expect(item?.status).toBe("suspect");
      expect(item?.reasonCodes).toContain("missing_binding");
    },
    15_000,
  );

  it(
    "marks harness suites stale when failure evidence exists",
    async () => {
      const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-drift-harness-"));
      git(temp, ["init"]);
      git(temp, ["config", "user.email", "ragit@example.com"]);
      git(temp, ["config", "user.name", "ragit-test"]);
      await writeFile(path.join(temp, "README.md"), "# harness drift\n", "utf8");
      await writeFile(
        path.join(temp, "run-harness-case.mjs"),
        `process.stdout.write(JSON.stringify({ status: "bad", summary: "missing follow-up packet" })); process.exit(0);\n`,
        "utf8",
      );
      git(temp, ["add", "."]);
      git(temp, ["commit", "-m", "init"]);

      await runInit(temp, { nonInteractive: true });

      const goal = "validate drift harness";
      const oracleId = harnessArtifactId("oracle", goal, "failure oracle");
      const captured = await captureHarness(temp, {
        goal,
        sourceSessionId: "session-harness",
        resources: [
          {
            kind: "oracle",
            title: "failure oracle",
            expected: {
              mustInclude: ["blocked issue"],
              jsonSubset: { status: "ok" },
            },
          },
          {
            kind: "case",
            title: "failing case",
            input: { prompt: "restore the active work packet" },
            oracleRefs: [oracleId],
            evidenceRefs: ["evid-fail"],
          },
        ],
      });

      await reviewArtifacts(
        temp,
        {
          updates: captured.artifactIds.map((artifactId) => ({
            artifactId,
            nextStatus: "reviewed" as const,
            reason: "review suite for drift",
          })),
        },
      );

      await runHarness(temp, {
        suiteRef: captured.suiteId,
        executor: {
          kind: "command",
          argv: [process.execPath, "run-harness-case.mjs"],
        },
      });

      const result = await runDrift(temp, { scope: "harness" });
      const suite = result.items.find((item) => item.id === captured.suiteId);
      expect(suite?.status).toBe("stale");
      expect(suite?.reasonCodes).toContain("failure_evidence_present");
      expect(suite?.recommendedActions).toContain("harness verify");
      expect(suite?.recommendedActions).toContain("harness run");
    },
    20_000,
  );
});
