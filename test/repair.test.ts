import { describe, expect, it } from "vitest";
import { buildRepairPlan, normalizeRepairActionKind } from "../src/core/repair.js";
import { DriftItem, DriftResult } from "../src/core/types.js";

const makeItem = (overrides: Partial<DriftItem>): DriftItem => ({
  scope: "durable",
  itemType: "document",
  id: "item-1",
  title: "docs/auth.adr.md",
  status: "fresh",
  reasonCodes: [],
  affectedPaths: [],
  sourceRefs: {
    headSha: "head-sha",
  },
  recommendedActions: [],
  ...overrides,
});

const makeDrift = (items: DriftItem[]): DriftResult => ({
  overallStatus: items.some((item) => item.status === "stale") ? "stale" : items.some((item) => item.status === "suspect") ? "suspect" : "fresh",
  counts: {
    fresh: items.filter((item) => item.status === "fresh").length,
    suspect: items.filter((item) => item.status === "suspect").length,
    stale: items.filter((item) => item.status === "stale").length,
  },
  filters: {
    scope: "all",
    path: null,
    goalId: null,
    sessionId: null,
    maxCount: null,
  },
  baseline: {
    headSha: "head-sha",
    snapshotSha: "snapshot-sha",
    snapshotCommitSha: "snapshot-sha",
    reasonCodes: [],
  },
  items,
});

describe("repair planner", () => {
  it("recognizes store-rebuild only as an explicit action filter", () => {
    expect(normalizeRepairActionKind("store-rebuild")).toBe("store-rebuild");
    expect(buildRepairPlan(makeDrift([]), [])).toEqual([]);
    expect(buildRepairPlan(makeDrift([]), ["store-rebuild"])).toEqual([]);
  });

  it("prefers a single full ingest over targeted ingest when the baseline is missing", () => {
    const drift = makeDrift([
      makeItem({
        scope: "durable",
        itemType: "baseline",
        id: "baseline",
        title: "No searchable snapshot baseline",
        status: "suspect",
        reasonCodes: ["no_baseline"],
      }),
      makeItem({
        scope: "durable",
        id: "doc-1",
        status: "stale",
        reasonCodes: ["tracked_path_changed"],
        affectedPaths: ["docs/auth.adr.md"],
      }),
    ]);

    const plan = buildRepairPlan(drift);

    expect(plan).toHaveLength(1);
    expect(plan[0]?.action).toBe("ingest");
    expect(plan[0]?.args).toEqual(["--all", "--scope", "durable"]);
  });

  it("dedupes multiple durable path drifts into one targeted ingest action", () => {
    const drift = makeDrift([
      makeItem({
        id: "doc-1",
        status: "stale",
        reasonCodes: ["tracked_path_changed"],
        affectedPaths: ["docs/auth.adr.md"],
      }),
      makeItem({
        id: "doc-2",
        title: "docs/session.plan.md",
        status: "stale",
        reasonCodes: ["tracked_path_changed"],
        affectedPaths: ["docs/session.plan.md"],
      }),
    ]);

    const plan = buildRepairPlan(drift);

    expect(plan).toHaveLength(1);
    expect(plan[0]?.action).toBe("ingest");
    expect(plan[0]?.args).toEqual(["--path", "docs/auth.adr.md", "--path", "docs/session.plan.md", "--scope", "durable"]);
  });

  it("emits conservative blocked actions for memory drift and honors action filters", () => {
    const drift = makeDrift([
      makeItem({
        scope: "memory",
        itemType: "memoryArtifact",
        id: "art-memory-1",
        status: "stale",
        reasonCodes: ["related_path_changed", "missing_binding"],
        affectedPaths: ["docs/auth.adr.md"],
        recommendedActions: ["memory promote"],
      }),
    ]);

    const fullPlan = buildRepairPlan(drift);
    expect(fullPlan.map((action) => action.action)).toEqual(["doc-refresh", "artifact-review", "memory-promote"]);
    expect(fullPlan.every((action) => action.status === "blocked")).toBe(true);

    const filtered = buildRepairPlan(drift, ["artifact-review"]);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.action).toBe("artifact-review");
  });

  it("plans one verify and one blocked rerun for harness failure evidence", () => {
    const drift = makeDrift([
      makeItem({
        scope: "harness",
        itemType: "harnessSuite",
        id: "suite-1",
        title: "auth suite",
        status: "stale",
        reasonCodes: ["dependency_stale", "failure_evidence_present"],
      }),
    ]);

    const plan = buildRepairPlan(drift);

    expect(plan.map((action) => `${action.action}:${action.status}`)).toEqual(["harness-verify:planned", "harness-run:blocked"]);
    expect(plan[0]?.reasonCodes).toEqual(["dependency_stale", "failure_evidence_present"]);
  });
});
