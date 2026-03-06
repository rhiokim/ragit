import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectDocType } from "../src/core/docType.js";

describe("DocType detection", () => {
  const cwd = "/tmp/repo";

  it("prefers frontmatter type over path rule", () => {
    const source = `---
type: glossary
---
# ADR
decision`;
    const result = detectDocType("/tmp/repo/docs/adr/001.md", source, cwd);
    expect(result.docType).toBe("glossary");
  });

  it("detects ddd from path", () => {
    const source = "# Domain Model";
    const result = detectDocType("/tmp/repo/docs/ddd/order-context.md", source, cwd);
    expect(result.docType).toBe("ddd");
  });

  it("detects spec from specification frontmatter alias", () => {
    const source = `---
type: specification
---
# Overview`;
    const result = detectDocType("/tmp/repo/docs/module/readme.md", source, cwd);
    expect(result.docType).toBe("spec");
  });

  it("detects spec from spec path without collapsing into srs", () => {
    const source = "# Cache Adapter";
    const result = detectDocType("/tmp/repo/docs/specs/cache-adapter.md", source, cwd);
    expect(result.docType).toBe("spec");
  });

  it("keeps requirements paths mapped to srs", () => {
    const source = "# Detailed requirement";
    const result = detectDocType("/tmp/repo/docs/requirements/cache.md", source, cwd);
    expect(result.docType).toBe("srs");
  });

  it("detects pb from korean heading", () => {
    const source = "# 위상과 결속\n구현체 결속 구조";
    const result = detectDocType(path.join(cwd, "notes.md"), source, cwd);
    expect(result.docType).toBe("pb");
  });

  it("detects glossary from korean heading", () => {
    const source = "# 용어집\n- Aggregate";
    const result = detectDocType(path.join(cwd, "notes.md"), source, cwd);
    expect(result.docType).toBe("glossary");
  });
});
