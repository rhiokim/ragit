import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";

const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("init command integration", () => {
  it("creates AGENTS and guide index in git repo", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-init-git-"));
    git(temp, ["init"]);
    const summary = await runInit(temp, { nonInteractive: true });
    expect(summary.mode).toBe("non-interactive");
    expect(summary.agents.mode).toBe("created");
    expect(summary.guide.indexPath).toBe(".ragit/guide/guide-index.json");
  });

  it("loads existing AGENTS without mutating source content", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-init-existing-"));
    git(temp, ["init"]);
    const agentsPath = path.join(temp, "AGENTS.md");
    const seed = "## [B1] Custom\n## [B2] Another\n## [Rule 1] Rule";
    await writeFile(agentsPath, seed, "utf8");
    const before = await readFile(agentsPath, "utf8");
    const summary = await runInit(temp, { nonInteractive: true });
    const after = await readFile(agentsPath, "utf8");
    expect(summary.agents.mode).toBe("loaded");
    expect(before).toBe(after);
  });

  it("fails in non-git without --git-init and succeeds with it", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-init-nongit-"));
    await expect(runInit(temp, { nonInteractive: true })).rejects.toThrow("Git 저장소가 아닙니다.");
    const summary = await runInit(temp, { nonInteractive: true, gitInit: true });
    expect(summary.git.initialized).toBe(true);
    expect(summary.agents.mode).toBe("created");
  });
});
