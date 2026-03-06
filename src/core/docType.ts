import path from "node:path";
import { DocType, normalizeKnownDocType } from "./types.js";

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
  return normalizeKnownDocType(value);
};

const byPath = (relativePath: string): DocType | null => {
  const normalized = relativePath.toLowerCase();
  if (/(^|\/)(adr|architecture-decision|decisions)(\/|$)/.test(normalized)) return "adr";
  if (/(^|\/)(prd|product-requirements?)(\/|$)/.test(normalized)) return "prd";
  if (/(^|\/)(srs|requirements?)(\/|$)/.test(normalized)) return "srs";
  if (/(^|\/)(spec|specs|specification|specifications)(\/|$)/.test(normalized)) return "spec";
  if (/(^|\/)(plan|roadmap|wbs)(\/|$)/.test(normalized)) return "plan";
  if (/(^|\/)(ddd|domain-driven|domain-model)(\/|$)/.test(normalized)) return "ddd";
  if (/(^|\/)(glossary|terms|vocabulary)(\/|$)/.test(normalized)) return "glossary";
  if (/(^|\/)(pbd|pb|phase-binding|phase-bindings|phase-and-bindings|phase-binding-documents|phase-and-binding-documents)(\/|$)/.test(normalized)) return "pbd";
  return null;
};

const byHeading = (body: string): DocType | null => {
  const heading = body
    .split(/\r?\n/)
    .find((line) => line.trim().startsWith("#"))
    ?.toLowerCase();
  if (!heading) return null;
  const hasToken = (pattern: RegExp): boolean => pattern.test(heading);
  if (heading.includes("adr") || heading.includes("architecture decision")) return "adr";
  if (heading.includes("prd") || heading.includes("product requirements")) return "prd";
  if (heading.includes("srs") || heading.includes("software requirements")) return "srs";
  if (heading.includes("spec") || heading.includes("specification") || heading.includes("기능 명세") || heading.includes("상세 명세")) return "spec";
  if (heading.includes("plan") || heading.includes("실행계획")) return "plan";
  if (heading.includes("ddd") || heading.includes("domain-driven")) return "ddd";
  if (heading.includes("glossary") || heading.includes("용어집")) return "glossary";
  if (
    hasToken(/\bpbd\b/) ||
    hasToken(/\bpb\b/) ||
    heading.includes("phase and binding documents") ||
    heading.includes("phase and bindings") ||
    heading.includes("위상과 결속") ||
    heading.includes("위상 및 결속")
  )
    return "pbd";
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
