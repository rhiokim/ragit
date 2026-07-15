import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { runMemoryWrap } from "../src/core/memory.js";
import { runIngest } from "../src/core/ingest.js";

const REPO_ROOT = process.cwd();

const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const runCli = (args: string[]): string =>
  execFileSync("pnpm", ["exec", "tsx", "src/cli-entry.ts", ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }).trim();

describe("CLI machine contract", () => {
  it(
    "normalizes init cwd to the git root in JSON output",
    async () => {
      const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-cli-init-root-"));
      git(temp, ["init"]);
      const nested = path.join(temp, "apps", "docs");
      await mkdir(nested, { recursive: true });
      const expectedRoot = git(nested, ["rev-parse", "--show-toplevel"]);

      const initOutput = JSON.parse(runCli(["init", "--cwd", nested, "--yes", "--output", "json"]));

      expect(initOutput.command).toBe("init");
      expect(initOutput.ok).toBe(true);
      expect(initOutput.cwd).toBe(expectedRoot);
      expect(initOutput.data.executionMode).toBe("non-interactive");
      expect(initOutput.data.bootstrap.agents.path).toBe("AGENTS.md");
    },
    15_000,
  );

  it(
    "emits JSON envelopes for describe, log, timeline, narrative, drift, repair, security, query, context pack, memory recall, and status",
    async () => {
      const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-cli-contract-"));
      git(temp, ["init"]);
      git(temp, ["config", "user.email", "ragit@example.com"]);
      git(temp, ["config", "user.name", "ragit-test"]);

      await mkdir(path.join(temp, "docs"), { recursive: true });
      await writeFile(
        path.join(temp, "docs", "auth.adr.md"),
        `---
type: adr
---
# Auth Boundaries
Keep refresh token mutation outside snapshot-bound retrieval.`,
        "utf8",
      );
      await writeFile(
        path.join(temp, "docs", "memory.plan.md"),
        `---
type: plan
---
# Memory Plan
Recall packets should restore active work instead of replaying raw logs.`,
        "utf8",
      );
      git(temp, ["add", "."]);
      git(temp, ["commit", "-m", "seed docs"]);

      await runInit(temp, { nonInteractive: true });
      git(temp, ["add", "-A"]);
      git(temp, ["commit", "-m", "initialize ragit"]);
      const headSha = git(temp, ["rev-parse", "HEAD"]);
      await runIngest(temp, { all: true });
      await runMemoryWrap(temp, {
        goal: "resume auth flow",
        summary: "Need to resume auth work with current constraints.",
        constraints: ["keep snapshot contracts intact"],
        decisions: [
          {
            id: "decision-1",
            title: "Use recall packets",
            summary: "Restore active work instead of replaying raw logs.",
          },
        ],
        openLoops: [
          {
            id: "loop-1",
            title: "Finalize refresh-token boundary",
            status: "open",
            nextAction: "Review auth ADR and patch docs",
          },
        ],
        nextActions: ["Run recall before coding"],
        promotionCandidates: [],
      });

      await writeFile(path.join(temp, "query.json"), JSON.stringify({ question: "restore active work", topK: 2, explain: true }, null, 2), "utf8");
      await writeFile(path.join(temp, "context-pack.json"), JSON.stringify({ goal: "resume auth flow", budget: 80 }, null, 2), "utf8");
      const nestedQueryCwd = path.join(temp, "packages", "app");
      await mkdir(nestedQueryCwd, { recursive: true });

      const describeOutput = JSON.parse(runCli(["describe", "query", "--format", "json"]));
      expect(describeOutput.command).toBe("describe");
      expect(describeOutput.ok).toBe(true);
      expect(describeOutput.data.spec.path).toBe("query");
      expect(describeOutput.data.spec.supportsRawJsonInput).toBe(true);
      expect(describeOutput.data.spec.outputSchemaSummary).toContain("snapshot");
      expect(describeOutput.data.spec.outputSchemaSummary).toContain("hits[].citation");
      expect(describeOutput.data.spec.outputSchemaSummary).toContain("hits[].scoreBreakdown (when explain=true)");
      expect(describeOutput.data.spec.options.some((option: { name: string }) => option.name === "--explain")).toBe(true);

      const describeIngestOutput = JSON.parse(runCli(["describe", "ingest", "--format", "json"]));
      expect(describeIngestOutput.data.spec.outputSchemaSummary).toContain("dirtyCandidates");
      expect(describeIngestOutput.data.spec.outputSchemaSummary).toContain("wouldFail");

      const describeContextOutput = JSON.parse(runCli(["describe", "context", "pack", "--format", "json"]));
      expect(describeContextOutput.data.spec.outputSchemaSummary).toContain("snapshot");
      expect(describeContextOutput.data.spec.outputSchemaSummary).toContain("selection.strategy");
      expect(describeContextOutput.data.spec.outputSchemaSummary).toContain("selection.uniqueCitations");
      const contextBudgetOption = describeContextOutput.data.spec.options.find((option: { name: string }) => option.name === "--budget");
      expect(contextBudgetOption.description).toContain("양의 안전한 정수");
      expect(contextBudgetOption.description).toContain("공백 구분 콘텐츠 단위");

      const describeRecallOutput = JSON.parse(runCli(["describe", "memory", "recall", "--format", "json"]));
      expect(describeRecallOutput.data.spec.outputSchemaSummary).toContain("snapshot");

      const describeStatusOutput = JSON.parse(runCli(["describe", "status", "--format", "json"]));
      expect(describeStatusOutput.data.spec.outputSchemaSummary).toContain("snapshot");

      const describeLogOutput = JSON.parse(runCli(["describe", "log", "--format", "json"]));
      expect(describeLogOutput.command).toBe("describe");
      expect(describeLogOutput.ok).toBe(true);
      expect(describeLogOutput.data.spec.path).toBe("log");
      expect(describeLogOutput.data.spec.options.some((option: { name: string }) => option.name === "--show-missing")).toBe(true);

      const describeTimelineOutput = JSON.parse(runCli(["describe", "timeline", "--format", "json"]));
      expect(describeTimelineOutput.command).toBe("describe");
      expect(describeTimelineOutput.ok).toBe(true);
      expect(describeTimelineOutput.data.spec.path).toBe("timeline");
      expect(describeTimelineOutput.data.spec.options.some((option: { name: string }) => option.name === "--kind")).toBe(true);

      const describeNarrativeOutput = JSON.parse(runCli(["describe", "narrative", "--format", "json"]));
      expect(describeNarrativeOutput.command).toBe("describe");
      expect(describeNarrativeOutput.ok).toBe(true);
      expect(describeNarrativeOutput.data.spec.path).toBe("narrative");
      expect(describeNarrativeOutput.data.spec.options.some((option: { name: string }) => option.name === "--open")).toBe(true);
      expect(describeNarrativeOutput.data.spec.options.some((option: { name: string }) => option.name === "--emit-model")).toBe(true);
      expect(describeNarrativeOutput.data.spec.outputSchemaSummary).toContain("schemaVersion");
      expect(describeNarrativeOutput.data.spec.outputSchemaSummary).toContain("projectionPolicyVersion");
      expect(describeNarrativeOutput.data.spec.outputSchemaSummary).toContain("projectionMode");
      expect(describeNarrativeOutput.data.spec.outputSchemaSummary).toContain("summary.freshnessCounts.fresh");
      expect(describeNarrativeOutput.data.spec.outputSchemaSummary).toContain("summary.freshnessCounts.suspect");
      expect(describeNarrativeOutput.data.spec.outputSchemaSummary).toContain("summary.freshnessCounts.stale");
      expect(describeNarrativeOutput.data.spec.outputSchemaSummary).toContain("summary.validationCounts.verified");
      expect(describeNarrativeOutput.data.spec.outputSchemaSummary).toContain("summary.validationCounts.attention");
      expect(describeNarrativeOutput.data.spec.outputSchemaSummary).toContain("summary.validationCounts.unverified");

      const describeDriftOutput = JSON.parse(runCli(["describe", "drift", "--format", "json"]));
      expect(describeDriftOutput.command).toBe("describe");
      expect(describeDriftOutput.ok).toBe(true);
      expect(describeDriftOutput.data.spec.path).toBe("drift");
      expect(describeDriftOutput.data.spec.options.some((option: { name: string }) => option.name === "--scope")).toBe(true);

      const describeRepairOutput = JSON.parse(runCli(["describe", "repair", "--format", "json"]));
      expect(describeRepairOutput.command).toBe("describe");
      expect(describeRepairOutput.ok).toBe(true);
      expect(describeRepairOutput.data.spec.path).toBe("repair");
      expect(describeRepairOutput.data.spec.options.some((option: { name: string }) => option.name === "--apply")).toBe(true);
      const repairAction = describeRepairOutput.data.spec.options.find((option: { name: string }) => option.name === "--action");
      expect(repairAction.enum).toEqual(expect.arrayContaining(["ingest-recover", "store-rebuild"]));
      expect(describeRepairOutput.data.spec.relatedCommands).toEqual(expect.arrayContaining(["ingest", "migrate embeddings"]));
      expect(describeRepairOutput.data.spec.examples).toEqual(expect.arrayContaining([
        "ragit repair --apply --action ingest-recover --format json",
        "ragit repair --apply --action store-rebuild --format json",
      ]));
      const rebuildRepairOutput = JSON.parse(runCli(["repair", "--action", "store-rebuild", "--cwd", temp, "--format", "json"]));
      expect(rebuildRepairOutput.command).toBe("repair");
      expect(rebuildRepairOutput.ok).toBe(true);
      expect(rebuildRepairOutput.data.mode).toBe("plan");
      expect(rebuildRepairOutput.data.plannedActions).toEqual([
        expect.objectContaining({ action: "store-rebuild", status: "planned" }),
      ]);
      const rebuildRepairText = runCli(["repair", "--action", "store-rebuild", "--cwd", temp, "--format", "text"]);
      expect(rebuildRepairText).toContain("store-rebuild");

      const describeSecurityAuditOutput = JSON.parse(runCli(["describe", "security", "audit", "--format", "json"]));
      expect(describeSecurityAuditOutput.command).toBe("describe");
      expect(describeSecurityAuditOutput.ok).toBe(true);
      expect(describeSecurityAuditOutput.data.spec.path).toBe("security audit");

      const describeSecurityPurgeOutput = JSON.parse(runCli(["describe", "security", "purge", "--format", "json"]));
      expect(describeSecurityPurgeOutput.command).toBe("describe");
      expect(describeSecurityPurgeOutput.ok).toBe(true);
      expect(describeSecurityPurgeOutput.data.spec.path).toBe("security purge");
      expect(describeSecurityPurgeOutput.data.spec.supportsDryRun).toBe(true);

      const describeHarnessRunOutput = JSON.parse(runCli(["describe", "harness", "run", "--format", "json"]));
      expect(describeHarnessRunOutput.command).toBe("describe");
      expect(describeHarnessRunOutput.ok).toBe(true);
      expect(describeHarnessRunOutput.data.spec.path).toBe("harness run");
      expect(describeHarnessRunOutput.data.spec.supportsDryRun).toBe(true);

      const describeDocOutput = JSON.parse(runCli(["describe", "doc", "create", "--format", "json"]));
      expect(describeDocOutput.command).toBe("describe");
      expect(describeDocOutput.ok).toBe(true);
      expect(describeDocOutput.data.spec.path).toBe("doc create");
      expect(describeDocOutput.data.spec.options.some((option: { name: string }) => option.name === "--type")).toBe(true);

      const queryOutput = JSON.parse(
        runCli(["query", "--input", "query.json", "--cwd", nestedQueryCwd, "--format", "json", "--view", "minimal"]),
      );
      expect(queryOutput.command).toBe("query");
      expect(queryOutput.ok).toBe(true);
      expect(queryOutput.version).toBeTruthy();
      expect(queryOutput.cwd).toBe(git(nestedQueryCwd, ["rev-parse", "--show-toplevel"]));
      expect(queryOutput.data.snapshotSha).toBe(headSha);
      expect(queryOutput.data.snapshot).toMatchObject({
        requestedRef: "HEAD",
        resolvedSha: headSha,
        selection: "head-exact",
        status: "indexed",
        detached: false,
      });
      expect(queryOutput.data.hits[0].excerpt).toBeTruthy();
      expect(queryOutput.data.hits[0].scope).toBe("durable");
      expect(queryOutput.data.hits[0].text).toBeUndefined();
      expect(queryOutput.data.explain).toBe(true);
      expect(queryOutput.data.hits[0].citation.id).toMatch(/^cite-[a-f0-9]{24}$/);
      expect(queryOutput.data.hits[0].scoreBreakdown.mode).toMatch(/^(hybrid|keyword)$/);
      expect(queryOutput.warnings).toEqual(queryOutput.data.warnings);
      expect(() => runCli(["query", "--input", "query.json", "--explain", "--cwd", temp, "--format", "json"])).toThrow(
        "--input과 positional/도메인 옵션을 함께 사용할 수 없습니다",
      );
      const positionalExplainedOutput = JSON.parse(
        runCli(["query", "restore active work", "--explain", "--cwd", temp, "--format", "json"]),
      );
      expect(positionalExplainedOutput.data.explain).toBe(true);
      expect(positionalExplainedOutput.data.hits[0].scoreBreakdown).toBeTruthy();
      const defaultQueryOutput = JSON.parse(
        runCli(["query", "restore active work", "--cwd", temp, "--format", "json"]),
      );
      expect(defaultQueryOutput.data.explain).toBe(false);
      expect(defaultQueryOutput.data.hits[0].citation.id).toMatch(/^cite-[a-f0-9]{24}$/);
      expect(defaultQueryOutput.data.hits[0].scoreBreakdown).toBeUndefined();
      const queryTextOutput = runCli([
        "query",
        "restore active work",
        "--cwd",
        temp,
        "--format",
        "text",
      ]);
      expect(queryTextOutput).toContain(`- resolved_sha: ${headSha}`);
      expect(queryTextOutput).toContain("- selection: head-exact");
      expect(queryTextOutput).toContain("- worktree_dirty: true");

      const contextOutput = JSON.parse(
        runCli(["context", "pack", "--input", "context-pack.json", "--cwd", temp, "--format", "json", "--view", "minimal"]),
      );
      expect(contextOutput.command).toBe("context pack");
      expect(contextOutput.ok).toBe(true);
      expect(contextOutput.data.goal).toBe("resume auth flow");
      expect(contextOutput.data.snapshotSha).toBe(headSha);
      expect(contextOutput.data.snapshot.resolvedSha).toBe(headSha);
      expect(contextOutput.data.selectedHits).toBeGreaterThan(0);
      expect(contextOutput.data.selection.strategy).toBe("citation-diverse-v2");
      expect(contextOutput.data.selection.candidateHits).toBe(
        contextOutput.data.selection.uniqueCitations + contextOutput.data.selection.duplicateCitationsSkipped,
      );
      expect(contextOutput.data.selection.uniqueCitations).toBe(
        contextOutput.data.selectedHits + contextOutput.data.selection.budgetRejectedHits,
      );
      expect(contextOutput.data.hits[0].citation.id).toMatch(/^cite-[a-f0-9]{24}$/);
      expect(contextOutput.data.hits[0].scoreBreakdown).toBeUndefined();
      expect(contextOutput.warnings).toEqual(contextOutput.data.warnings);
      const noFitContextOutput = JSON.parse(
        runCli(["context", "pack", "resume auth flow", "--budget", "1", "--cwd", temp, "--format", "json"]),
      );
      expect(noFitContextOutput.data.hits).toEqual([]);
      expect(noFitContextOutput.data.usedTokens).toBe(0);
      expect(noFitContextOutput.data.selectedHits).toBe(0);
      expect(noFitContextOutput.data.warnings).toContain("context pack budget admitted no complete hit");
      expect(noFitContextOutput.warnings).toEqual(noFitContextOutput.data.warnings);
      const contextTextOutput = runCli([
        "context",
        "pack",
        "resume auth flow",
        "--cwd",
        temp,
        "--format",
        "text",
      ]);
      expect(contextTextOutput).toContain(`- resolved_sha: ${headSha}`);
      expect(contextTextOutput).toContain("- status: indexed");
      expect(contextTextOutput).toContain("- selection_strategy: citation-diverse-v2");
      expect(contextTextOutput).toMatch(/- candidate_hits: \d+/);
      expect(contextTextOutput).toMatch(/- unique_citations: \d+/);
      expect(contextTextOutput).toMatch(/- selected_sources: \d+/);
      expect(contextTextOutput).toMatch(/- duplicate_citations_skipped: \d+/);
      expect(contextTextOutput).toMatch(/- budget_rejected_hits: \d+/);

      const recallOutput = JSON.parse(
        runCli(["memory", "recall", "resume auth flow", "--cwd", temp, "--format", "json", "--view", "minimal"]),
      );
      expect(recallOutput.command).toBe("memory recall");
      expect(recallOutput.ok).toBe(true);
      expect(recallOutput.data.openLoops[0].title).toContain("refresh-token");
      expect(recallOutput.data.retrievedHits[0].excerpt).toBeTruthy();
      expect(recallOutput.data.snapshotSha).toBe(headSha);
      expect(recallOutput.data.snapshot).toMatchObject({
        requestedRef: "HEAD",
        resolvedSha: headSha,
        selection: "head-exact",
        status: "indexed",
        detached: false,
        worktreeDirty: true,
      });
      const recallTextOutput = runCli([
        "memory",
        "recall",
        "resume auth flow",
        "--cwd",
        temp,
        "--format",
        "text",
      ]);
      expect(recallTextOutput).toContain("- snapshot_status: indexed");
      expect(recallTextOutput).toContain(`- snapshot_sha: ${headSha}`);
      expect(recallTextOutput).toContain("- branch:");
      expect(recallTextOutput).toContain("- detached: false");
      expect(recallTextOutput).toContain("- worktree_dirty: true");

      const logOutput = JSON.parse(runCli(["log", "--cwd", temp, "--format", "json", "--view", "default", "--max-count", "3"]));
      expect(logOutput.command).toBe("log");
      expect(logOutput.ok).toBe(true);
      expect(logOutput.data.entries[0].snapshot.status).toBe("indexed");
      expect(logOutput.data.entries[0].snapshot.changed).toBeTruthy();
      expect(logOutput.data.entries[0].semantic).toBeTruthy();
      expect(logOutput.data.entries[0].semantic.counts).toBeTruthy();

      const timelineOutput = JSON.parse(runCli(["timeline", "--cwd", temp, "--format", "json", "--kind", "memory", "--max-count", "5"]));
      expect(timelineOutput.command).toBe("timeline");
      expect(timelineOutput.ok).toBe(true);
      expect(timelineOutput.data.summary.eventCount).toBeGreaterThan(0);
      expect(timelineOutput.data.events.every((event: { eventType: string }) => event.eventType.startsWith("memory."))).toBe(true);
      expect(timelineOutput.data.events.every((event: { semantic?: unknown }) => event.semantic === undefined)).toBe(true);

      const narrativeOutput = JSON.parse(
        runCli([
          "narrative",
          "--cwd",
          temp,
          "--format",
          "json",
          "--dry-run",
          "--open",
          "--emit-model",
          ".ragit/reports/narrative/model.json",
        ]),
      );
      expect(narrativeOutput.command).toBe("narrative");
      expect(narrativeOutput.ok).toBe(true);
      expect(narrativeOutput.data.dryRun).toBe(true);
      expect(narrativeOutput.data.reportPath).toContain(".ragit/reports/narrative/");
      expect(narrativeOutput.data.modelPath).toBe(".ragit/reports/narrative/model.json");
      expect(narrativeOutput.data.schemaVersion).toBe(1);
      expect(narrativeOutput.data.projectionPolicyVersion).toBe(1);
      expect(narrativeOutput.data.projectionMode).toBe("viewer-safe");
      expect(Array.isArray(narrativeOutput.data.window.selectedSnapshotShas)).toBe(true);
      expect(narrativeOutput.data.summary).toBeTruthy();
      expect(narrativeOutput.data.summary.freshnessCounts).toBeTruthy();
      expect(narrativeOutput.data.summary.validationCounts).toBeTruthy();
      expect(
        narrativeOutput.data.summary.freshnessCounts.fresh +
          narrativeOutput.data.summary.freshnessCounts.suspect +
          narrativeOutput.data.summary.freshnessCounts.stale,
      ).toBeGreaterThan(0);
      expect(
        narrativeOutput.data.summary.validationCounts.verified +
          narrativeOutput.data.summary.validationCounts.attention +
          narrativeOutput.data.summary.validationCounts.unverified,
      ).toBeGreaterThan(0);
      const narrativeTextOutput = runCli(["narrative", "--cwd", temp, "--dry-run", "--format", "text"]);
      expect(narrativeTextOutput).toContain("validation_counts: verified=");
      expect(narrativeOutput.warnings.some((warning: string) => warning.includes("--open"))).toBe(true);

      const driftOutput = JSON.parse(runCli(["drift", "--cwd", temp, "--format", "json", "--scope", "all", "--view", "default"]));
      expect(driftOutput.command).toBe("drift");
      expect(driftOutput.ok).toBe(true);
      expect(driftOutput.data.overallStatus).toBeTruthy();
      expect(driftOutput.data.counts).toBeTruthy();
      expect(Array.isArray(driftOutput.data.items)).toBe(true);

      const repairOutput = JSON.parse(runCli(["repair", "--cwd", temp, "--format", "json", "--scope", "all", "--view", "default"]));
      expect(repairOutput.command).toBe("repair");
      expect(repairOutput.ok).toBe(true);
      expect(repairOutput.data.mode).toBe("plan");
      expect(repairOutput.data.summary).toBeTruthy();
      expect(Array.isArray(repairOutput.data.plannedActions)).toBe(true);
      expect(repairOutput.data.drift).toBeTruthy();

      const securityAuditOutput = JSON.parse(runCli(["security", "audit", "--cwd", temp, "--format", "json"]));
      expect(securityAuditOutput.command).toBe("security audit");
      expect(securityAuditOutput.ok).toBe(true);
      expect(securityAuditOutput.data.summary).toBeTruthy();
      expect(securityAuditOutput.data.providerEgress).toBeTruthy();
      expect(Array.isArray(securityAuditOutput.data.findings)).toBe(true);

      const securityPurgeOutput = JSON.parse(
        runCli(["security", "purge", "--cwd", temp, "--target", "control-plane", "--dry-run", "--format", "json"]),
      );
      expect(securityPurgeOutput.command).toBe("security purge");
      expect(securityPurgeOutput.ok).toBe(true);
      expect(securityPurgeOutput.data.mode).toBe("dry-run");
      expect(securityPurgeOutput.data.target).toBe("control-plane");
      expect(Array.isArray(securityPurgeOutput.data.planned)).toBe(true);

      const statusOutput = JSON.parse(runCli(["status", "--cwd", temp, "--format", "json"]));
      expect(statusOutput.command).toBe("status");
      expect(statusOutput.ok).toBe(true);
      expect(statusOutput.data.snapshot).toMatchObject({
        requestedRef: "HEAD",
        resolvedSha: headSha,
        selection: "head-exact",
        status: "indexed",
        detached: false,
        worktreeDirty: true,
      });
      expect(statusOutput.data.zvec.searchReady).toBe(true);
      expect(statusOutput.data.runtime).toMatchObject({
        node: {
          minimum: "22.14.0",
          supported: true,
        },
        platform: {
          current: `${process.platform}/${process.arch}`,
          supported: true,
          supportedTargets: ["darwin/arm64", "linux/arm64"],
        },
        supported: true,
      });
      expect(statusOutput.data.events.eventCount).toBeGreaterThan(0);
      expect(statusOutput.data.embedding.cache).toBeTruthy();
      expect(typeof statusOutput.data.embedding.cache.entryCount).toBe("number");
      expect(statusOutput.data.security).toBeTruthy();

      const statusTextOutput = runCli(["status", "--cwd", temp, "--format", "text"]);
      expect(statusTextOutput).toContain(`- head: ${headSha}`);
      expect(statusTextOutput).toContain("- snapshot_requested_ref: HEAD");
      expect(statusTextOutput).toContain(`- snapshot_resolved_sha: ${headSha}`);
      expect(statusTextOutput).toContain("- snapshot_selection: head-exact");
      expect(statusTextOutput).toContain("- snapshot_status: indexed");
      expect(statusTextOutput).toContain("- snapshot_detached: false");
      expect(statusTextOutput).toContain("- snapshot_worktree_dirty: true");

      git(temp, ["checkout", "--detach", headSha]);
      const detachedStatusTextOutput = runCli(["status", "--cwd", temp, "--format", "text"]);
      expect(detachedStatusTextOutput).toContain("- branch: none");
      expect(detachedStatusTextOutput).toContain(`- head: ${headSha}`);
    },
    90_000,
  );

  it("renders an unborn status HEAD as none in text output", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-cli-status-unborn-"));
    git(temp, ["init", "-b", "main"]);

    const statusTextOutput = runCli(["status", "--cwd", temp, "--format", "text"]);

    expect(statusTextOutput).toContain("- head: none");
    expect(statusTextOutput).toContain("- snapshot_resolved_sha: none");
    expect(statusTextOutput).toContain("- snapshot_status: missing");
  });
});
