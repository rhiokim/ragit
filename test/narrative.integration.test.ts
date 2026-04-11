import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { reviewArtifacts, sessionMaterialize } from "../src/core/artifacts.js";
import { runIngest } from "../src/core/ingest.js";
import { runMemoryWrap } from "../src/core/memory.js";
import { runNarrativeReport } from "../src/core/narrative.js";
import {
  NARRATIVE_MODEL_SCHEMA_VERSION,
  NARRATIVE_PROJECTION_MODE,
  NARRATIVE_PROJECTION_POLICY_VERSION,
} from "../src/core/narrative-model.js";
import { RAGIT_VERSION } from "../src/core/version.js";

const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("narrative integration", () => {
  it(
    "builds a self-contained narrative report from snapshots, artifacts, and events",
    async () => {
      const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-narrative-"));
      git(temp, ["init"]);
      git(temp, ["config", "user.email", "ragit@example.com"]);
      git(temp, ["config", "user.name", "ragit-test"]);

      await mkdir(path.join(temp, "docs", "arch"), { recursive: true });
      await writeFile(
        path.join(temp, "docs", "arch", "auth-boundary.adr.md"),
        `---
type: adr
---
# Auth Boundary
Keep refresh mutation outside snapshot writes.
`,
        "utf8",
      );
      git(temp, ["add", "."]);
      git(temp, ["commit", "-m", "seed auth adr"]);

      await runInit(temp, { nonInteractive: true });
      await runIngest(temp, { all: true });

      await writeFile(path.join(temp, "notes.txt"), "missing snapshot commit\n", "utf8");
      git(temp, ["add", "notes.txt"]);
      git(temp, ["commit", "-m", "notes only"]);
      const missingSha = git(temp, ["rev-parse", "HEAD"]);

      await writeFile(
        path.join(temp, "docs", "arch", "runtime-boundary.adr.md"),
        `---
type: adr
---
# Auth Boundary
Keep refresh mutation outside snapshot writes, but split recovery from packet synthesis.
`,
        "utf8",
      );
      await writeFile(
        path.join(temp, "docs", "auth-rollout.plan.md"),
        `---
type: plan
---
# Auth Rollout
Ship the recovery changes in two deliberate phases.
`,
        "utf8",
      );
      git(temp, ["rm", "docs/arch/auth-boundary.adr.md"]);
      git(temp, ["add", "."]);
      git(temp, ["commit", "-m", "replace adr and add plan"]);

      await runIngest(temp, { since: missingSha });

      const materialized = await sessionMaterialize(temp, {
        goal: "resume auth recovery work",
        episode: { id: "ep-auth-recovery", title: "Auth recovery narrative" },
        relatedPaths: ["docs/arch/runtime-boundary.adr.md"],
        createdAt: "2026-04-11T10:00:00.000Z",
        turns: [
          {
            turnId: "turn-1",
            role: "user",
            content: "Please keep token=super-secret-value out of packets.",
            createdAt: "2026-04-11T10:00:00.000Z",
          },
          {
            turnId: "turn-2",
            role: "user",
            content: "Do not mutate snapshot contracts while fixing auth.",
            createdAt: "2026-04-11T10:01:00.000Z",
          },
          {
            turnId: "turn-3",
            role: "assistant",
            content: "Key insight: recall packets should restore active work instead of replaying raw logs.",
            createdAt: "2026-04-11T10:02:00.000Z",
          },
        ],
      });

      const reviewTargets = materialized.artifactIds.filter(
        (artifactId) =>
          artifactId.includes("_feedback_") || artifactId.includes("_constraint_") || artifactId.includes("_insight_"),
      );
      await reviewArtifacts(
        temp,
        {
          updates: reviewTargets.map((artifactId) => ({
            artifactId,
            nextStatus: "reviewed" as const,
            reason: "confirmed for onboarding report",
          })),
        },
      );

      await runMemoryWrap(temp, {
        goal: "resume auth recovery work",
        episode: { id: "ep-auth-recovery" },
        summary: "Recover auth flow without reopening the entire history.",
        constraints: ["keep snapshot contracts intact"],
        decisions: [],
        openLoops: [
          {
            id: "loop-1",
            title: "Finalize packet boundary",
            status: "open",
            nextAction: "Patch runtime ADR",
          },
        ],
        nextActions: ["Patch runtime ADR"],
        promotionCandidates: [],
        artifactRefs: reviewTargets,
      });

      const result = await runNarrativeReport(temp, { emitModel: ".ragit/reports/narrative/model.json" });
      expect(result.dryRun).toBe(false);
      expect(result.modelPath).toBe(".ragit/reports/narrative/model.json");
      expect(result.window.selectedSnapshotShas).toHaveLength(2);
      expect(result.window.missingSnapshotCommits).toBe(1);
      expect(result.summary.decisionThreads).toBeGreaterThan(0);
      expect(result.summary.decisionNodes).toBeGreaterThanOrEqual(3);
      expect(result.summary.intentItems).toBeGreaterThan(0);
      expect(result.summary.timelineEvents).toBeGreaterThan(0);
      expect(result.summary.heuristicEdges).toBeGreaterThanOrEqual(1);

      const reportPath = path.join(temp, result.reportPath);
      const html = await readFile(reportPath, "utf8");
      const modelJson = JSON.parse(await readFile(path.join(temp, result.modelPath as string), "utf8"));
      expect(modelJson.schemaVersion).toBe(NARRATIVE_MODEL_SCHEMA_VERSION);
      expect(modelJson.producerVersion).toBe(RAGIT_VERSION);
      expect(modelJson.projectionPolicyVersion).toBe(NARRATIVE_PROJECTION_POLICY_VERSION);
      expect(modelJson.projectionMode).toBe(NARRATIVE_PROJECTION_MODE);
      expect(html).toContain('id="report-summary"');
      expect(html).toContain('id="decision-evolution"');
      expect(html).toContain('id="intent-panel"');
      expect(html).toContain('id="operational-timeline"');
      expect(html).toContain("Auth Boundary");
      expect(html).toContain("Auth Rollout");
      expect(html).toContain("badge-trust");
      expect(html).toContain("durable-doc");
      expect(html).toContain("restricted");
      expect(html).not.toContain("super-secret-value");
      expect("goalId" in modelJson.intentItems[0]).toBe(false);
      expect(modelJson.intentItems[0].binding.goalCount).toBeGreaterThan(0);
      expect(modelJson.intentItems[0].badges.sensitivity).toBe("restricted");
      expect(html).not.toMatch(/<(?:script|link|img)[^>]+https?:\/\//i);
      expect(modelJson.summary).toEqual(result.summary);
      expect(modelJson.window).toEqual(result.window);
      expect(JSON.stringify(modelJson)).not.toContain("super-secret-value");
    },
    30_000,
  );

  it(
    "returns a dry-run plan and can still generate an empty-state report without snapshots",
    async () => {
      const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-narrative-empty-"));
      git(temp, ["init"]);
      git(temp, ["config", "user.email", "ragit@example.com"]);
      git(temp, ["config", "user.name", "ragit-test"]);
      await writeFile(path.join(temp, "README.md"), "# empty narrative\n", "utf8");
      git(temp, ["add", "."]);
      git(temp, ["commit", "-m", "seed empty repo"]);

      const dryRun = await runNarrativeReport(temp, { dryRun: true });
      expect(dryRun.dryRun).toBe(true);
      expect(dryRun.modelPath).toBeNull();
      expect(dryRun.window.selectedSnapshotShas).toHaveLength(0);
      expect(dryRun.summary.decisionThreads).toBe(0);
      await expect(readFile(path.join(temp, dryRun.reportPath), "utf8")).rejects.toThrow();

      const generated = await runNarrativeReport(temp);
      const html = await readFile(path.join(temp, generated.reportPath), "utf8");
      expect(generated.window.selectedSnapshotShas).toHaveLength(0);
      expect(generated.warnings.some((warning) => warning.includes("empty-state"))).toBe(true);
      expect(html).toContain("empty-state");
      expect(html).toContain("ragit ingest");
    },
    20_000,
  );
});
