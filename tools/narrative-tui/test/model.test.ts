import { describe, expect, it } from "bun:test";
import path from "node:path";
import {
  buildExplorerView,
  buildThreadViews,
  isEventLinkedToThread,
  isIntentLinkedToThread,
  loadNarrativeModel,
  type ExplorerState,
} from "../src/model";

const fixturePath = path.join(import.meta.dir, "..", "fixtures", "sample-model.json");

const loadFixture = async () => loadNarrativeModel(fixturePath);

describe("narrative-tui model explorer", () => {
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
});
