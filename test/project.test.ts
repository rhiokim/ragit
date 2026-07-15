import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildRagitGitIgnorePlan } from "../src/core/gitignore-policy.js";
import { ensureGitIgnoreEntries, resolveRagitPaths } from "../src/core/project.js";

describe("project helpers", () => {
  const safeEntries = [
    ".ragit/store/",
    ".ragit/store.next/",
    ".ragit/store.prev/",
    ".ragit/runtime/",
    ".ragit/cache/",
    ".ragit/log/",
    ".ragit/reports/",
    ".ragit/security/",
    ".ragit/memory/sessions/",
    ".ragit/memory/working/",
    ".ragit/artifacts/session/",
    ".ragit/manifest/",
    ".ragit/artifacts/harness/",
  ];

  it("creates a clean .gitignore without a leading blank line", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-project-"));

    const summary = await ensureGitIgnoreEntries(temp);

    const content = await readFile(path.join(temp, ".gitignore"), "utf8");
    expect(content).toBe(`${safeEntries.join("\n")}\n`);
    expect(summary.policy).toBe("safe");
    expect(summary.addedEntries).toEqual(safeEntries);
  });

  it("appends only missing entries to an existing .gitignore", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-project-append-"));
    const gitIgnorePath = path.join(temp, ".gitignore");
    await writeFile(gitIgnorePath, "node_modules/\n.ragit/store/\n", "utf8");

    await ensureGitIgnoreEntries(temp);

    const content = await readFile(gitIgnorePath, "utf8");
    expect(content).toBe(`node_modules/\n.ragit/store/\n${safeEntries.slice(1).join("\n")}\n`);
  });

  it("does not rewrite .gitignore when all entries already exist", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-project-stable-"));
    const gitIgnorePath = path.join(temp, ".gitignore");
    await writeFile(gitIgnorePath, `${safeEntries.join("\n")}\n`, "utf8");
    const before = await stat(gitIgnorePath);

    await new Promise((resolve) => setTimeout(resolve, 20));
    await ensureGitIgnoreEntries(temp);
    const after = await stat(gitIgnorePath);

    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("omits tracked snapshot and harness entries for dogfood policy", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-project-dogfood-"));
    const plan = buildRagitGitIgnorePlan({
      trackManifests: true,
      trackHarnessArtifacts: true,
    });

    const summary = await ensureGitIgnoreEntries(temp, plan.entries, plan.policy);

    const content = await readFile(path.join(temp, ".gitignore"), "utf8");
    expect(summary.policy).toBe("dogfood");
    expect(content).not.toContain(".ragit/manifest/");
    expect(content).not.toContain(".ragit/artifacts/harness/");
    expect(content).toContain(".ragit/store/");
    expect(content).toContain(".ragit/artifacts/session/");
  });

  it("resolves local runtime paths without eagerly creating them", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-project-runtime-"));
    const paths = resolveRagitPaths(temp);

    expect(paths.runtimeDir).toBe(path.join(temp, ".ragit", "runtime"));
    expect(paths.storeWriteLockPath).toBe(path.join(temp, ".ragit", "runtime", "store-write.lock"));
    await expect(stat(paths.runtimeDir)).rejects.toThrow();
  });
});
