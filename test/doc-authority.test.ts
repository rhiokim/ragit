import { constants } from "node:fs";
import { access, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDoc, DOC_CONTRACTS, reconcileDocs, refreshDocs, validateDocs } from "../src/core/doc-authority.js";

describe("doc authority", () => {
  it("creates and validates all standard document types", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-doc-create-"));

    for (const docType of Object.keys(DOC_CONTRACTS)) {
      const result = await createDoc(temp, {
        docType: docType as keyof typeof DOC_CONTRACTS,
        title: `${docType} sample`,
      });
      expect(result.status).toBe("created");
      expect(result.path.startsWith(`docs/${docType}/`)).toBe(true);
    }

    const validation = await validateDocs(temp, { all: true });
    expect(validation.checkedFiles).toBe(8);
    expect(validation.violations).toBe(0);
  });

  it("refreshes structure without overwriting existing body text", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-doc-refresh-"));
    await mkdir(path.join(temp, "docs", "spec"), { recursive: true });
    await writeFile(
      path.join(temp, "docs", "spec", "cache-adapter.md"),
      `---
type: spec
---
# SPEC: Cache Adapter

기존 본문 문단은 유지되어야 합니다.

## Scope
- cache adapter 범위
`,
      "utf8",
    );

    const result = await refreshDocs(temp, { files: "docs/spec/cache-adapter.md" });
    expect(result.refreshedFiles).toContain("docs/spec/cache-adapter.md");

    const content = await readFile(path.join(temp, "docs", "spec", "cache-adapter.md"), "utf8");
    expect(content).toContain("기존 본문 문단은 유지되어야 합니다.");
    expect(content).toContain("## Acceptance Criteria");
    expect(content).toContain("## Interfaces and Contracts");
  });

  it("reconciles non-canonical docs without moving files in dry-run", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-doc-reconcile-"));
    await mkdir(path.join(temp, "notes"), { recursive: true });
    await writeFile(
      path.join(temp, "notes", "decision.md"),
      `---
type: adr
---
# ADR: Decision

## Context
- ctx

## Decision
- choose A

## Consequences
- tradeoff
`,
      "utf8",
    );

    const result = await reconcileDocs(temp, { dryRun: true });
    expect(result.status).toBe("planned");
    expect(result.tracked).toBe(1);
    expect(result.entries[0]?.sourcePath).toBe("notes/decision.md");
    expect(result.entries[0]?.canonicalPath).toBe("docs/adr/decision.md");
    expect(result.entries[0]?.status).toBe("mapped");

    await access(path.join(temp, "notes", "decision.md"), constants.F_OK);
  });
});
