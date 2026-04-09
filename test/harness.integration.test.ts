import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runStatus } from "../src/commands/bootstrap.js";
import { reviewArtifacts } from "../src/core/artifacts.js";
import { promoteHarness, verifyHarness, captureHarness, packHarness } from "../src/core/harness.js";
import { runIngest } from "../src/core/ingest.js";
import { runInit } from "../src/commands/init.js";

const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("harness integration", () => {
  it(
    "flags missing case oracle/evidence bindings during harness verify",
    async () => {
      const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-harness-verify-"));
      git(temp, ["init"]);
      git(temp, ["config", "user.email", "ragit@example.com"]);
      git(temp, ["config", "user.name", "ragit-test"]);
      await writeFile(path.join(temp, "README.md"), "# harness\n", "utf8");
      git(temp, ["add", "."]);
      git(temp, ["commit", "-m", "init"]);

      await runInit(temp, { nonInteractive: true });

      const captured = await captureHarness(temp, {
        goal: "validate auth refresh continuity",
        sourceSessionId: "session-1",
        artifactRefs: ["art_feedback_1"],
        resources: [
          {
            kind: "case",
            title: "resume after token expiry",
            input: { prompt: "resume auth flow after token expired" },
            expected: { mustInclude: ["open loops", "next actions"] },
          },
          {
            kind: "oracle",
            title: "concise resume packet",
            summary: "Response must stay structured and concise.",
          },
        ],
      });

      const packed = await packHarness(temp, captured.suiteId);
      expect(packed.resources).toHaveLength(2);
      expect(packed.goal).toBe("validate auth refresh continuity");

      const verified = await verifyHarness(temp, captured.suiteId);
      expect(verified.hasFailure).toBe(true);
      expect(verified.checks.some((check) => check.name.startsWith("case.oracle.") && !check.ok)).toBe(true);
      expect(verified.checks.some((check) => check.name.startsWith("case.evidence.") && !check.ok)).toBe(true);
    },
    15_000,
  );

  it(
    "promotes reviewed harness artifacts and supports targeted ingest paths",
    async () => {
      const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-harness-promote-"));
      git(temp, ["init"]);
      git(temp, ["config", "user.email", "ragit@example.com"]);
      git(temp, ["config", "user.name", "ragit-test"]);
      await writeFile(path.join(temp, "README.md"), "# harness promote\n", "utf8");
      git(temp, ["add", "."]);
      git(temp, ["commit", "-m", "init"]);

      await runInit(temp, { nonInteractive: true });

      const captured = await captureHarness(temp, {
        goal: "validate auth refresh continuity",
        sourceSessionId: "session-2",
        resources: [
          {
            kind: "case",
            title: "resume after token expiry",
            input: { prompt: "resume auth flow after token expired" },
            expected: { mustInclude: ["open loops", "next actions"] },
            oracleRefs: ["oracle-resume"],
            evidenceRefs: ["evid-resume"],
          },
          {
            kind: "oracle",
            title: "resume packet oracle",
            summary: "Response must include goal, constraints, and next actions.",
          },
        ],
      });

      await reviewArtifacts(temp, {
        updates: captured.artifactIds.map((artifactId) => ({
          artifactId,
          nextStatus: "reviewed" as const,
        })),
      });

      const promoted = await promoteHarness(temp, {
        artifactRefs: captured.artifactIds.filter((artifactId) => !artifactId.includes("_oracle_")),
      });

      expect(promoted.createdFiles.some((file) => file.startsWith("docs/harness/specs/"))).toBe(true);
      expect(promoted.createdFiles.some((file) => file.startsWith("docs/harness/plans/"))).toBe(true);
      expect(promoted.ingested).toBe(true);

      const targeted = await runIngest(temp, {
        paths: [promoted.createdFiles[0]],
        scope: "durable",
      });
      expect(targeted.plannedFiles).toEqual([promoted.createdFiles[0]]);
      expect(targeted.processed).toBe(1);

      const status = await runStatus(temp);
      expect(status.knowledge.harnessArtifactCount).toBe(captured.artifactIds.length);
    },
    20_000,
  );
});
