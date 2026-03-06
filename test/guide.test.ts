import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildGuideIndex, createTopologicalAgentsSeed, ensureGuideStructure, parseGuideBoundaries } from "../src/core/guide.js";

describe("guide parser and scaffold", () => {
  it("parses hierarchical boundaries and section blocks", () => {
    const source = `
## [B1] Root One
text
### [B1.a] Child A
text
## [B2] Root Two
### [B2.a] Child A
#### [B2.a.1] Child nested
## [Rule 1] Rule Root
`;
    const parsed = parseGuideBoundaries(source);
    const b1 = parsed.boundaries.find((boundary) => boundary.id === "[B1]");
    const b1a = parsed.boundaries.find((boundary) => boundary.id === "[B1.a]");
    const b2Section = parsed.sections.find((section) => section.rootId === "[B2]");
    const ruleSection = parsed.sections.find((section) => section.rootId === "Rule 1");
    expect(b1?.parentId).toBeNull();
    expect(b1a?.parentId).toBe("[B1]");
    expect(b2Section?.childIds).toContain("[B2.a]");
    expect(ruleSection?.blockStartLine).toBeGreaterThan(0);
  });

  it("contains required seed sections", () => {
    const seed = createTopologicalAgentsSeed();
    expect(seed.includes("## [B1]")).toBe(true);
    expect(seed.includes("## [B2]")).toBe(true);
    expect(seed.includes("## [B3]")).toBe(true);
    expect(seed.includes("## [B4]")).toBe(true);
    expect(seed.includes("## [Rule 1]")).toBe(true);
  });

  it("creates templates incrementally without overwrite", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "ragit-guide-"));
    await mkdir(path.join(temp, ".ragit"), { recursive: true });
    const first = await ensureGuideStructure(temp);
    expect(first.createdFiles.length).toBeGreaterThan(0);
    const adrPath = path.join(temp, ".ragit", "guide", "templates", "adr.template.md");
    const specPath = path.join(temp, ".ragit", "guide", "templates", "spec.template.md");
    const pbPath = path.join(temp, ".ragit", "guide", "templates", "pb.template.md");
    await expect(readFile(specPath, "utf8")).resolves.toContain("type: spec");
    await expect(readFile(pbPath, "utf8")).resolves.toContain("type: pb");
    await writeFile(adrPath, "custom", "utf8");
    const second = await ensureGuideStructure(temp);
    const content = await readFile(adrPath, "utf8");
    expect(content).toBe("custom");
    expect(second.createdFiles.length).toBe(0);
    expect(second.skippedFiles.length).toBeGreaterThan(0);
  });

  it("emits guide defaults with spec and pb doc types", () => {
    const agents = {
      path: "/tmp/repo/AGENTS.md",
      mode: "loaded" as const,
      content: createTopologicalAgentsSeed(),
      sha256: "hash",
    };
    const parsed = parseGuideBoundaries(agents.content);
    const index = buildGuideIndex(agents, parsed);
    expect(index.defaults.docTypes).toContain("spec");
    expect(index.defaults.docTypes).toContain("pb");
    expect(index.templateMap.spec).toBe(".ragit/guide/templates/spec.template.md");
    expect(index.templateMap.pb).toBe(".ragit/guide/templates/pb.template.md");
  });
});
