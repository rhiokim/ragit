import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ensureGitIgnoreEntries } from "../src/core/project.js";

describe("project helpers", () => {
  it("creates a clean .gitignore without a leading blank line", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-project-"));

    await ensureGitIgnoreEntries(temp);

    const content = await readFile(path.join(temp, ".gitignore"), "utf8");
    expect(content).toBe(".ragit/store/\n.ragit/cache/\n");
  });

  it("appends only missing entries to an existing .gitignore", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-project-append-"));
    const gitIgnorePath = path.join(temp, ".gitignore");
    await writeFile(gitIgnorePath, "node_modules/\n.ragit/store/\n", "utf8");

    await ensureGitIgnoreEntries(temp);

    const content = await readFile(gitIgnorePath, "utf8");
    expect(content).toBe("node_modules/\n.ragit/store/\n.ragit/cache/\n");
  });

  it("does not rewrite .gitignore when all entries already exist", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-project-stable-"));
    const gitIgnorePath = path.join(temp, ".gitignore");
    await writeFile(gitIgnorePath, ".ragit/store/\n.ragit/cache/\n", "utf8");
    const before = await stat(gitIgnorePath);

    await new Promise((resolve) => setTimeout(resolve, 20));
    await ensureGitIgnoreEntries(temp);
    const after = await stat(gitIgnorePath);

    expect(after.mtimeMs).toBe(before.mtimeMs);
  });
});
