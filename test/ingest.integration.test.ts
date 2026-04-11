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
architecture_view: lld
---
# 상세 명세
cache adapter`,
        "utf8",
      );
      await writeFile(
        path.join(temp, "docs", "runtime.pbd.md"),
        `---
type: pbd
architecture_view: hld
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
      expect(manifest.docs.find((doc) => doc.path === "docs/runtime.pbd.md")?.docType).toBe("pbd");
    },
    15_000,
  );

  it(
    "skips blocked implicit docs, keeps include-based candidate resolution, and fails blocked explicit docs",
    async () => {
      const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-admission-ingest-"));
      git(temp, ["init"]);
      git(temp, ["config", "user.email", "ragit@example.com"]);
      git(temp, ["config", "user.name", "ragit-test"]);

      await mkdir(path.join(temp, "docs"), { recursive: true });
      await mkdir(path.join(temp, "notes"), { recursive: true });
      await mkdir(path.join(temp, "docs", "secrets"), { recursive: true });
      await writeFile(
        path.join(temp, "docs", "safe.spec.md"),
        `---
type: spec
---
# Safe
Only this document should be indexed.
`,
        "utf8",
      );
      await writeFile(
        path.join(temp, "docs", "secrets", "auth.md"),
        `---
type: spec
---
# Blocked
API_TOKEN=super-secret-value
PRIVATE_KEY=-----BEGIN PRIVATE KEY-----
`,
        "utf8",
      );
      await writeFile(
        path.join(temp, "notes", ".env.md"),
        `---
type: spec
---
# Outside include
Should not become an implicit ingest candidate.
`,
        "utf8",
      );
      git(temp, ["add", "."]);
      git(temp, ["commit", "-m", "seed admission fixtures"]);

      const implicit = await runIngest(temp, { all: true });
      expect(implicit.processed).toBe(1);
      expect(implicit.admission.blocked).toBe(1);
      expect(implicit.admission.items.some((item: (typeof implicit.admission.items)[number]) => item.sourceRef === "docs/secrets/auth.md")).toBe(true);
      expect(implicit.admission.items.some((item: (typeof implicit.admission.items)[number]) => item.sourceRef === "notes/.env.md")).toBe(false);

      const manifest = await loadSnapshotManifest(temp, implicit.commitSha);
      expect(manifest.docs.some((doc) => doc.path === "docs/safe.spec.md")).toBe(true);
      expect(manifest.docs.some((doc) => doc.path === "docs/secrets/auth.md")).toBe(false);
      expect(manifest.docs.some((doc) => doc.path === "notes/.env.md")).toBe(false);

      const explicitDryRun = await runIngest(temp, { paths: ["docs/secrets/auth.md"], dryRun: true });
      expect(explicitDryRun.admission.blocked).toBe(1);

      await expect(runIngest(temp, { paths: ["docs/secrets/auth.md"] })).rejects.toThrow(/explicit ingest 문서를 차단/);
    },
    15_000,
  );
});
