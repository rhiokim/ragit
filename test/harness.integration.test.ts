import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runStatus } from "../src/commands/bootstrap.js";
import { loadArtifactRecord, reviewArtifacts } from "../src/core/artifacts.js";
import { promoteHarness, runHarness, verifyHarness, captureHarness, packHarness } from "../src/core/harness.js";
import { runIngest } from "../src/core/ingest.js";
import { runInit } from "../src/commands/init.js";

const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const sha1 = (...parts: string[]): string => createHash("sha1").update(parts.join(":")).digest("hex");
const harnessArtifactId = (kind: string, goal: string, title: string): string => `art_harness_${kind}_${sha1(kind, goal, title).slice(0, 16)}`;
const fileExists = async (target: string): Promise<boolean> => {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
};

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
      expect(promoted.ingested).toBe(false);
      expect(promoted.warnings).toContainEqual(expect.stringContaining("commit"));

      git(temp, ["add", "-A"]);
      git(temp, ["commit", "-m", "commit promoted harness docs"]);
      const indexed = await runIngest(temp, { all: true });
      expect(indexed.searchReady).toBe(true);

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

  it(
    "executes harness suites, persists run records, and captures failure artifacts",
    async () => {
      const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-harness-run-"));
      git(temp, ["init"]);
      git(temp, ["config", "user.email", "ragit@example.com"]);
      git(temp, ["config", "user.name", "ragit-test"]);
      await writeFile(path.join(temp, "README.md"), "# harness run\n", "utf8");
      await writeFile(
        path.join(temp, "run-harness-case.mjs"),
        `const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
if (payload.case.title.includes("pass")) {
  process.stdout.write(JSON.stringify({ status: "ok", summary: "open loops and next actions are restored" }));
  process.exit(0);
}
process.stdout.write(JSON.stringify({ status: "bad", summary: "missing follow-up packet" }));
process.exit(0);
`,
        "utf8",
      );
      git(temp, ["add", "."]);
      git(temp, ["commit", "-m", "init"]);

      await runInit(temp, { nonInteractive: true });

      const goal = "validate harness execution";
      const passOracleId = harnessArtifactId("oracle", goal, "pass oracle");
      const failOracleId = harnessArtifactId("oracle", goal, "fail oracle");
      const captured = await captureHarness(temp, {
        goal,
        sourceSessionId: "session-run",
        resources: [
          {
            kind: "oracle",
            title: "pass oracle",
            summary: "Passing case must restore the packet.",
            expected: {
              mustInclude: ["open loops", "next actions"],
              jsonSubset: { status: "ok" },
            },
          },
          {
            kind: "oracle",
            title: "fail oracle",
            summary: "Failing case expects a token that never appears.",
            expected: {
              mustInclude: ["next actions", "blocked issue"],
              jsonSubset: { status: "ok" },
            },
          },
          {
            kind: "case",
            title: "pass case",
            input: { prompt: "restore the active work packet" },
            oracleRefs: [passOracleId],
            evidenceRefs: ["evid-pass"],
          },
          {
            kind: "case",
            title: "fail case",
            input: { prompt: "restore the active work packet" },
            oracleRefs: [failOracleId],
            evidenceRefs: ["evid-fail"],
          },
        ],
      });

      const runResult = await runHarness(temp, {
        suiteRef: captured.suiteId,
        executor: {
          kind: "command",
          argv: [process.execPath, "run-harness-case.mjs"],
        },
      });

      expect(runResult.dryRun).toBe(false);
      expect(runResult.summary.total).toBe(2);
      expect(runResult.summary.passed).toBe(1);
      expect(runResult.summary.failed).toBe(1);
      expect(runResult.summary.errored).toBe(0);
      expect(runResult.runPath).toMatch(/^\.ragit\/log\/harness-runs\//);

      const runRecordPath = path.join(temp, runResult.runPath!);
      expect(await fileExists(runRecordPath)).toBe(true);
      const runRecord = JSON.parse(await readFile(runRecordPath, "utf8"));
      expect(runRecord.summary.failed).toBe(1);
      expect(runRecord.caseResults).toHaveLength(2);

      const failureCase = runResult.caseResults.find((result) => result.status === "failed");
      expect(failureCase?.failureArtifactIds).toHaveLength(1);
      const failureArtifact = await loadArtifactRecord(temp, failureCase!.failureArtifactIds[0]!);
      expect(failureArtifact?.kind).toBe("failure");
      expect(failureArtifact?.searchPolicy).toBe("evidence");
    },
    20_000,
  );

  it(
    "keeps harness run side-effect free in dry-run mode",
    async () => {
      const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-harness-run-dry-"));
      git(temp, ["init"]);
      git(temp, ["config", "user.email", "ragit@example.com"]);
      git(temp, ["config", "user.name", "ragit-test"]);
      await writeFile(path.join(temp, "README.md"), "# harness run dry\n", "utf8");
      await writeFile(
        path.join(temp, "run-harness-case.mjs"),
        `process.stdout.write("should-not-run");
process.exit(0);
`,
        "utf8",
      );
      git(temp, ["add", "."]);
      git(temp, ["commit", "-m", "init"]);

      await runInit(temp, { nonInteractive: true });

      const goal = "validate dry run";
      const oracleId = harnessArtifactId("oracle", goal, "dry oracle");
      const captured = await captureHarness(temp, {
        goal,
        sourceSessionId: "session-dry",
        resources: [
          {
            kind: "oracle",
            title: "dry oracle",
            expected: {
              mustInclude: ["never executed"],
            },
          },
          {
            kind: "case",
            title: "dry case",
            input: { prompt: "should not run" },
            oracleRefs: [oracleId],
            evidenceRefs: ["evid-dry"],
          },
        ],
      });

      const dryRun = await runHarness(
        temp,
        {
          suiteRef: captured.suiteId,
          executor: {
            kind: "command",
            argv: [process.execPath, "run-harness-case.mjs"],
          },
        },
        true,
      );

      expect(dryRun.dryRun).toBe(true);
      expect(dryRun.summary.skipped).toBe(1);
      expect(dryRun.caseResults[0]?.status).toBe("skipped");
      expect(await fileExists(path.join(temp, dryRun.runPath!))).toBe(false);
    },
    20_000,
  );

  it(
    "evaluates full stdout and enforces implicit zero exit codes when no explicit rule is provided",
    async () => {
      const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-harness-run-eval-"));
      git(temp, ["init"]);
      git(temp, ["config", "user.email", "ragit@example.com"]);
      git(temp, ["config", "user.name", "ragit-test"]);
      await writeFile(path.join(temp, "README.md"), "# harness run eval\n", "utf8");
      await writeFile(
        path.join(temp, "run-harness-case.mjs"),
        `const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
if (payload.case.title.includes("long pass")) {
  process.stdout.write("a".repeat(17000) + " needle");
  process.exitCode = 0;
} else {
  process.stdout.write("needle");
  process.exitCode = 1;
}
`,
        "utf8",
      );
      git(temp, ["add", "."]);
      git(temp, ["commit", "-m", "init"]);

      await runInit(temp, { nonInteractive: true });

      const goal = "validate evaluator edge cases";
      const longOracleId = harnessArtifactId("oracle", goal, "long oracle");
      const exitOracleId = harnessArtifactId("oracle", goal, "implicit exit oracle");
      const captured = await captureHarness(temp, {
        goal,
        sourceSessionId: "session-eval",
        resources: [
          {
            kind: "oracle",
            title: "long oracle",
            expected: { mustInclude: ["needle"] },
          },
          {
            kind: "oracle",
            title: "implicit exit oracle",
            expected: { mustInclude: ["needle"] },
          },
          {
            kind: "case",
            title: "long pass case",
            input: { prompt: "emit a long response" },
            oracleRefs: [longOracleId],
            evidenceRefs: ["evid-long"],
          },
          {
            kind: "case",
            title: "implicit exit fail case",
            input: { prompt: "emit a non-zero exit" },
            oracleRefs: [exitOracleId],
            evidenceRefs: ["evid-exit"],
          },
        ],
      });

      const result = await runHarness(temp, {
        suiteRef: captured.suiteId,
        executor: {
          kind: "command",
          argv: [process.execPath, "run-harness-case.mjs"],
        },
      });

      expect(result.summary.total).toBe(2);
      expect(result.summary.passed).toBe(1);
      expect(result.summary.failed).toBe(1);
      expect(result.caseResults.find((item) => item.title === "long pass case")?.status).toBe("passed");
      expect(result.caseResults.find((item) => item.title === "implicit exit fail case")?.status).toBe("failed");
    },
    20_000,
  );
});
