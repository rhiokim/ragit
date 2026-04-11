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
      expect(built.viewModel.snapshots).toHaveLength(1);
      expect(built.viewModel.threads.length).toBeGreaterThan(0);
      expect(built.viewModel.intentItems.length).toBeGreaterThan(0);

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
    expect(normalized.warnings[0]).toContain("legacy-unversioned");
  });
});
