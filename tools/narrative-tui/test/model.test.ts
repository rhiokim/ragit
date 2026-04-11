import { describe, expect, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildExplorerView,
  buildIntentOptionDescription,
  buildValidationBadgeLabel,
  buildValidationSummary,
  buildThreadOptionDescription,
  buildThreadViews,
  isEventLinkedToThread,
  isIntentLinkedToThread,
  NARRATIVE_MODEL_LEGACY_PRODUCER_VERSION,
  NARRATIVE_MODEL_SCHEMA_VERSION,
  NARRATIVE_PROJECTION_MODE,
  NARRATIVE_PROJECTION_POLICY_VERSION,
  loadNarrativeModel,
  type ExplorerState,
} from "../src/model";

const fixturePath = path.join(import.meta.dir, "..", "fixtures", "sample-model.json");

const loadFixture = async () => loadNarrativeModel(fixturePath);

describe("narrative-tui model explorer", () => {
  it("loads the current versioned narrative model fixture", async () => {
    const model = await loadFixture();

    expect(model.schemaVersion).toBe(NARRATIVE_MODEL_SCHEMA_VERSION);
    expect(typeof model.producerVersion).toBe("string");
    expect(model.projectionPolicyVersion).toBe(NARRATIVE_PROJECTION_POLICY_VERSION);
    expect(model.projectionMode).toBe(NARRATIVE_PROJECTION_MODE);
    expect(model.summary.freshnessCounts).toEqual({
      fresh: 4,
      suspect: 4,
      stale: 2,
    });
    expect(model.summary.validationCounts).toEqual({
      verified: 5,
      attention: 3,
      unverified: 2,
    });
  });

  it("builds a default view with the first visible thread selected", async () => {
    const model = await loadFixture();
    const state: ExplorerState = {
      query: "",
      scope: "all",
      selectedThreadId: null,
      selectedIntentId: null,
      selectedEventId: null,
    };

    const view = buildExplorerView(model, state);

    expect(view.empty).toBe(false);
    expect(view.visibleThreads.length).toBe(2);
    expect(view.selectedThread?.threadId).toBe("thread_1");
    expect(view.detail.kind).toBe("thread");
    expect(view.selectedThread?.freshnessStatus).toBe("suspect");
    expect(view.selectedThread?.validationStatus).toBe("attention");
    expect(buildThreadOptionDescription(view.selectedThread!, true)).toContain("freshness:suspect");
    expect(buildThreadOptionDescription(view.selectedThread!, true)).toContain("validation:attention");
    expect(buildValidationSummary(
      view.selectedThread!.validationStatus,
      view.selectedThread!.validationReasonCodes,
      view.selectedThread!.validationEvidenceRefs,
      view.selectedThread!.validationRecommendedActions,
    )).toContain("validation: attention");
    expect(view.detail.extra.join("\n")).toContain("freshness: suspect");
    expect(view.detail.extra.join("\n")).toContain("validation: attention");
    expect(view.detail.extra.join("\n")).not.toContain("nodeIds:");
    expect(view.detail.extra.join("\n")).not.toContain("threadIds:");
  });

  it("filters threads by query when the scope targets decision threads", async () => {
    const model = await loadFixture();
    const state: ExplorerState = {
      query: "viewer rollout",
      scope: "threads",
      selectedThreadId: null,
      selectedIntentId: null,
      selectedEventId: null,
    };

    const view = buildExplorerView(model, state);

    expect(view.visibleThreads.map((thread) => thread.threadId)).toEqual(["thread_2"]);
    expect(view.selectedThread?.threadId).toBe("thread_2");
  });

  it("switches detail focus to the selected intent or event item", async () => {
    const model = await loadFixture();
    const intentState: ExplorerState = {
      query: "",
      scope: "all",
      selectedThreadId: "thread_1",
      selectedIntentId: "artifact_3",
      selectedEventId: null,
    };

    const intentView = buildExplorerView(model, intentState);
    expect(intentView.detail.kind).toBe("intent");
    expect(intentView.detail.title).toContain("Viewer must read sanitized JSON only");
    expect(intentView.detail.freshnessStatus).toBe("suspect");
    expect(intentView.detail.validationStatus).toBe("attention");
    expect(buildIntentOptionDescription(intentView.assignedIntentItems[0]!, true)).toContain("freshness:fresh");
    expect(buildIntentOptionDescription(intentView.assignedIntentItems[0]!, true)).toContain("validation:verified");
    expect(buildValidationBadgeLabel(intentView.detail.validationStatus)).toBe("[attention]");
    expect(intentView.detail.extra.join("\n")).toContain("freshness: suspect");
    expect(intentView.detail.extra.join("\n")).toContain("validation: attention");

    const eventState: ExplorerState = {
      query: "",
      scope: "all",
      selectedThreadId: "thread_2",
      selectedIntentId: null,
      selectedEventId: "event_2",
    };

    const eventView = buildExplorerView(model, eventState);
    expect(eventView.detail.kind).toBe("event");
    expect(eventView.detail.title).toContain("security.admission");
  });

  it("computes linked intent and event relationships from the selected thread", async () => {
    const model = await loadFixture();
    const [threadOne] = buildThreadViews(model);
    const view = buildExplorerView(model, {
      query: "",
      scope: "all",
      selectedThreadId: "thread_1",
      selectedIntentId: null,
      selectedEventId: null,
    });

    expect(threadOne.threadId).toBe("thread_1");
    expect(isIntentLinkedToThread(threadOne, view.assignedIntentItems[0]!)).toBe(true);
    expect(isEventLinkedToThread(threadOne, view.timelineEvents[0]!)).toBe(true);
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

    expect(legacy.schemaVersion).toBe(NARRATIVE_MODEL_SCHEMA_VERSION);
    expect(legacy.producerVersion).toBe(NARRATIVE_MODEL_LEGACY_PRODUCER_VERSION);
    expect(legacy.projectionPolicyVersion).toBe(NARRATIVE_PROJECTION_POLICY_VERSION);
    expect(legacy.projectionMode).toBe(NARRATIVE_PROJECTION_MODE);
    expect(legacy.summary.freshnessCounts).toEqual({
      fresh: 0,
      suspect: 0,
      stale: 0,
    });
    expect(legacy.summary.validationCounts).toEqual({
      verified: 0,
      attention: 0,
      unverified: 0,
    });
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

    await expect(loadNarrativeModel(unsupportedPath)).rejects.toThrow(/Unsupported narrative projectionPolicyVersion=2/);
  });
});
