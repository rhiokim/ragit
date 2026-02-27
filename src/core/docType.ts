import path from "node:path";
import { DocType } from "./types.js";

const supported: DocType[] = ["adr", "prd", "srs", "plan", "ddd", "glossary"];

export interface FrontmatterResult {
  attributes: Record<string, string>;
  body: string;
}

export const splitFrontmatter = (source: string): FrontmatterResult => {
  if (!source.startsWith("---\n")) {
    return { attributes: {}, body: source };
  }
  const end = source.indexOf("\n---", 4);
  if (end === -1) {
    return { attributes: {}, body: source };
  }
  const rawFrontmatter = source.slice(4, end).trim();
  const attributes: Record<string, string> = {};
  for (const line of rawFrontmatter.split(/\r?\n/)) {
    const match = line.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.+)$/);
    if (!match) continue;
    attributes[match[1].trim()] = match[2].trim().replace(/^"(.*)"$/, "$1");
  }
  const body = source.slice(end + 4).replace(/^\r?\n/, "");
  return { attributes, body };
};

const normalizeType = (value: string | undefined): DocType | null => {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (supported.includes(normalized as DocType)) return normalized as DocType;
  if (normalized === "terms" || normalized === "term") return "glossary";
  return null;
};

const byPath = (relativePath: string): DocType | null => {
  const normalized = relativePath.toLowerCase();
  if (/(^|\/)(adr|architecture-decision|decisions)(\/|$)/.test(normalized)) return "adr";
  if (/(^|\/)(prd|product-requirements?)(\/|$)/.test(normalized)) return "prd";
  if (/(^|\/)(srs|requirements?|spec)(\/|$)/.test(normalized)) return "srs";
  if (/(^|\/)(plan|roadmap|wbs)(\/|$)/.test(normalized)) return "plan";
  if (/(^|\/)(ddd|domain-driven|domain-model)(\/|$)/.test(normalized)) return "ddd";
  if (/(^|\/)(glossary|terms|vocabulary)(\/|$)/.test(normalized)) return "glossary";
  return null;
};

const byHeading = (body: string): DocType | null => {
  const heading = body
    .split(/\r?\n/)
    .find((line) => line.trim().startsWith("#"))
    ?.toLowerCase();
  if (!heading) return null;
  if (heading.includes("adr") || heading.includes("architecture decision")) return "adr";
  if (heading.includes("prd") || heading.includes("product requirements")) return "prd";
  if (heading.includes("srs") || heading.includes("software requirements")) return "srs";
  if (heading.includes("plan") || heading.includes("실행계획")) return "plan";
  if (heading.includes("ddd") || heading.includes("domain-driven")) return "ddd";
  if (heading.includes("glossary") || heading.includes("용어집")) return "glossary";
  return null;
};

export interface DocTypeDetectionResult {
  docType: DocType;
  body: string;
  frontmatter: Record<string, string>;
}

export const detectDocType = (absolutePath: string, source: string, cwd: string): DocTypeDetectionResult => {
  const relativePath = path.relative(cwd, absolutePath).replaceAll(path.sep, "/");
  const { attributes, body } = splitFrontmatter(source);
  const frontmatterType = normalizeType(attributes.type);
  if (frontmatterType) {
    return { docType: frontmatterType, body, frontmatter: attributes };
  }
  const pathType = byPath(relativePath);
  if (pathType) {
    return { docType: pathType, body, frontmatter: attributes };
  }
  const headingType = byHeading(body);
  if (headingType) {
    return { docType: headingType, body, frontmatter: attributes };
  }
  return { docType: "unknown", body, frontmatter: attributes };
};
