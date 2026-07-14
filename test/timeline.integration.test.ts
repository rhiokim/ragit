import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runStatus } from "../src/commands/bootstrap.js";
import { loadArtifactRecord, reviewArtifacts, sessionMaterialize } from "../src/core/artifacts.js";
import { queryTimeline } from "../src/core/event-ledger.js";
import { captureHarness, promoteHarness, runHarness } from "../src/core/harness.js";
import { runIngest } from "../src/core/ingest.js";
import { promoteMemory, runMemoryWrap } from "../src/core/memory.js";
import { runInit } from "../src/commands/init.js";

const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const sha1 = (...parts: string[]): string => createHash("sha1").update(parts.join(":")).digest("hex");
const harnessArtifactId = (kind: string, goal: string, title: string): string => `art_harness_${kind}_${sha1(kind, goal, title).slice(0, 16)}`;

describe("timeline integration", () => {
  it(
    "records append-only collaboration events and supports kind/session filters",
    async () => {
      const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-timeline-"));
      git(temp, ["init"]);
      git(temp, ["config", "user.email", "ragit@example.com"]);
      git(temp, ["config", "user.name", "ragit-test"]);
      await writeFile(
        path.join(temp, "README.md"),
        `---
type: spec
---
# Auth Flow
Keep recall packets small and structured.
`,
        "utf8",
      );
      await writeFile(
        path.join(temp, "run-harness-case.mjs"),
        `const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
process.stdout.write(JSON.stringify({ status: "ok", summary: payload.case.title + ": open loops and next actions" }));
process.exit(0);
`,
        "utf8",
      );
      git(temp, ["add", "."]);
      git(temp, ["commit", "-m", "init"]);

      await runInit(temp, { nonInteractive: true });
      git(temp, ["add", "-A"]);
      git(temp, ["commit", "-m", "initialize ragit"]);
      const initialIngest = await runIngest(temp, { all: true });

      const materialized = await sessionMaterialize(temp, {
        goal: "resume auth migration",
        episode: { id: "ep-auth-refresh" },
        relatedPaths: ["README.md"],
        createdAt: "2026-04-10T09:00:00.000Z",
        turns: [
          {
            turnId: "turn-1",
            role: "user",
            content: "Please keep answers concise.",
            createdAt: "2026-04-10T09:00:00.000Z",
          },
          {
            turnId: "turn-2",
            role: "user",
            content: "Do not mutate snapshot contracts while fixing auth.",
            createdAt: "2026-04-10T09:01:00.000Z",
          },
        ],
      });

      const feedbackArtifactId = materialized.artifactIds.find((artifactId) => artifactId.includes("_feedback_"));
      expect(feedbackArtifactId).toBeTruthy();
      await reviewArtifacts(temp, {
        updates: [
          {
            artifactId: feedbackArtifactId!,
            nextStatus: "reviewed",
            reason: "confirmed by user preference",
          },
        ],
      });

      await runMemoryWrap(temp, {
        goal: "resume auth migration",
        summary: "Need to resume auth work with current constraints.",
        constraints: ["keep snapshot contracts intact"],
        decisions: [],
        openLoops: [
          {
            id: "loop-1",
            title: "Finalize refresh-token boundary",
            status: "open",
            nextAction: "Patch auth spec",
          },
        ],
        nextActions: ["Patch auth spec"],
        promotionCandidates: [],
        episode: { id: "ep-auth-refresh" },
        artifactRefs: [feedbackArtifactId!],
      });

      await promoteMemory(temp, {
        sourceSessionId: materialized.sessionId,
        artifactRefs: [feedbackArtifactId!],
        promotionCandidates: [
          {
            kind: "decision",
            title: "use recall packets",
            summary: "Recall packets should restore active work instead of replaying raw logs.",
          },
        ],
      });

      const harnessGoal = "resume auth migration";
      const oracleId = harnessArtifactId("oracle", harnessGoal, "resume packet oracle");
      const captured = await captureHarness(temp, {
        goal: "resume auth migration",
        episodeId: "ep-auth-refresh",
        sourceSessionId: materialized.sessionId,
        resources: [
          {
            kind: "oracle",
            title: "resume packet oracle",
            expected: { jsonSubset: { status: "ok" } },
          },
          {
            kind: "case",
            title: "resume after token expiry",
            input: { prompt: "resume auth flow after token expired" },
            expected: { mustInclude: ["open loops", "next actions"] },
            oracleRefs: [oracleId],
            evidenceRefs: ["evid-1"],
          },
        ],
      });

      const harnessRun = await runHarness(temp, {
        suiteRef: captured.suiteId,
        executor: {
          kind: "command",
          argv: [process.execPath, "run-harness-case.mjs"],
        },
      });
      expect(harnessRun.summary.passed).toBe(1);

      await reviewArtifacts(temp, {
        updates: captured.artifactIds.map((artifactId) => ({
          artifactId,
          nextStatus: "reviewed" as const,
        })),
      });

      const promoteInput = {
        artifactRefs: captured.artifactIds.filter((artifactId) => !artifactId.includes("_suite_")),
      };
      const promotedHarness = await promoteHarness(temp, promoteInput);
      expect(promotedHarness.createdFiles.length).toBeGreaterThan(0);

      const timeline = await queryTimeline(temp, { maxCount: 50 });
      expect(timeline.events.some((event) => event.eventType === "session.materialize")).toBe(true);
      expect(timeline.events.some((event) => event.eventType === "artifact.review")).toBe(true);
      expect(timeline.events.some((event) => event.eventType === "memory.wrap")).toBe(true);
      expect(timeline.events.some((event) => event.eventType === "memory.promote")).toBe(true);
      expect(timeline.events.some((event) => event.eventType === "harness.capture")).toBe(true);
      expect(timeline.events.some((event) => event.eventType === "harness.run")).toBe(true);
      expect(timeline.events.some((event) => event.eventType === "harness.promote")).toBe(true);
      expect(timeline.events.some((event) => event.eventType === "ingest.completed")).toBe(true);

      const sessionOnlyTimeline = await queryTimeline(temp, { sessionId: materialized.sessionId, maxCount: 20 });
      expect(sessionOnlyTimeline.events.length).toBeGreaterThan(0);
      expect(sessionOnlyTimeline.events.every((event) => event.sessionId === materialized.sessionId)).toBe(true);

      const memoryOnly = await queryTimeline(temp, { kind: "memory", maxCount: 10 });
      expect(memoryOnly.events.length).toBeGreaterThan(0);
      expect(memoryOnly.events.every((event) => event.eventType.startsWith("memory."))).toBe(true);

      const feedbackArtifact = await loadArtifactRecord(temp, feedbackArtifactId!);
      expect(feedbackArtifact?.status).toBe("reviewed");
      expect(initialIngest.boundArtifactIds).toEqual([]);

      const status = await runStatus(temp);
      expect(status.events.eventCount).toBeGreaterThan(0);
      expect(status.events.latestEpisodeId).toBe("ep-auth-refresh");
      expect(status.events.latestSessionId).toBe(materialized.sessionId);
    },
    25_000,
  );

  it("does not write ledger events for dry-run paths", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-timeline-dry-run-"));
    git(temp, ["init"]);
    git(temp, ["config", "user.email", "ragit@example.com"]);
    git(temp, ["config", "user.name", "ragit-test"]);
    await writeFile(path.join(temp, "README.md"), "# dry run\n", "utf8");
    git(temp, ["add", "."]);
    git(temp, ["commit", "-m", "init"]);

    await runInit(temp, { nonInteractive: true });
    git(temp, ["add", "-A"]);
    git(temp, ["commit", "-m", "initialize ragit"]);
    await runIngest(temp, { all: true, dryRun: true });
    await sessionMaterialize(
      temp,
      {
        goal: "dry run session",
        turns: [
          {
            turnId: "turn-1",
            role: "user",
            content: "Please keep answers concise.",
            createdAt: "2026-04-10T10:00:00.000Z",
          },
        ],
      },
      true,
    );
    await runMemoryWrap(
      temp,
      {
        goal: "dry run session",
        summary: "No writes expected.",
        constraints: [],
        decisions: [],
        openLoops: [],
        nextActions: [],
        promotionCandidates: [],
      },
      true,
    );

    const timeline = await queryTimeline(temp);
    expect(timeline.summary.eventCount).toBe(0);
  });
});
