import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { reviewArtifacts, sessionMaterialize } from "../src/core/artifacts.js";
import { runRepair } from "../src/core/repair.js";
import { captureHarness, runHarness } from "../src/core/harness.js";
import { latestSnapshotSha } from "../src/core/manifest.js";
import { runInit } from "../src/commands/init.js";

const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const sha1 = (...parts: string[]): string => createHash("sha1").update(parts.join(":")).digest("hex");
const harnessArtifactId = (kind: string, goal: string, title: string): string => `art_harness_${kind}_${sha1(kind, goal, title).slice(0, 16)}`;

describe("repair integration", () => {
  it(
    "keeps plan mode side-effect free and plans a full ingest when no baseline exists",
    async () => {
      const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-repair-plan-"));
      git(temp, ["init"]);
      git(temp, ["config", "user.email", "ragit@example.com"]);
      git(temp, ["config", "user.name", "ragit-test"]);
      await writeFile(path.join(temp, "README.md"), "# repair baseline\n", "utf8");
      git(temp, ["add", "."]);
      git(temp, ["commit", "-m", "init"]);

      const before = git(temp, ["diff", "--name-only", "HEAD", "--"]);
      const result = await runRepair(temp, {});
      const after = git(temp, ["diff", "--name-only", "HEAD", "--"]);

      expect(result.mode).toBe("plan");
      expect(result.plannedActions[0]?.action).toBe("ingest");
      expect(result.plannedActions[0]?.status).toBe("planned");
      await expect(access(path.join(temp, ".ragit", "manifest"), constants.F_OK)).rejects.toThrow();
      expect(after).toBe(before);
    },
    15_000,
  );

  it(
    "applies a full ingest when the baseline is missing",
    async () => {
      const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-repair-apply-baseline-"));
      git(temp, ["init"]);
      git(temp, ["config", "user.email", "ragit@example.com"]);
      git(temp, ["config", "user.name", "ragit-test"]);
      await writeFile(path.join(temp, "README.md"), "# repair apply\n", "utf8");
      git(temp, ["add", "."]);
      git(temp, ["commit", "-m", "init"]);

      const result = await runRepair(temp, { apply: true });

      expect(result.mode).toBe("apply");
      expect(result.summary.executed).toBe(1);
      expect(result.executedActions[0]?.action).toBe("ingest");
      expect(await latestSnapshotSha(temp)).toBeTruthy();
    },
    15_000,
  );

  it(
    "blocks artifact review for unbound reviewed memory artifacts",
    async () => {
      const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-repair-memory-binding-"));
      git(temp, ["init"]);
      git(temp, ["config", "user.email", "ragit@example.com"]);
      git(temp, ["config", "user.name", "ragit-test"]);
      await writeFile(path.join(temp, "README.md"), "# repair binding\n", "utf8");

      await runInit(temp, { nonInteractive: true });

      const materialized = await sessionMaterialize(temp, {
        goal: "bootstrap without head",
        relatedPaths: ["README.md"],
        createdAt: "2026-04-10T10:00:00.000Z",
        turns: [
          {
            turnId: "turn-1",
            role: "user",
            content: "Please keep this blocker visible.",
            createdAt: "2026-04-10T10:00:00.000Z",
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

      const result = await runRepair(temp, { scope: "memory" });

      expect(result.summary.blocked).toBeGreaterThan(0);
      expect(result.plannedActions.some((action) => action.action === "artifact-review" && action.status === "blocked")).toBe(true);
    },
    15_000,
  );

  it(
    "executes harness verify for dependency-stale reviewed suites",
    async () => {
      const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-repair-harness-verify-"));
      git(temp, ["init"]);
      git(temp, ["config", "user.email", "ragit@example.com"]);
      git(temp, ["config", "user.name", "ragit-test"]);
      await writeFile(path.join(temp, "README.md"), "# harness verify\n", "utf8");
      git(temp, ["add", "."]);
      git(temp, ["commit", "-m", "init"]);

      await runInit(temp, { nonInteractive: true });

      const goal = "validate repair harness verify";
      const oracleId = harnessArtifactId("oracle", goal, "resume packet oracle");
      const captured = await captureHarness(temp, {
        goal,
        sourceSessionId: "session-harness-verify",
        resources: [
          {
            kind: "oracle",
            title: "resume packet oracle",
            summary: "Response must include goal and next actions.",
          },
          {
            kind: "case",
            title: "resume after token expiry",
            input: { prompt: "resume auth flow after token expired" },
            oracleRefs: [oracleId],
            evidenceRefs: ["evid-resume"],
          },
        ],
      });

      await reviewArtifacts(temp, {
        updates: [
          {
            artifactId: captured.suiteId,
            nextStatus: "reviewed",
            reason: "review suite only to force dependency drift",
          },
        ],
      });

      const result = await runRepair(temp, { scope: "harness", apply: true });

      expect(result.executedActions.some((action) => action.action === "harness-verify" && action.status === "executed")).toBe(true);
      expect(result.summary.failed).toBe(0);
    },
    20_000,
  );

  it(
    "executes harness verify and keeps harness run blocked when failure evidence exists",
    async () => {
      const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-repair-harness-run-"));
      git(temp, ["init"]);
      git(temp, ["config", "user.email", "ragit@example.com"]);
      git(temp, ["config", "user.name", "ragit-test"]);
      await writeFile(path.join(temp, "README.md"), "# harness run\n", "utf8");
      await writeFile(
        path.join(temp, "run-harness-case.mjs"),
        `process.stdout.write(JSON.stringify({ status: "bad", summary: "missing follow-up packet" })); process.exit(0);\n`,
        "utf8",
      );
      git(temp, ["add", "."]);
      git(temp, ["commit", "-m", "init"]);

      await runInit(temp, { nonInteractive: true });

      const goal = "validate repair harness run";
      const oracleId = harnessArtifactId("oracle", goal, "failure oracle");
      const captured = await captureHarness(temp, {
        goal,
        sourceSessionId: "session-harness-run",
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
            reason: "review harness for repair",
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

      const result = await runRepair(temp, { scope: "harness", apply: true });

      expect(result.executedActions.some((action) => action.action === "harness-verify" && action.status === "executed")).toBe(true);
      expect(result.skippedActions.some((action) => action.action === "harness-run" && action.status === "blocked")).toBe(true);
    },
    20_000,
  );
});
