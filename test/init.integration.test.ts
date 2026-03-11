import { constants } from "node:fs";
import { access, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";

const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("init command integration", () => {
  it("detects empty repositories and creates foundational drafts", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-init-empty-"));

    const summary = await runInit(temp, {
      nonInteractive: true,
      gitInit: true,
    });

    expect(summary.executionMode).toBe("non-interactive");
    expect(summary.repositoryMode).toBe("empty");
    expect(summary.actions.created).toContain("RAGIT.md");
    expect(summary.actions.created).toContain("docs/ragit/ingestion-policy.md");
    expect(summary.bootstrap.agents.mode).toBe("created");
    expect(summary.bootstrap.storage.status).toBe("created");
    expect(summary.bootstrap.storage.collections).toEqual(["documents", "chunks"]);
    expect(summary.bootstrap.storage.searchReady).toBe(false);

    const ragitContent = await readFile(path.join(temp, "RAGIT.md"), "utf8");
    expect(ragitContent).toContain("status: draft");
    expect(ragitContent).toContain("last_generated_by: ragit init");
  });

  it("anchors nested git paths to the repository root", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-init-nested-"));
    git(temp, ["init"]);
    const nested = path.join(temp, "packages", "docs");
    await mkdir(nested, { recursive: true });

    const summary = await runInit(nested, { nonInteractive: true });

    expect(summary.bootstrap.agents.path).toBe("AGENTS.md");
    expect(summary.bootstrap.guide.indexPath).toBe(".ragit/guide/guide-index.json");
    await access(path.join(temp, "AGENTS.md"), constants.F_OK);
    await access(path.join(temp, ".ragit", "guide", "guide-index.json"), constants.F_OK);
    await expect(access(path.join(nested, ".ragit"), constants.F_OK)).rejects.toThrow();
  });

  it("reuses existing documents without overwriting them", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-init-existing-"));
    git(temp, ["init"]);
    await writeFile(path.join(temp, "README.md"), "# Existing README\n", "utf8");
    await writeFile(path.join(temp, "CONTRIBUTING.md"), "# Contributing\n", "utf8");
    await mkdir(path.join(temp, "docs"), { recursive: true });
    await writeFile(path.join(temp, "docs", "architecture.md"), "# Architecture\n", "utf8");

    const summary = await runInit(temp, { nonInteractive: true });

    expect(summary.repositoryMode).toBe("existing");
    expect(summary.actions.reused).toContain("README.md");
    expect(summary.actions.reused).toContain("CONTRIBUTING.md");
    expect(summary.coverage.projectOverview.status).toBe("sufficient");
    expect(summary.coverage.localDevelopmentGuide.status).toBe("sufficient");
    expect(summary.coverage.architectureRationale.status).toBe("sufficient");
    expect(await readFile(path.join(temp, "README.md"), "utf8")).toBe("# Existing README\n");
  });

  it("prefers docs-heavy mode when docs dominate the repository", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-init-docs-heavy-"));
    git(temp, ["init"]);
    await mkdir(path.join(temp, "docs", "adr"), { recursive: true });
    await mkdir(path.join(temp, "docs", "ragit"), { recursive: true });
    await mkdir(path.join(temp, "src"), { recursive: true });
    await writeFile(path.join(temp, "README.md"), "# Product\n", "utf8");
    await writeFile(path.join(temp, "CONTRIBUTING.md"), "# Contributing\n", "utf8");
    await writeFile(path.join(temp, "docs", "architecture.md"), "# Architecture\n", "utf8");
    await writeFile(path.join(temp, "docs", "workspace-map.md"), "# Workspace Map\n", "utf8");
    await writeFile(path.join(temp, "docs", "ragit", "ingestion-policy.md"), "# Ingestion Policy\n", "utf8");
    await writeFile(path.join(temp, "docs", "adr", "0001-example.md"), "---\ntype: adr\n---\n# Decision\n", "utf8");
    await writeFile(path.join(temp, "docs", "glossary.md"), "---\ntype: glossary\n---\n# Terms\n", "utf8");
    await writeFile(path.join(temp, "docs", "operations.md"), "# Operations\n", "utf8");
    await writeFile(path.join(temp, "src", "index.ts"), "export const ready = true;\n", "utf8");

    const summary = await runInit(temp, { nonInteractive: true });

    expect(summary.repositoryMode).toBe("docs-heavy");
    expect(summary.actions.created.length).toBeLessThanOrEqual(2);
    expect(summary.coverage.ingestionPolicy.status).toBe("sufficient");
    expect(summary.coverage.decisionRecords.status).toBe("sufficient");
  });

  it("detects monorepo layout and plans workspace docs", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-init-monorepo-"));
    git(temp, ["init"]);
    await writeFile(path.join(temp, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n  - packages/*\n", "utf8");
    await writeFile(path.join(temp, "package.json"), JSON.stringify({ packageManager: "pnpm@10.13.1" }, null, 2), "utf8");
    await mkdir(path.join(temp, "apps", "web"), { recursive: true });
    await mkdir(path.join(temp, "packages", "editor"), { recursive: true });
    await writeFile(path.join(temp, "apps", "web", "README.md"), "# Web\n", "utf8");
    await writeFile(path.join(temp, "packages", "editor", "README.md"), "# Editor\n", "utf8");

    const summary = await runInit(temp, { nonInteractive: true });

    expect(summary.repositoryMode).toBe("monorepo");
    expect(summary.scan.apps).toContain("apps/web");
    expect(summary.scan.packages).toContain("packages/editor");
    expect(summary.actions.created).toContain("docs/workspace-map.md");
  });

  it("supports dry-run without mutating the repository", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-init-dry-run-"));
    git(temp, ["init"]);
    await writeFile(path.join(temp, "README.md"), "# Existing README\n", "utf8");

    const summary = await runInit(temp, { nonInteractive: true, dryRun: true });

    expect(summary.actions.created).toContain("RAGIT.md");
    expect(summary.bootstrap.agents.mode).toBe("planned");
    expect(summary.bootstrap.storage.status).toBe("planned");
    await expect(access(path.join(temp, "RAGIT.md"), constants.F_OK)).rejects.toThrow();
    await expect(access(path.join(temp, ".ragit"), constants.F_OK)).rejects.toThrow();
  });

  it("fails in non-git without --git-init and reports legacy store migration", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-init-legacy-"));
    await expect(runInit(temp, { nonInteractive: true })).rejects.toThrow("Git 저장소가 아닙니다.");
    git(temp, ["init"]);
    await mkdir(path.join(temp, ".ragit", "store"), { recursive: true });
    await writeFile(path.join(temp, ".ragit", "store", "index.json"), JSON.stringify({ documents: {}, chunks: {} }, null, 2), "utf8");

    const summary = await runInit(temp, { nonInteractive: true });

    expect(summary.bootstrap.storage.migrationRequired).toBe(true);
    expect(summary.nextActions[0]).toBe("ragit migrate from-json-store");
  });
});
