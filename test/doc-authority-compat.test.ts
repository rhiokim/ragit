import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { refreshDocs, validateDocs } from "../src/core/doc-authority.js";

describe("doc authority compatibility metadata", () => {
  it("preserves architecture_view during refresh", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-doc-compat-refresh-"));
    await mkdir(path.join(temp, "docs", "spec"), { recursive: true });
    const target = path.join(temp, "docs", "spec", "cache-adapter.md");
    await writeFile(
      target,
      `---
type: spec
architecture_view: lld
---
# SPEC: Cache Adapter

## Scope
- cache adapter 범위
`,
      "utf8",
    );

    const result = await refreshDocs(temp, { files: "docs/spec/cache-adapter.md" });
    expect(result.refreshedFiles).toContain("docs/spec/cache-adapter.md");

    const content = await readFile(target, "utf8");
    expect(content).toContain("architecture_view: lld");
    expect(content).toContain("## Interfaces and Contracts");
    expect(content).toContain("## Acceptance Criteria");
  });

  it("does not treat architecture_view as a validation violation", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-doc-compat-validate-"));
    await mkdir(path.join(temp, "docs", "pbd"), { recursive: true });
    await writeFile(
      path.join(temp, "docs", "pbd", "runtime-topology.md"),
      `---
type: pbd
architecture_view: hld
---
# PBD: Runtime Topology

## Implementation Scope
- runtime 범위

## Phase Topology
- phase flow

## Binding Map
- binding relation

## Interaction Paths
- interaction path

## Failure and Drift Points
- drift point

## Observability Notes
- observe

## [B1] 위상 경계
- boundary
`,
      "utf8",
    );

    const validation = await validateDocs(temp, { all: true });
    expect(validation.checkedFiles).toBe(1);
    expect(validation.violations).toBe(0);
    expect(validation.files[0]?.violations).toEqual([]);
  });
});
