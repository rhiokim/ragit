import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { reviewArtifacts, sessionMaterialize } from "../src/core/artifacts.js";
import { runIngest } from "../src/core/ingest.js";
import {
  buildNarrativeViewModel,
  NARRATIVE_PROJECTION_MODE,
  NARRATIVE_PROJECTION_POLICY_VERSION,
  NARRATIVE_MODEL_LEGACY_PRODUCER_VERSION,
  NARRATIVE_MODEL_SCHEMA_VERSION,
  normalizeNarrativeViewModel,
} from "../src/core/narrative-model.js";
import { RAGIT_VERSION } from "../src/core/version.js";

const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("narrative model contract", () => {
  it(
    "builds a sanitized renderer-agnostic narrative model",
    async () => {
      const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-narrative-model-"));
      git(temp, ["init"]);
      git(temp, ["config", "user.email", "ragit@example.com"]);
      git(temp, ["config", "user.name", "ragit-test"]);

      await mkdir(path.join(temp, "docs", "arch"), { recursive: true });
      await writeFile(
        path.join(temp, "docs", "arch", "boundary.adr.md"),
        `---
type: adr
---
# Runtime Boundary
Keep report synthesis separate from viewer rendering.
`,
        "utf8",
      );
      git(temp, ["add", "."]);
      git(temp, ["commit", "-m", "seed narrative boundary"]);

      await runInit(temp, { nonInteractive: true });
      await runIngest(temp, { all: true });

      const materialized = await sessionMaterialize(temp, {
        goal: "visualize decision history",
        episode: { id: "ep-narrative", title: "Narrative contract" },
        relatedPaths: ["docs/arch/boundary.adr.md"],
        turns: [
          {
            turnId: "turn-1",
            role: "user",
            content: "Do not leak token=very-secret-model-value into the report.",
            createdAt: "2026-04-11T12:00:00.000Z",
          },
          {
            turnId: "turn-2",
            role: "assistant",
            content: "Keep the report model reusable across renderers.",
            createdAt: "2026-04-11T12:01:00.000Z",
          },
        ],
      });

      const reviewTarget = materialized.artifactIds.find(
        (artifactId) =>
          artifactId.includes("_feedback_") || artifactId.includes("_constraint_") || artifactId.includes("_insight_"),
      );
      if (!reviewTarget) {
        throw new Error("expected reviewed intent artifact");
      }
      await reviewArtifacts(temp, {
        updates: [
          {
            artifactId: reviewTarget,
            nextStatus: "reviewed",
            reason: "stabilize narrative model contract",
          },
        ],
      });

      const built = await buildNarrativeViewModel(temp, { dryRun: true });
      expect(built.result.dryRun).toBe(true);
      expect(built.result.reportPath).toMatch(/\.ragit\/reports\/narrative\/.+\.html$/);
      expect(built.viewModel.summary).toEqual(built.result.summary);
      expect(built.viewModel.window).toEqual(built.result.window);
      expect(built.viewModel.schemaVersion).toBe(NARRATIVE_MODEL_SCHEMA_VERSION);
      expect(built.viewModel.producerVersion).toBe(RAGIT_VERSION);
      expect(built.viewModel.projectionPolicyVersion).toBe(NARRATIVE_PROJECTION_POLICY_VERSION);
      expect(built.viewModel.projectionMode).toBe(NARRATIVE_PROJECTION_MODE);
      expect(built.viewModel.summary.freshnessCounts).toEqual({
        fresh: 0,
        suspect: 0,
        stale: 0,
      });
      expect(built.viewModel.snapshots).toHaveLength(1);
      expect(built.viewModel.threads.length).toBeGreaterThan(0);
      expect(built.viewModel.intentItems.length).toBeGreaterThan(0);
      expect("goalIds" in built.viewModel.threads[0]).toBe(false);
      expect("goalId" in built.viewModel.intentItems[0]).toBe(false);
      expect("sourceSessionId" in built.viewModel.intentItems[0]).toBe(false);
      expect(built.viewModel.intentItems[0].binding.goalCount).toBeGreaterThan(0);
      expect(built.viewModel.intentItems[0].badges.trust).toBe("reviewed-artifact");
      expect(built.viewModel.intentItems[0].badges.sensitivity).toBe("restricted");
      expect(built.viewModel.threads[0].freshnessStatus).toBeNull();
      expect(built.viewModel.threads[0].driftReasonCodes).toEqual([]);
      expect(built.viewModel.nodes[0].recommendedActions).toEqual([]);
      expect(built.viewModel.intentItems[0].driftSourceRefs).toEqual([]);

      const serialized = JSON.stringify(built.viewModel);
      expect(serialized).not.toContain("very-secret-model-value");
      expect(serialized).toContain("Runtime Boundary");
    },
    20_000,
  );

  it("coerces a legacy unversioned narrative model into the current schema version", async () => {
    const legacyPayload: Record<string, unknown> = {
      repoName: "ragit",
      headSha: "abc1234",
      generatedAt: "2026-04-12T00:00:00.000Z",
      window: {
        revRange: "HEAD",
        maxCommits: 10,
        selectedSnapshotShas: ["abc1234"],
        missingSnapshotCommits: 0,
      },
      summary: {
        decisionThreads: 1,
        decisionNodes: 1,
        intentItems: 1,
        timelineEvents: 1,
        heuristicEdges: 0,
      },
      snapshots: [],
      threads: [],
      nodes: [],
      intentItems: [],
      unassignedIntentItems: [],
      timelineEvents: [],
      warnings: [],
      empty: true,
    };

    const normalized = normalizeNarrativeViewModel(legacyPayload);

    expect(normalized.compatibility).toBe("legacy-unversioned");
    expect(normalized.value?.schemaVersion).toBe(NARRATIVE_MODEL_SCHEMA_VERSION);
    expect(normalized.value?.producerVersion).toBe(NARRATIVE_MODEL_LEGACY_PRODUCER_VERSION);
    expect(normalized.value?.projectionPolicyVersion).toBe(NARRATIVE_PROJECTION_POLICY_VERSION);
    expect(normalized.value?.projectionMode).toBe(NARRATIVE_PROJECTION_MODE);
    expect(normalized.value?.summary.freshnessCounts).toEqual({
      fresh: 0,
      suspect: 0,
      stale: 0,
    });
    expect(normalized.warnings[0]).toContain("legacy-unversioned");
  });

  it("hydrates missing drift overlay fields on versioned payloads", () => {
    const versionedPayload: Record<string, unknown> = {
      schemaVersion: NARRATIVE_MODEL_SCHEMA_VERSION,
      producerVersion: RAGIT_VERSION,
      projectionPolicyVersion: NARRATIVE_PROJECTION_POLICY_VERSION,
      projectionMode: NARRATIVE_PROJECTION_MODE,
      repoName: "ragit",
      headSha: "abc1234",
      generatedAt: "2026-04-12T00:00:00.000Z",
      window: {
        revRange: "HEAD",
        maxCommits: 10,
        selectedSnapshotShas: ["abc1234"],
        missingSnapshotCommits: 0,
      },
      summary: {
        decisionThreads: 1,
        decisionNodes: 1,
        intentItems: 1,
        timelineEvents: 0,
        heuristicEdges: 0,
        freshnessCounts: {
          fresh: 2,
          suspect: 1,
          stale: 0,
        },
      },
      snapshots: [],
      threads: [{ threadId: "thread-1" }],
      nodes: [{ nodeId: "node-1" }],
      intentItems: [{ itemId: "intent-1" }],
      unassignedIntentItems: [],
      timelineEvents: [],
      warnings: [],
      empty: false,
    };

    const normalized = normalizeNarrativeViewModel(versionedPayload);

    expect(normalized.compatibility).toBe("versioned");
    expect(normalized.value?.threads[0].freshnessStatus).toBeNull();
    expect(normalized.value?.threads[0].driftReasonCodes).toEqual([]);
    expect(normalized.value?.nodes[0].recommendedActions).toEqual([]);
    expect(normalized.value?.intentItems[0].driftSourceRefs).toEqual([]);
    expect(normalized.value?.summary.freshnessCounts).toEqual({
      fresh: 2,
      suspect: 1,
      stale: 0,
    });
  });
});
