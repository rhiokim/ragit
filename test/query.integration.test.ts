import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { runIngest } from "../src/core/ingest.js";
import { searchKnowledge } from "../src/core/retrieval.js";

const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("query snapshot reproduction", () => {
  it(
    "keeps unchanged chunks searchable in newer snapshots and preserves old/new versions",
    async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-query-"));
    git(temp, ["init"]);
    git(temp, ["config", "user.email", "ragit@example.com"]);
    git(temp, ["config", "user.name", "ragit-test"]);
    await mkdir(path.join(temp, "docs"), { recursive: true });
    await writeFile(
      path.join(temp, "docs", "runner.adr.md"),
      `---
type: adr
---
# Runner
Use pnpm ragit locally without building dist.`,
      "utf8",
    );
    await writeFile(
      path.join(temp, "docs", "topology.pbd.md"),
      `---
type: pbd
---
# PBD
Binding maps keep unchanged documents visible across snapshots.`,
      "utf8",
    );
    git(temp, ["add", "."]);
    git(temp, ["commit", "-m", "seed docs"]);
    const oldSha = git(temp, ["rev-parse", "HEAD"]);

    await runInit(temp, { nonInteractive: true });
    await runIngest(temp, { all: true });

    await writeFile(
      path.join(temp, "docs", "runner.adr.md"),
      `---
type: adr
---
# Runner
Use pnpm ragit locally after zvec store bootstrap.`,
      "utf8",
    );
    git(temp, ["add", "."]);
    git(temp, ["commit", "-m", "update runner"]);
    const newSha = git(temp, ["rev-parse", "HEAD"]);

    await runIngest(temp, { since: oldSha });

    const unchanged = await searchKnowledge(temp, "unchanged documents visible across snapshots", { at: newSha, topK: 3 });
    expect(unchanged.hits[0]?.path).toBe("docs/topology.pbd.md");

    const oldSnapshot = await searchKnowledge(temp, "without building dist", { at: oldSha, topK: 3 });
    expect(oldSnapshot.hits[0]?.text).toContain("without building dist");

    const newSnapshot = await searchKnowledge(temp, "after zvec store bootstrap", { at: newSha, topK: 3 });
    expect(newSnapshot.hits[0]?.text).toContain("after zvec store bootstrap");
    },
    15_000,
  );
});
