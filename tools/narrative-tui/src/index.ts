import { readFile } from "node:fs/promises";
import path from "node:path";
import { BoxRenderable, createCliRenderer, TextRenderable } from "@opentui/core";

interface NarrativeModel {
  repoName: string;
  headSha: string;
  generatedAt: string;
  summary: {
    decisionThreads: number;
    decisionNodes: number;
    intentItems: number;
    timelineEvents: number;
    heuristicEdges: number;
  };
  window: {
    revRange: string | null;
    maxCommits: number;
    selectedSnapshotShas: string[];
    missingSnapshotCommits: number;
  };
  snapshots: Array<{
    commitSha: string;
    subject: string;
    authoredAt: string;
    shortSha: string;
  }>;
  threads: Array<{
    threadId: string;
    title: string;
    docType: string;
    docPaths: string[];
    snapshotShas: string[];
    nodeIds: string[];
  }>;
  intentItems: Array<{
    itemId: string;
    title: string;
    kind: string;
    status: string;
    summary: string;
    threadIds: string[];
  }>;
  unassignedIntentItems: Array<{
    itemId: string;
    title: string;
    kind: string;
    status: string;
    summary: string;
  }>;
  timelineEvents: Array<{
    eventId: string;
    eventType: string;
    recordedAt: string;
    summary: string;
    threadIds: string[];
  }>;
  warnings: string[];
  empty: boolean;
}

const parseArgs = (argv: string[]): { modelPath: string | null } => {
  let modelPath: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--model") {
      modelPath = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (value.startsWith("--model=")) {
      modelPath = value.slice("--model=".length) || null;
      continue;
    }
    if (value === "--help" || value === "-h") {
      modelPath = null;
      return { modelPath };
    }
    throw new Error(`Unsupported argument: ${value}`);
  }
  return { modelPath };
};

const loadModel = async (modelPath: string): Promise<NarrativeModel> => {
  const absolutePath = path.resolve(process.cwd(), modelPath);
  const content = await readFile(absolutePath, "utf8");
  const parsed = JSON.parse(content) as NarrativeModel;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Narrative model file did not contain an object.");
  }
  return parsed;
};

const formatList = (items: string[]): string => (items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- (none)");

const buildOverview = (model: NarrativeModel): string => {
  const snapshotCount = model.snapshots.length;
  const threadCount = model.threads.length;
  const intentCount = model.intentItems.length + model.unassignedIntentItems.length;
  const eventCount = model.timelineEvents.length;

  return [
    `${model.repoName} narrative explorer`,
    `HEAD: ${model.headSha}`,
    `Generated: ${model.generatedAt}`,
    "",
    `Decision threads: ${model.summary.decisionThreads}`,
    `Decision nodes: ${model.summary.decisionNodes}`,
    `Intent items: ${model.summary.intentItems}`,
    `Timeline events: ${model.summary.timelineEvents}`,
    `Heuristic edges: ${model.summary.heuristicEdges}`,
    "",
    `Snapshots (${snapshotCount}):`,
    formatList(model.snapshots.map((snapshot) => `${snapshot.shortSha} ${snapshot.subject}`)),
    "",
    `Threads (${threadCount}):`,
    formatList(model.threads.map((thread) => `${thread.title} [${thread.docType}]`)),
    "",
    `Intent items (${intentCount}):`,
    formatList(
      [
        ...model.intentItems.map((item) => `${item.kind} · ${item.title}`),
        ...model.unassignedIntentItems.map((item) => `${item.kind} · ${item.title} (unassigned)`),
      ],
    ),
    "",
    `Events (${eventCount}):`,
    formatList(model.timelineEvents.map((event) => `${event.eventType} · ${event.recordedAt}`)),
  ].join("\n");
};

const createPanel = (renderer: Awaited<ReturnType<typeof createCliRenderer>>, id: string, title: string, content: string): BoxRenderable => {
  const box = new BoxRenderable(renderer, {
    id,
    title,
    border: true,
    shouldFill: true,
    width: "100%",
  });
  const text = new TextRenderable(renderer, {
    id: `${id}-text`,
    content,
  });
  box.add(text);
  return box;
};

const renderModel = async (modelPath: string): Promise<void> => {
  const model = await loadModel(modelPath);
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    autoFocus: true,
    screenMode: "alternate-screen",
  });
  renderer.root.add(
    createPanel(
      renderer,
      "narrative-summary",
      "Narrative Summary",
      buildOverview(model),
    ),
  );
  renderer.root.add(
    createPanel(
      renderer,
      "narrative-controls",
      "Viewer Contract",
      [
        "Input: --model <path>",
        "Boundary: sanitized JSON only",
        "Source: ragit narrative --emit-model <path>",
        "No direct .ragit reads",
        "No git reads",
        "No root workspace coupling",
      ].join("\n"),
    ),
  );
  renderer.start();
  if (process.env.NARRATIVE_TUI_SMOKE === "1") {
    await new Promise((resolve) => setTimeout(resolve, 300));
    renderer.destroy();
  }
};

const main = async (): Promise<void> => {
  const { modelPath } = parseArgs(process.argv.slice(2));
  if (!modelPath) {
    console.error("Usage: bun run src/index.ts --model <path>");
    process.exitCode = 1;
    return;
  }
  await renderModel(modelPath);
};

await main();
