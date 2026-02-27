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

  it("detects glossary from korean heading", () => {
    const source = "# 용어집\n- Aggregate";
    const result = detectDocType(path.join(cwd, "notes.md"), source, cwd);
    expect(result.docType).toBe("glossary");
  });
});
