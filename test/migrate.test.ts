import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadSnapshotManifest } from "../src/core/manifest.js";
import { migrateFromSqliteVss } from "../src/core/migrate.js";

const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("sqlite-vss migration", () => {
  it("preserves spec and pbd doc types from legacy payload", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-migrate-"));
    git(temp, ["init"]);
    git(temp, ["config", "user.email", "ragit@example.com"]);
    git(temp, ["config", "user.name", "ragit-test"]);
    await writeFile(path.join(temp, "README.md"), "# temp\n", "utf8");
    git(temp, ["add", "."]);
    git(temp, ["commit", "-m", "init"]);
    const sha = git(temp, ["rev-parse", "HEAD"]);

    await mkdir(path.join(temp, ".ragit", "sqlite-vss"), { recursive: true });
    await writeFile(
      path.join(temp, ".ragit", "sqlite-vss", "export.json"),
      JSON.stringify(
        {
          docs: [
            {
              id: "spec-doc",
              path: "docs/cache.spec.md",
              docType: "spec",
              sections: [{ id: "s1", title: "Scope", level: 2, content: "cache scope" }],
            },
            {
              id: "pbd-doc",
              path: "docs/runtime.pbd.md",
              docType: "pbd",
              sections: [{ id: "p1", title: "Bindings", level: 2, content: "binding map" }],
            },
          ],
          chunks: [
            {
              id: "chunk-1",
              documentId: "spec-doc",
              path: "docs/cache.spec.md",
              sectionId: "s1",
              sectionTitle: "Scope",
              text: "cache scope",
              docType: "spec",
            },
            {
              id: "chunk-2",
              documentId: "pbd-doc",
              path: "docs/runtime.pbd.md",
              sectionId: "p1",
              sectionTitle: "Bindings",
              text: "binding map",
              docType: "pbd",
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const summary = await migrateFromSqliteVss(temp, false);
    expect(summary.docs).toBe(2);
    const manifest = await loadSnapshotManifest(temp, sha);
    const types = new Set(manifest.docs.map((doc) => doc.docType));
    expect(types.has("spec")).toBe(true);
    expect(types.has("pbd")).toBe(true);
  });
});
