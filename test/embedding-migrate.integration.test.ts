import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runDoctor, runStatus } from "../src/commands/bootstrap.js";
import { runInit } from "../src/commands/init.js";
import { writeConfig, loadConfig } from "../src/core/config.js";
import { runIngest } from "../src/core/ingest.js";
import { loadSnapshotManifest } from "../src/core/manifest.js";
import { migrateEmbeddings } from "../src/core/migrate.js";
import { searchKnowledge } from "../src/core/retrieval.js";
import { bootstrapCanonicalStore, closeCanonicalStore, readCanonicalStoreMeta } from "../src/core/store.js";

const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const createSeededRepo = async (prefix: string): Promise<{ temp: string; sha: string }> => {
  const temp = await mkdtemp(path.join(os.tmpdir(), prefix));
  git(temp, ["init"]);
  git(temp, ["config", "user.email", "ragit@example.com"]);
  git(temp, ["config", "user.name", "ragit-test"]);
  await mkdir(path.join(temp, "docs"), { recursive: true });
  await writeFile(path.join(temp, "README.md"), "# ragit temp\n", "utf8");
  await writeFile(
    path.join(temp, "docs", "auth.spec.md"),
    `---
type: spec
---
# Auth Contract
Token refresh must stay outside snapshot mutation.
`,
    "utf8",
  );
  git(temp, ["add", "."]);
  git(temp, ["commit", "-m", "seed docs"]);
  return {
    temp,
    sha: git(temp, ["rev-parse", "HEAD"]),
  };
};

describe("embedding migration", () => {
  it(
    "separates configured/store contracts and rebuilds the store without changing manifests",
    async () => {
      const { temp, sha } = await createSeededRepo("ragit-embeddings-");
      await runInit(temp, { nonInteractive: true });
      await runIngest(temp, { all: true });

      const manifestPath = path.join(temp, ".ragit", "manifest", `${sha}.json`);
      const manifestBefore = await readFile(manifestPath, "utf8");

      const config = await loadConfig(temp);
      config.embedding.dimensions = 32;
      config.embedding.version = "v2";
      await writeConfig(temp, config);

      const dryRun = await migrateEmbeddings(temp, true);
      expect(dryRun.mode).toBe("dry-run");
      expect(dryRun.migrationNeeded).toBe(true);
      expect(dryRun.currentContract?.dimensions).toBe(64);
      expect(dryRun.targetContract.dimensions).toBe(32);
      expect(dryRun.manifests).toBeGreaterThan(0);
      expect(dryRun.documents).toBeGreaterThan(0);
      expect(dryRun.chunks).toBeGreaterThan(0);

      const statusBefore = await runStatus(temp);
      expect(statusBefore.embedding.store?.dimensions).toBe(64);
      expect(statusBefore.embedding.configured.dimensions).toBe(32);
      expect(statusBefore.embedding.needsMigration).toBe(true);

      const doctorBefore = await runDoctor(temp);
      expect(doctorBefore.checks.find((check) => check.name === "embedding.migration-needed")?.ok).toBe(false);

      const applied = await migrateEmbeddings(temp, false);
      expect(applied.mode).toBe("apply");
      expect(applied.migrationNeeded).toBe(true);

      const manifestAfter = await readFile(manifestPath, "utf8");
      expect(manifestAfter).toBe(manifestBefore);

      const statusAfter = await runStatus(temp);
      expect(statusAfter.embedding.store?.dimensions).toBe(32);
      expect(statusAfter.embedding.store?.version).toBe("v2");
      expect(statusAfter.embedding.needsMigration).toBe(false);

      const result = await searchKnowledge(temp, "token refresh", { topK: 1 });
      expect(result.hits[0]?.path).toContain("docs/auth.spec.md");
    },
    20_000,
  );

  it(
    "fails fast when a manifest-referenced chunk is missing from the source store",
    async () => {
      const { temp, sha } = await createSeededRepo("ragit-embeddings-missing-");
      await runInit(temp, { nonInteractive: true });
      await runIngest(temp, { all: true });

      const manifest = await loadSnapshotManifest(temp, sha);
      const currentMeta = await readCanonicalStoreMeta(temp);
      expect(currentMeta).toBeTruthy();
      const store = await bootstrapCanonicalStore(temp, currentMeta!.embeddingContract, false);
      try {
        store.chunks.deleteSync(manifest.chunks[0]!.id);
      } finally {
        closeCanonicalStore(store);
      }

      const config = await loadConfig(temp);
      config.embedding.dimensions = 16;
      config.embedding.version = "v3";
      await writeConfig(temp, config);

      await expect(migrateEmbeddings(temp, false)).rejects.toThrow(/source store에서 찾을 수 없습니다/);
    },
    20_000,
  );
});
