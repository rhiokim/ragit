import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reviewArtifacts, sessionMaterialize } from "../src/core/artifacts.js";
import { defaultConfig, parseToml, writeConfig } from "../src/core/config.js";
import { loadLatestSessionWrap, loadOpenLoopRegistry, loadWorkingMemoryState, recallMemory, runMemoryWrap } from "../src/core/memory.js";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_OPENAI_API_KEY === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = ORIGINAL_OPENAI_API_KEY;
});

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
    git(temp, ["init", "-b", "main"]);
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

    const materialized = await sessionMaterialize(temp, {
      goal: "resume auth refactor",
      createdAt: "2026-07-14T12:00:00.000Z",
      turns: [
        {
          turnId: "turn-1",
          role: "assistant",
          content: "Key insight: resume auth refactor uses the reviewed artifact keyword path.",
          createdAt: "2026-07-14T12:00:00.000Z",
        },
      ],
    });
    await reviewArtifacts(temp, {
      updates: materialized.artifactIds.map((artifactId) => ({
        artifactId,
        nextStatus: "reviewed" as const,
      })),
    });

    const config = defaultConfig();
    config.embedding.provider = "openai";
    delete config.embedding.dimensions;
    delete config.embedding.version;
    await writeConfig(temp, config);
    process.env.OPENAI_API_KEY = "test-key";
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      return new Response(
        JSON.stringify({ data: body.input.map(() => ({ embedding: Array(1536).fill(0.1) })) }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    globalThis.fetch = fetchSpy as typeof fetch;

    const result = await recallMemory(temp, "resume auth refactor");
    const artifactHit = result.packet.retrievedHits.find((hit) => hit.originType === "artifact");
    expect(result.packet.goal).toBe("resume auth refactor");
    expect(result.packet.openLoops[0]?.status).toBe("blocked");
    expect(result.packet.relatedDecisions[0]?.title).toBe("Use additive memory commands");
    expect(artifactHit).toMatchObject({
      scope: "session",
      originType: "artifact",
      scoreVector: 0,
    });
    expect(artifactHit?.scoreKeyword).toBeGreaterThan(0);
    expect(artifactHit?.citation.id).toMatch(/^cite-[a-f0-9]{24}$/);
    expect(artifactHit?.citation.sourceType).toBe("artifact");
    expect(artifactHit?.scoreBreakdown.mode).toBe("keyword");
    expect(artifactHit?.scoreBreakdown.retrieval.inputs.keyword.weight).toBe(1);
    expect(artifactHit?.scoreFinal).toBeCloseTo(artifactHit!.scoreBreakdown.final, 12);
    expect(result.packet.snapshotSha).toBeNull();
    expect(result.packet.snapshot).toEqual({
      requestedRef: "HEAD",
      resolvedSha: null,
      selection: "head-exact",
      status: "unavailable",
      branch: "main",
      detached: false,
      worktreeDirty: true,
    });
    expect(result.packet.warnings).toContainEqual(expect.stringContaining("SNAPSHOT_NOT_INDEXED"));
    expect(result.packet.warnings).toContainEqual(expect.stringContaining("working memory"));
    expect(result.packet.warnings).toContainEqual(expect.stringContaining("artifact-derived"));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.markdown).toContain("ragit memory recall");
    expect(result.markdown).toContain("- snapshot_status: unavailable");
    expect(result.markdown).toContain("- snapshot_sha: none");
    expect(result.markdown).toContain("- branch: main");
    expect(result.markdown).toContain("- detached: false");
    expect(result.markdown).toContain("- worktree_dirty: true");
    expect(JSON.parse(result.json).snapshot).toEqual(result.packet.snapshot);
  });
});
