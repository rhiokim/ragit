import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseToml } from "../src/core/config.js";
import { loadLatestSessionWrap, loadOpenLoopRegistry, loadWorkingMemoryState, recallMemory, runMemoryWrap } from "../src/core/memory.js";

describe("memory core", () => {
  it("parses memory config section", () => {
    const config = parseToml(`
[memory]
corpus_dir = "knowledge/memory"
session_dir = ".ragit/memory/sessions"
working_dir = ".ragit/memory/working"
auto_ingest_promotions = false
recall_top_k = 12
`);
    expect(config.memory.corpus_dir).toBe("knowledge/memory");
    expect(config.memory.auto_ingest_promotions).toBe(false);
    expect(config.memory.recall_top_k).toBe(12);
  });

  it("writes session and working memory state", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-memory-wrap-"));
    const result = await runMemoryWrap(temp, {
      goal: "stabilize memory os",
      summary: "Persist current implementation context",
      constraints: ["keep snapshot contracts"],
      decisions: [
        {
          id: "d1",
          title: "Add memory as separate domain",
          summary: "Keep existing retrieval contracts intact",
        },
      ],
      openLoops: [
        {
          id: "o1",
          title: "Implement recall packet",
          status: "open",
          nextAction: "Wire recall output into CLI",
        },
      ],
      nextActions: ["Add memory CLI commands"],
      promotionCandidates: [],
    });

    const latest = await loadLatestSessionWrap(temp);
    const current = await loadWorkingMemoryState(temp);
    const registry = await loadOpenLoopRegistry(temp);

    expect(result.sessionId).toBeTruthy();
    expect(result.warnings[0]).toContain("HEAD commit");
    expect(latest?.goal).toBe("stabilize memory os");
    expect(current?.latestSessionId).toBe(result.sessionId);
    expect(current?.openLoops[0]?.title).toBe("Implement recall packet");
    expect(registry?.items).toHaveLength(1);
  });

  it("assembles recall packet from working memory without snapshots", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-memory-recall-"));
    await runMemoryWrap(temp, {
      goal: "resume auth refactor",
      summary: "Track open loops before indexing exists",
      constraints: ["do not change query contracts"],
      decisions: [
        {
          id: "d1",
          title: "Use additive memory commands",
          summary: "Keep query/context pack intact and add memory subcommands",
        },
      ],
      openLoops: [
        {
          id: "o1",
          title: "Add promote flow",
          status: "blocked",
          nextAction: "Define promotion candidate schema",
          blockingConditions: ["Need document renderer"],
        },
      ],
      nextActions: ["Implement docs/memory writer"],
      promotionCandidates: [],
    });

    const result = await recallMemory(temp, "resume auth refactor");
    expect(result.packet.goal).toBe("resume auth refactor");
    expect(result.packet.openLoops[0]?.status).toBe("blocked");
    expect(result.packet.relatedDecisions[0]?.title).toBe("Use additive memory commands");
    expect(result.packet.retrievedHits).toHaveLength(0);
    expect(result.packet.warnings[0]).toContain("working memory만으로 복원");
    expect(result.markdown).toContain("ragit memory recall");
  });
});
