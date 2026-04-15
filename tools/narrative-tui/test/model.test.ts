import { describe, expect, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildExplorerView,
  buildFormationOptionDescription,
  buildRecoveryOptionDescription,
  buildTrustOptionDescription,
  buildValidationBadgeLabel,
  buildValidationSummary,
  loadNarrativeModel,
  type ExplorerState,
} from "../src/model";

const fixturePath = path.join(import.meta.dir, "..", "fixtures", "sample-model.json");

const loadFixture = async () => loadNarrativeModel(fixturePath);

const emptyState = (): ExplorerState => ({
  query: "",
  scope: "all",
  selectedRecoveryItemId: null,
  selectedTrustItemId: null,
  selectedFormationStepId: null,
});

describe("narrative-tui recovery explorer", () => {
  it("loads the current versioned narrative model fixture with recovery data", async () => {
    const model = await loadFixture();

    expect(model.schemaVersion).toBe(1);
    expect(model.projectionMode).toBe("viewer-safe");
    expect(model.recovery.recoverNow.items.length).toBeGreaterThan(0);
    expect(model.recovery.whatToTrust.items.length).toBeGreaterThan(0);
    expect(model.recovery.howWeGotHere.steps.length).toBeGreaterThan(0);
    expect(model.recovery.recoverNow.currentGoal).toContain("viewer recovery-first");
    expect(model.recovery.whatToTrust.freshnessCounts).toEqual({
      fresh: 4,
      suspect: 4,
      stale: 2,
    });
    expect(model.recovery.whatToTrust.validationCounts).toEqual({
      verified: 5,
      attention: 3,
      unverified: 2,
    });
  });

  it("builds a recovery-first view with Recover Now as the primary selection", async () => {
    const model = await loadFixture();
    const view = buildExplorerView(model, emptyState());

    expect(view.empty).toBe(false);
    expect(view.visibleRecoveryItems.length).toBe(3);
    expect(view.selectedRecoveryItem?.itemId).toBe("recovery_goal");
    expect(view.selectedTrustItem).toBeNull();
    expect(view.selectedFormationStep).toBeNull();
    expect(view.detail.kind).toBe("recovery");
    expect(view.detail.extra.join("\n")).toContain("source: working-memory");
    expect(view.selectedThread?.threadId).toBe("thread_2");
    expect(buildRecoveryOptionDescription(view.selectedRecoveryItem!)).toContain("working-memory");
  });

  it("switches detail focus across trust and formation selections", async () => {
    const model = await loadFixture();

    const trustView = buildExplorerView(model, {
      ...emptyState(),
      selectedTrustItemId: "trust_event_1",
    });
    expect(trustView.detail.kind).toBe("trust");
    expect(trustView.detail.title).toContain("security.admission");
    expect(buildValidationBadgeLabel(trustView.detail.validationStatus)).toBe("[unverified]");
    expect(
      buildValidationSummary(
        trustView.detail.validationStatus,
        trustView.detail.validationReasonCodes,
        trustView.detail.validationEvidenceRefs,
        trustView.detail.validationRecommendedActions,
      ),
    ).toContain("validation: unverified");
    expect(buildTrustOptionDescription(trustView.visibleTrustItems[0]!)).toContain("durable-doc");

    const formationView = buildExplorerView(model, {
      ...emptyState(),
      selectedFormationStepId: "step_thread_1",
    });
    expect(formationView.detail.kind).toBe("formation");
    expect(formationView.detail.title).toContain("Narrative report architecture thread");
    expect(buildFormationOptionDescription(formationView.visibleFormationSteps[1]!)).toContain("2026-04-10");
  });

  it("filters recovery items by query in recovery scope", async () => {
    const model = await loadFixture();
    const view = buildExplorerView(model, {
      ...emptyState(),
      query: "future bridge",
      scope: "recover",
    });

    expect(view.visibleRecoveryItems.map((item) => item.itemId)).toEqual(["recovery_loop"]);
    expect(view.selectedRecoveryItem?.itemId).toBe("recovery_loop");
  });

  it("coerces a legacy unversioned narrative model through the compatibility path", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-narrative-tui-legacy-"));
    const legacyPath = path.join(temp, "legacy-model.json");
    await writeFile(
      legacyPath,
      JSON.stringify({
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
          decisionThreads: 0,
          decisionNodes: 0,
          intentItems: 0,
          timelineEvents: 0,
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
      }),
      "utf8",
    );

    const legacy = await loadNarrativeModel(legacyPath);

    expect(legacy.schemaVersion).toBe(1);
    expect(legacy.producerVersion).toBe("legacy-unversioned");
    expect(legacy.recovery.empty).toBe(true);
    expect(legacy.recovery.recoverNow.items).toEqual([]);
    expect(legacy.recovery.whatToTrust.items).toEqual([]);
    expect(legacy.recovery.howWeGotHere.steps).toEqual([]);
  });

  it("fails fast on unsupported narrative model major versions", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-narrative-tui-unsupported-"));
    const unsupportedPath = path.join(temp, "unsupported-model.json");
    await writeFile(
      unsupportedPath,
      JSON.stringify({
        schemaVersion: 2,
        producerVersion: "2.0.0",
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
          decisionThreads: 0,
          decisionNodes: 0,
          intentItems: 0,
          timelineEvents: 0,
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
      }),
      "utf8",
    );

    await expect(loadNarrativeModel(unsupportedPath)).rejects.toThrow(/Unsupported narrative model schemaVersion=2/);
  });

  it("fails fast on unsupported narrative projection policy versions", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-narrative-tui-projection-unsupported-"));
    const unsupportedPath = path.join(temp, "unsupported-projection-model.json");
    await writeFile(
      unsupportedPath,
      JSON.stringify({
        schemaVersion: 1,
        producerVersion: "1.0.1",
        projectionPolicyVersion: 2,
        projectionMode: "viewer-safe",
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
          decisionThreads: 0,
          decisionNodes: 0,
          intentItems: 0,
          timelineEvents: 0,
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
      }),
      "utf8",
    );

    await expect(loadNarrativeModel(unsupportedPath)).rejects.toThrow(
      /Unsupported narrative projectionPolicyVersion=2/,
    );
  });
});
