import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reviewArtifacts, sessionMaterialize } from "../src/core/artifacts.js";
import { defaultConfig, loadConfig, writeConfig } from "../src/core/config.js";
import { runDoctor, runStatus } from "../src/commands/bootstrap.js";
import { queryTimeline } from "../src/core/event-ledger.js";
import { captureHarness, promoteHarness, runHarness } from "../src/core/harness.js";
import { runIngest } from "../src/core/ingest.js";
import { promoteMemory, runMemoryWrap } from "../src/core/memory.js";
import { ensureRagitStructure, resolveRagitPaths } from "../src/core/project.js";
import { runSecurityAudit, runSecurityPurge } from "../src/core/security.js";
import { runInit } from "../src/commands/init.js";

const tempDirs: string[] = [];

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const sha1 = (...parts: string[]): string => createHash("sha1").update(parts.join(":")).digest("hex");
const harnessArtifactId = (kind: string, goal: string, title: string): string =>
  `art_harness_${kind}_${sha1(kind, goal, title).slice(0, 16)}`;

const makeTempDir = async (prefix: string): Promise<string> => {
  const temp = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(temp);
  return temp;
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0, tempDirs.length).map((target) => rm(target, { recursive: true, force: true })));
});

describe("security integration", () => {
  it(
    "sanitizes session, memory, and harness write paths before they reach control-plane state",
    async () => {
      const temp = await makeTempDir("ragit-security-sanitize-");
      git(temp, ["init"]);
      git(temp, ["config", "user.email", "ragit@example.com"]);
      git(temp, ["config", "user.name", "ragit-test"]);

      await mkdir(path.join(temp, "docs"), { recursive: true });
      await writeFile(
        path.join(temp, "docs", "auth.spec.md"),
        `---
type: spec
---
# Auth Contract
Never persist raw callback tokens.
`,
        "utf8",
      );
      await writeFile(
        path.join(temp, "run-harness-security.mjs"),
        `process.stdout.write(JSON.stringify({
  status: "ok",
  summary: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.segment",
  secret: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ12"
}));
process.exit(0);
`,
        "utf8",
      );
      git(temp, ["add", "."]);
      git(temp, ["commit", "-m", "seed security fixtures"]);

      await runInit(temp, { nonInteractive: true });
      const initializedConfig = await loadConfig(temp);
      expect(initializedConfig.security.admission_mode).toBe("enforce");

      const materialized = await sessionMaterialize(temp, {
        goal: "resume auth hardening",
        turns: [
          {
            turnId: "t1",
            role: "user",
            content: "Please keep sk-abcdefghijklmnopqrstuvwxyz123456 out of searchable memory.",
            createdAt: "2026-04-10T10:00:00.000Z",
          },
        ],
        toolTraces: [
          {
            traceId: "trace-1",
            title: "curl callback?access_token=abcdef1234567890",
            command: "curl https://alice:supersecret@example.com/callback?access_token=abcdef1234567890",
            output: "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.segment",
            error: "secret=super-secret-value",
            createdAt: "2026-04-10T10:00:01.000Z",
          },
        ],
        relatedPaths: ["docs/auth.spec.md"],
        createdAt: "2026-04-10T10:00:02.000Z",
      });
      expect(materialized.admission.blocked).toBeGreaterThan(0);

      const transcript = await readFile(path.join(temp, materialized.transcriptPath), "utf8");
      expect(transcript).not.toContain("supersecret@example.com");
      expect(transcript).not.toContain("super-secret-value");
      expect(transcript).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
      expect(transcript).toContain("***");
      expect(transcript).toContain("[BLOCKED BY RAGIT ADMISSION CONTROL]");

      const wrap = await runMemoryWrap(temp, {
        goal: "resume auth hardening",
        summary: "Secret token=super-secret-value must not leak into memory state.",
        constraints: ["Do not expose Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.segment"],
        decisions: [
          {
            id: "decision-security",
            title: "Mask secrets before persistence",
            summary: "Persist only redacted knowledge state.",
          },
        ],
        openLoops: [
          {
            id: "loop-security",
            title: "Verify redaction",
            status: "open",
            nextAction: "Audit .ragit state before release",
          },
        ],
        nextActions: ["Review audit output"],
        promotionCandidates: [],
      });
      expect(wrap.admission.quarantined).toBeGreaterThan(0);

      const currentMemory = await readFile(path.join(temp, wrap.currentPath), "utf8");
      expect(currentMemory).not.toContain("super-secret-value");
      expect(currentMemory).not.toContain("payload.segment");
      expect(currentMemory).toContain("***");

      const goal = "validate harness security";
      const oracleId = harnessArtifactId("oracle", goal, "security oracle");
      const captured = await captureHarness(temp, {
        goal,
        sourceSessionId: "session-security",
        resources: [
          {
            kind: "oracle",
            title: "security oracle",
            summary: "Harness output should stay valid after redaction.",
            expected: {
              jsonSubset: { status: "ok" },
            },
          },
          {
            kind: "case",
            title: "security case",
            input: { prompt: "validate redaction handling" },
            oracleRefs: [oracleId],
            evidenceRefs: ["evid-security"],
          },
        ],
      });
      expect(captured.admission.allowed).toBeGreaterThan(0);

      const harnessRun = await runHarness(temp, {
        suiteRef: captured.suiteId,
        executor: {
          kind: "command",
          argv: [process.execPath, "run-harness-security.mjs"],
          env: {
            API_TOKEN: "super-secret-value",
          },
        },
      });
      expect(harnessRun.admission.quarantined).toBeGreaterThan(0);

      const runRecord = await readFile(path.join(temp, harnessRun.runPath!), "utf8");
      expect(runRecord).not.toContain("super-secret-value");
      expect(runRecord).not.toContain("ABCDEFGHIJKLMNOPQRSTUVWXYZ12");
      expect(runRecord).toContain("API_TOKEN");
      expect(runRecord).not.toContain("\"env\":");
      expect(runRecord).not.toContain("Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.segment");
      expect(runRecord).not.toContain("\"stdoutExcerpt\": \"[BLOCKED BY RAGIT ADMISSION CONTROL]\"");

      await expect(
        promoteMemory(temp, {
          sourceSessionId: materialized.sessionId,
          promotionCandidates: [
            {
              kind: "decision",
              title: "blocked promotion candidate",
              summary: "Promotion should refuse raw high-risk content.",
              consequences: ["-----BEGIN PRIVATE KEY-----"],
            },
          ],
        }),
      ).rejects.toThrow(/memory promote 문서를 차단/);

      const harnessGoal = "blocked harness promote";
      const blockedCaptured = await captureHarness(temp, {
        goal: harnessGoal,
        sourceSessionId: "session-blocked-harness",
        resources: [
          {
            kind: "oracle",
            title: "blocked oracle",
            summary: "-----BEGIN PRIVATE KEY-----",
            expected: { jsonSubset: { status: "ok" } },
          },
        ],
      });
      expect(blockedCaptured.admission.blocked).toBeGreaterThan(0);
      await reviewArtifacts(temp, {
        updates: blockedCaptured.artifactIds.map((artifactId) => ({
          artifactId,
          nextStatus: "reviewed" as const,
        })),
      });
      const promotedHarness = await promoteHarness(temp, {
        artifactRefs: blockedCaptured.artifactIds,
      });
      expect(promotedHarness.admission.blocked).toBe(0);
      expect(promotedHarness.createdFiles.length).toBeGreaterThan(0);

      const audit = await runSecurityAudit(temp);
      expect(audit.findings.filter((finding) => finding.surface === "control-plane")).toHaveLength(0);
      expect(audit.findings.filter((finding) => finding.surface === "store")).toHaveLength(0);
      expect(audit.summary.admissionBlocked).toBeGreaterThan(0);

      const timeline = await queryTimeline(temp, { kind: "security" });
      expect(timeline.events.some((event) => event.eventType === "security.admission")).toBe(true);

      const status = await runStatus(temp);
      expect(status.security.admissionMode).toBe("enforce");
      expect(status.security.admissionBlockedEntries).toBeGreaterThan(0);

      const doctor = await runDoctor(temp);
      const admissionModeCheck = doctor.checks.find((check) => check.name === "security.admission-mode");
      const admissionRecentBlockedCheck = doctor.checks.find((check) => check.name === "security.admission-recent-blocked");
      expect(admissionModeCheck?.ok).toBe(true);
      expect(admissionRecentBlockedCheck?.ok).toBe(false);
    },
    25_000,
  );

  it("fails closed for apply writes when secret masking is disabled but still allows dry-run", async () => {
    const temp = await makeTempDir("ragit-security-fail-closed-");
    git(temp, ["init"]);
    git(temp, ["config", "user.email", "ragit@example.com"]);
    git(temp, ["config", "user.name", "ragit-test"]);
    await mkdir(path.join(temp, "docs"), { recursive: true });
    await writeFile(
      path.join(temp, "docs", "auth.spec.md"),
      `---
type: spec
---
# Auth Contract
Keep snapshot contracts stable.
`,
      "utf8",
    );
    git(temp, ["add", "."]);
    git(temp, ["commit", "-m", "seed docs"]);

    await ensureRagitStructure(temp);
    const config = defaultConfig();
    config.security.secret_masking = false;
    await writeConfig(temp, config);

    await expect(runIngest(temp, { all: true, dryRun: true })).resolves.toBeTruthy();
    await expect(runIngest(temp, { all: true })).rejects.toThrow(/security\.secret_masking=true/);
  });

  it("audits legacy unsafe control-plane state and purges it without touching repo docs", async () => {
    const temp = await makeTempDir("ragit-security-audit-");
    git(temp, ["init"]);
    git(temp, ["config", "user.email", "ragit@example.com"]);
    git(temp, ["config", "user.name", "ragit-test"]);
    await mkdir(path.join(temp, "docs"), { recursive: true });
    await writeFile(
      path.join(temp, "docs", "auth.spec.md"),
      `---
type: spec
---
# Auth Contract
token=repo-doc-secret
`,
      "utf8",
    );
    git(temp, ["add", "."]);
    git(temp, ["commit", "-m", "seed docs"]);

    await ensureRagitStructure(temp);
    const paths = resolveRagitPaths(temp);
    await mkdir(paths.transcriptDir, { recursive: true });
    await mkdir(paths.memoryWorkingDir, { recursive: true });
    await writeFile(
      path.join(paths.transcriptDir, "legacy.jsonl"),
      `${JSON.stringify({ content: "token=super-secret-value" })}\n`,
      "utf8",
    );
    await writeFile(
      path.join(paths.memoryWorkingDir, "current.json"),
      `${JSON.stringify({ summary: "api_key: super-secret-value" }, null, 2)}\n`,
      "utf8",
    );

    const dryRun = await runSecurityPurge(temp, "control-plane", true);
    expect(dryRun.mode).toBe("dry-run");
    const transcriptBefore = await readFile(path.join(paths.transcriptDir, "legacy.jsonl"), "utf8");
    expect(transcriptBefore).toContain("super-secret-value");

    const auditBefore = await runSecurityAudit(temp);
    expect(auditBefore.findings.some((finding) => finding.surface === "control-plane")).toBe(true);
    expect(auditBefore.findings.some((finding) => finding.surface === "repo-doc")).toBe(true);

    const apply = await runSecurityPurge(temp, "control-plane", false);
    expect(apply.rewritten.length).toBeGreaterThan(0);

    const transcriptAfter = await readFile(path.join(paths.transcriptDir, "legacy.jsonl"), "utf8");
    const currentAfter = await readFile(path.join(paths.memoryWorkingDir, "current.json"), "utf8");
    const repoDocAfter = await readFile(path.join(temp, "docs", "auth.spec.md"), "utf8");
    expect(transcriptAfter).not.toContain("super-secret-value");
    expect(currentAfter).not.toContain("super-secret-value");
    expect(repoDocAfter).toContain("repo-doc-secret");

    const auditAfter = await runSecurityAudit(temp);
    expect(auditAfter.findings.some((finding) => finding.surface === "control-plane")).toBe(false);
    expect(auditAfter.findings.some((finding) => finding.surface === "repo-doc")).toBe(true);
  });
});
