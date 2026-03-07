import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { promoteMemory } from "../src/core/memory.js";
import { searchKnowledge } from "../src/core/retrieval.js";

const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("memory integration", () => {
  it(
    "promotes candidates into searchable memory docs and ingests them immediately",
    async () => {
      const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-memory-promote-"));
      git(temp, ["init"]);
      git(temp, ["config", "user.email", "ragit@example.com"]);
      git(temp, ["config", "user.name", "ragit-test"]);
      await writeFile(path.join(temp, "README.md"), "# temp\n", "utf8");
      git(temp, ["add", "."]);
      git(temp, ["commit", "-m", "init"]);

      await runInit(temp, { nonInteractive: true });

      const result = await promoteMemory(temp, {
        sourceSessionId: "session-1",
        promotionCandidates: [
          {
            kind: "decision",
            title: "use recall packets",
            summary: "Recall packets should restore active work instead of replaying raw logs.",
            consequences: ["working memory remains compact"],
          },
          {
            kind: "glossary",
            title: "working memory",
            summary: "The active context packet that survives across sessions.",
            definition: "The active context packet that survives across sessions.",
          },
          {
            kind: "plan",
            title: "memory os rollout",
            summary: "Ship wrap, recall, and promote first.",
            milestones: ["Implement wrap", "Implement recall", "Implement promote"],
          },
        ],
      });

      expect(result.createdFiles).toHaveLength(3);
      expect(result.ingested).toBe(true);
      expect(result.createdFiles.some((entry) => entry.startsWith("docs/memory/decisions/"))).toBe(true);

      const query = await searchKnowledge(temp, "restore active work instead of replaying raw logs", { topK: 3 });
      expect(query.hits[0]?.path.startsWith("docs/memory/decisions/")).toBe(true);
    },
    15_000,
  );

  it("skips ingest with a warning when HEAD commit is missing", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-memory-nohead-"));
    git(temp, ["init"]);
    await runInit(temp, { nonInteractive: true });

    const result = await promoteMemory(temp, {
      sourceSessionId: "session-2",
      promotionCandidates: [
        {
          kind: "decision",
          title: "defer ingest without head",
          summary: "Promotion should still write docs even when HEAD is unavailable.",
        },
      ],
    });

    expect(result.createdFiles[0]).toMatch(/^docs\/memory\/decisions\//);
    expect(result.ingested).toBe(false);
    expect(result.warnings[0]).toContain("HEAD commit");
  });
});
