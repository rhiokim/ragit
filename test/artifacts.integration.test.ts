import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runStatus } from "../src/commands/bootstrap.js";
import {
  listArtifactRecords,
  loadArtifactRecord,
  normalizeArtifactReviewInput,
  reviewArtifacts,
  sessionMaterialize,
} from "../src/core/artifacts.js";
import { runIngest } from "../src/core/ingest.js";
import { recallMemory, runMemoryWrap } from "../src/core/memory.js";
import { searchKnowledge } from "../src/core/retrieval.js";
import { runInit } from "../src/commands/init.js";

const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("artifacts integration", () => {
  it(
    "materializes redacted session artifacts, keeps ids stable, and exposes reviewed session scope",
    async () => {
      const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-artifacts-"));
      git(temp, ["init"]);
      git(temp, ["config", "user.email", "ragit@example.com"]);
      git(temp, ["config", "user.name", "ragit-test"]);
      await writeFile(path.join(temp, "README.md"), "# auth memory\n\nrestore active work quickly.\n", "utf8");
      git(temp, ["add", "."]);
      git(temp, ["commit", "-m", "init"]);

      await runInit(temp, { nonInteractive: true });
      await runIngest(temp, { all: true });

      const input = {
        goal: "resume auth migration",
        episode: { id: "ep-auth-refresh", title: "Auth refresh stabilization" },
        relatedPaths: ["README.md"],
        createdAt: "2026-04-09T10:00:00.000Z",
        turns: [
          {
            turnId: "turn-1",
            role: "user" as const,
            content: "Please keep answers concise. token=sk-abcdefghijklmnopqrstuvwxyz123456",
            createdAt: "2026-04-09T10:00:00.000Z",
          },
          {
            turnId: "turn-2",
            role: "user" as const,
            content: "Do not mutate snapshot contracts while fixing auth.",
            createdAt: "2026-04-09T10:01:00.000Z",
          },
          {
            turnId: "turn-3",
            role: "assistant" as const,
            content: "The key insight is recall packets should restore active work.",
            createdAt: "2026-04-09T10:02:00.000Z",
          },
          {
            turnId: "turn-4",
            role: "user" as const,
            content: "Next action is patch the auth spec?",
            createdAt: "2026-04-09T10:03:00.000Z",
          },
        ],
        toolTraces: [
          {
            traceId: "trace-1",
            title: "auth test run",
            command: "pnpm test auth",
            error: "Error: token refresh regression",
            createdAt: "2026-04-09T10:03:30.000Z",
          },
        ],
      };

      const first = await sessionMaterialize(temp, input);
      const second = await sessionMaterialize(temp, input);

      expect(second.artifactIds).toEqual(first.artifactIds);

      const transcript = await readFile(path.join(temp, first.transcriptPath), "utf8");
      expect(transcript).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
      expect(transcript).toContain("sk-a***");

      const artifacts = await listArtifactRecords(temp);
      expect(new Set(artifacts.map((artifact) => artifact.artifactId)).size).toBe(artifacts.length);
      expect(artifacts.some((artifact) => artifact.kind === "feedback")).toBe(true);
      expect(artifacts.some((artifact) => artifact.kind === "constraint")).toBe(true);
      expect(artifacts.some((artifact) => artifact.kind === "insight")).toBe(true);
      expect(artifacts.some((artifact) => artifact.kind === "openLoop")).toBe(true);
      expect(artifacts.some((artifact) => artifact.kind === "failure")).toBe(true);

      const feedback = artifacts.find((artifact) => artifact.kind === "feedback");
      expect(feedback).toBeTruthy();

      await reviewArtifacts(temp, {
        updates: [{ artifactId: feedback!.artifactId, nextStatus: "reviewed", reason: "confirmed by user feedback" }],
      });
      const reviewed = await loadArtifactRecord(temp, feedback!.artifactId);
      expect(reviewed?.status).toBe("reviewed");

      await runIngest(temp, { all: true, scope: "all" });

      const durableOnly = await searchKnowledge(temp, "keep answers concise", { topK: 5 });
      expect(durableOnly.hits.every((hit) => hit.originType !== "artifact")).toBe(true);

      const sessionOnly = await searchKnowledge(temp, "keep answers concise", { topK: 5, scope: "session" });
      expect(sessionOnly.hits.some((hit) => hit.artifactId === feedback!.artifactId)).toBe(true);

      await runMemoryWrap(temp, {
        goal: "resume auth migration",
        summary: "Need to resume auth work with current constraints.",
        constraints: ["keep snapshot contracts intact"],
        decisions: [],
        openLoops: [],
        nextActions: ["Run recall before coding"],
        promotionCandidates: [],
      });

      const recall = await recallMemory(temp, "resume auth migration");
      expect(recall.packet.retrievedHits.some((hit) => hit.originType === "artifact")).toBe(true);

      const status = await runStatus(temp);
      expect(status.knowledge.sessionArtifactCount).toBe(artifacts.length);
      expect(status.knowledge.harnessArtifactCount).toBe(0);
      expect(status.knowledge.pendingBindings).toBe(0);

      expect(() =>
        normalizeArtifactReviewInput({
          updates: [{ artifactId: feedback!.artifactId, nextStatus: "promoted" }],
        }),
      ).toThrow(/nextStatus/);
    },
    20_000,
  );

  it(
    "binds pending session artifacts after the first successful ingest with HEAD",
    async () => {
      const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-artifacts-pending-"));
      git(temp, ["init"]);
      git(temp, ["config", "user.email", "ragit@example.com"]);
      git(temp, ["config", "user.name", "ragit-test"]);
      await writeFile(path.join(temp, "README.md"), "# pending binding\n", "utf8");

      await runInit(temp, { nonInteractive: true });

      const materialized = await sessionMaterialize(temp, {
        goal: "bootstrap without head",
        relatedPaths: ["README.md"],
        createdAt: "2026-04-09T11:00:00.000Z",
        turns: [
          {
            turnId: "turn-1",
            role: "user",
            content: "Please keep this blocker visible.",
            createdAt: "2026-04-09T11:00:00.000Z",
          },
        ],
      });

      const artifactBefore = await loadArtifactRecord(temp, materialized.artifactIds[0]);
      expect(artifactBefore?.bindingStatus).toBe("pending");
      expect(artifactBefore?.boundHeadSha).toBeNull();

      git(temp, ["add", "."]);
      git(temp, ["commit", "-m", "bootstrap"]);

      const ingest = await runIngest(temp, { all: true });
      expect(ingest.boundArtifactIds).toContain(materialized.artifactIds[0]);

      const artifactAfter = await loadArtifactRecord(temp, materialized.artifactIds[0]);
      expect(artifactAfter?.bindingStatus).toBe("bound");
      expect(artifactAfter?.boundHeadSha).toBe(ingest.commitSha);
    },
    15_000,
  );
});
