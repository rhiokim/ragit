import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { formatRagitLogText, runRagitLog } from "../src/core/log.js";
import { runIngest } from "../src/core/ingest.js";

const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("ragit log integration", () => {
  it(
    "summarizes snapshot-centered semantic history and can reveal missing commits",
    async () => {
      const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-log-"));
      git(temp, ["init"]);
      git(temp, ["config", "user.email", "ragit@example.com"]);
      git(temp, ["config", "user.name", "ragit-test"]);

      await mkdir(path.join(temp, "docs"), { recursive: true });
      await writeFile(
        path.join(temp, "docs", "auth-boundary.adr.md"),
        `---
type: adr
---
# Auth Boundary
Keep refresh mutation outside snapshot writes.
`,
        "utf8",
      );
      await writeFile(
        path.join(temp, "docs", "auth-api.spec.md"),
        `---
type: spec
---
# Auth API
Initial auth API contract.
`,
        "utf8",
      );
      await writeFile(path.join(temp, "notes.txt"), "seed\n", "utf8");
      git(temp, ["add", "."]);
      git(temp, ["commit", "-m", "seed docs"]);
      const seedSha = git(temp, ["rev-parse", "HEAD"]);

      await runInit(temp, { nonInteractive: true });
      await runIngest(temp, { all: true });

      await writeFile(path.join(temp, "notes.txt"), "missing snapshot\n", "utf8");
      git(temp, ["add", "notes.txt"]);
      git(temp, ["commit", "-m", "notes only"]);
      const missingSha = git(temp, ["rev-parse", "HEAD"]);

      await writeFile(
        path.join(temp, "docs", "auth-api.spec.md"),
        `---
type: spec
---
# Auth API
Updated auth API contract with recall-aware packet guidance.
`,
        "utf8",
      );
      await writeFile(
        path.join(temp, "docs", "rollout.plan.md"),
        `---
type: plan
---
# Rollout Plan
Ship recall-friendly auth changes in two phases.
`,
        "utf8",
      );
      git(temp, ["add", "."]);
      git(temp, ["commit", "-m", "update spec and add plan"]);
      const updateSha = git(temp, ["rev-parse", "HEAD"]);

      await runIngest(temp, { since: missingSha });

      await rm(path.join(temp, "docs", "auth-boundary.adr.md"));
      git(temp, ["add", "-A"]);
      git(temp, ["commit", "-m", "remove old adr"]);
      const deleteSha = git(temp, ["rev-parse", "HEAD"]);

      await runIngest(temp, { since: updateSha });

      const indexedOnly = await runRagitLog(temp);
      expect(indexedOnly.entries.map((entry) => entry.commitSha)).toEqual([deleteSha, updateSha, seedSha]);

      const deletedEntry = indexedOnly.entries[0];
      expect(deletedEntry.snapshot.delta.deleted).toBe(1);
      expect(deletedEntry.snapshot.changed.some((item) => item.status === "D" && item.path === "docs/auth-boundary.adr.md")).toBe(true);

      const updatedEntry = indexedOnly.entries[1];
      expect(updatedEntry.snapshot.previousSnapshotSha).toBe(seedSha);
      expect(updatedEntry.snapshot.delta.added).toBeGreaterThanOrEqual(1);
      expect(updatedEntry.snapshot.delta.modified).toBeGreaterThanOrEqual(1);
      expect(updatedEntry.snapshot.changed.some((item) => item.status === "A" && item.docType === "plan")).toBe(true);
      expect(updatedEntry.snapshot.changed.some((item) => item.status === "M" && item.path === "docs/auth-api.spec.md")).toBe(true);

      const seedEntry = indexedOnly.entries[2];
      expect(seedEntry.snapshot.delta.added).toBeGreaterThanOrEqual(2);
      expect(seedEntry.snapshot.delta.modified).toBe(0);
      expect(seedEntry.snapshot.delta.deleted).toBe(0);

      const withMissing = await runRagitLog(temp, { showMissing: true });
      expect(withMissing.entries.map((entry) => entry.commitSha)).toEqual([deleteSha, updateSha, missingSha, seedSha]);
      expect(withMissing.entries[2].snapshot.status).toBe("missing");

      const filtered = await runRagitLog(temp, { docType: "spec", path: "docs/auth*.md" });
      const filteredUpdate = filtered.entries.find((entry) => entry.commitSha === updateSha);
      expect(filteredUpdate?.snapshot.types).toEqual({ spec: 1 });
      expect(filteredUpdate?.snapshot.changed).toHaveLength(1);
      expect(filteredUpdate?.snapshot.changed[0]).toMatchObject({
        status: "M",
        docType: "spec",
        path: "docs/auth-api.spec.md",
      });

      const text = formatRagitLogText(indexedOnly, "default");
      expect(text).toContain("Semantic delta:");
      expect(text).toContain("modified=1");
      expect(text).toContain("A docs/rollout.plan.md [plan]");
    },
    25_000,
  );
});
