import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { runIngest } from "../src/core/ingest.js";
import { loadSnapshotManifest } from "../src/core/manifest.js";

const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("ingest integration", () => {
  it(
    "indexes only changed docs with --since",
    async () => {
      const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-test-"));
      git(temp, ["init"]);
      git(temp, ["config", "user.email", "ragit@example.com"]);
      git(temp, ["config", "user.name", "ragit-test"]);

      await mkdir(path.join(temp, "docs"), { recursive: true });
      await writeFile(
        path.join(temp, "docs", "plan.md"),
        `---
type: plan
---
# 실행계획
초기 계획`,
        "utf8",
      );
      git(temp, ["add", "."]);
      git(temp, ["commit", "-m", "init"]);
      const baseSha = git(temp, ["rev-parse", "HEAD"]);

      await runIngest(temp, { all: true });

      await writeFile(
        path.join(temp, "docs", "cache.spec.md"),
        `---
type: spec
---
# 상세 명세
cache adapter`,
        "utf8",
      );
      await writeFile(
        path.join(temp, "docs", "runtime.pbd.md"),
        `---
type: pbd
---
# PBD
phase and binding documents`,
        "utf8",
      );
      git(temp, ["add", "."]);
      git(temp, ["commit", "-m", "add spec and pbd"]);

      const summary = await runIngest(temp, { since: baseSha });
      expect(summary.processed).toBe(2);
      const manifest = await loadSnapshotManifest(temp, summary.commitSha);
      const types = new Set(manifest.docs.map((doc) => doc.docType));
      expect(types.has("plan")).toBe(true);
      expect(types.has("spec")).toBe(true);
      expect(types.has("pbd")).toBe(true);
    },
    15_000,
  );
});
