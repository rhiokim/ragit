import { describe, expect, it, vi } from "vitest";
import type { ContextPackResult } from "../src/core/context.js";
import {
  createReadCommandExecutor,
  type ReadCommandDependencies,
} from "../src/core/readCommands.js";
import {
  READ_ONLY_RETRIEVAL_POLICY,
  type QueryResult,
} from "../src/core/retrieval.js";
import { buildRetrievalCitation, buildRetrievalScoreBreakdown } from "../src/core/retrieval-explanation.js";
import type { RetrievalHit } from "../src/core/types.js";

const snapshot = {
  requestedRef: "HEAD",
  resolvedSha: "a".repeat(40),
  selection: "head-exact",
  status: "indexed",
  branch: "main",
  detached: false,
  worktreeDirty: false,
} as const;

const scoreBreakdown = buildRetrievalScoreBreakdown({
  mode: "hybrid",
  scoreVector: 0.8,
  scoreKeyword: 0.2,
  alpha: 0.7,
  authority: 1,
  recency: 1,
});

const hit: RetrievalHit = {
  chunkId: "chunk-auth",
  path: "docs/auth.spec.md",
  sectionTitle: "Auth",
  scoreVector: 0.8,
  scoreKeyword: 0.2,
  scoreFinal: scoreBreakdown.final,
  scoreBreakdown,
  citation: buildRetrievalCitation({
    sourceType: "document",
    sourceId: "chunk-auth",
    sourceVersion: "version-auth",
    sourceSha: "a".repeat(40),
  }),
  text: "Restore the authentication context.",
  scope: "durable",
  originType: "document",
};

const queryResult: QueryResult = {
  snapshotSha: "a".repeat(40),
  snapshot,
  hits: [hit],
  warnings: ["query warning"],
  redactionSummary: {
    applied: true,
    maskedCount: 2,
    sources: ["retrieval.hit"],
  },
};

const packet: ContextPackResult = {
  goal: "pack auth",
  snapshotSha: "a".repeat(40),
  snapshot,
  budget: 120,
  usedTokens: 4,
  selectedHits: 1,
  selection: {
    strategy: "citation-diverse-v2",
    candidateHits: 1,
    uniqueCitations: 1,
    selectedSources: 1,
    duplicateCitationsSkipped: 0,
    budgetRejectedHits: 0,
  },
  hits: [hit],
  warnings: ["context warning"],
  redactionSummary: { applied: false, maskedCount: 0, sources: [] },
};

const createDependencies = () => {
  const status = { marker: "status" } as unknown as Awaited<
    ReturnType<ReadCommandDependencies["runStatus"]>
  >;
  const dependencies: ReadCommandDependencies = {
    runStatus: vi.fn(async () => status),
    searchKnowledge: vi.fn(async () => queryResult),
    packContext: vi.fn(async () => packet),
  };
  return { dependencies, status };
};

describe("shared read command execution", () => {
  it("normalizes, sanitizes, merges, and projects query output with explain", async () => {
    const { dependencies } = createDependencies();
    const executor = createReadCommandExecutor(dependencies);
    const question = '  restore auth api_key: "super-secret-value"  ';

    const executed = await executor.query(
      "/repo",
      { question, topK: 3, scope: " DURABLE ", explain: true },
      { view: " MINIMAL ", executionPolicy: READ_ONLY_RETRIEVAL_POLICY },
    );

    expect(dependencies.searchKnowledge).toHaveBeenCalledWith(
      "/repo",
      question.trim(),
      {
        topK: 3,
        at: undefined,
        scope: "durable",
        executionPolicy: READ_ONLY_RETRIEVAL_POLICY,
      },
    );
    expect(executed.view).toBe("minimal");
    expect(executed.data.query).not.toContain("super-secret-value");
    expect(executed.data.explain).toBe(true);
    expect(executed.data.hits[0]?.citation).toEqual(hit.citation);
    expect(executed.data.hits[0]?.scoreBreakdown).toBeDefined();
    expect(executed.data.redactionSummary.maskedCount).toBeGreaterThan(queryResult.redactionSummary.maskedCount);
    expect(executed.data.redactionSummary.sources).toEqual(
      expect.arrayContaining(["query", "retrieval.hit"]),
    );
    expect(executed.result.redactionSummary).toEqual(executed.data.redactionSummary);
    expect(executed.warnings).toBe(queryResult.warnings);
  });

  it("normalizes and projects a context pack while forwarding policy identity", async () => {
    const { dependencies } = createDependencies();
    const executor = createReadCommandExecutor(dependencies);

    const executed = await executor.contextPack(
      "/repo",
      { goal: "  pack auth  ", budget: 120, scope: " ALL " },
      { view: " FULL ", executionPolicy: READ_ONLY_RETRIEVAL_POLICY },
    );

    expect(dependencies.packContext).toHaveBeenCalledWith("/repo", "pack auth", {
      budget: 120,
      at: undefined,
      scope: "all",
      executionPolicy: READ_ONLY_RETRIEVAL_POLICY,
    });
    expect(executed.view).toBe("full");
    expect(executed.data.hits[0]?.text).toBe(hit.text);
    expect(executed.warnings).toBe(packet.warnings);
  });

  it("returns status without projection or warnings", async () => {
    const { dependencies, status } = createDependencies();
    const executor = createReadCommandExecutor(dependencies);

    const executed = await executor.status("/repo");

    expect(dependencies.runStatus).toHaveBeenCalledWith("/repo");
    expect(executed.data).toBe(status);
    expect(executed.warnings).toEqual([]);
  });

  it("rejects unexpected fields through the existing normalizers", async () => {
    const { dependencies } = createDependencies();
    const executor = createReadCommandExecutor(dependencies);

    await expect(executor.query("/repo", { question: "auth", unexpected: true })).rejects.toThrow(/예상하지 못한 필드/);
    await expect(executor.contextPack("/repo", { goal: "auth", unexpected: true })).rejects.toThrow(/예상하지 못한 필드/);
    expect(dependencies.searchKnowledge).not.toHaveBeenCalled();
    expect(dependencies.packContext).not.toHaveBeenCalled();
  });
});
