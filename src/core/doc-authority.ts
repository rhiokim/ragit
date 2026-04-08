import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertRepoRelativePath } from "./cliInput.js";
import { loadConfig } from "./config.js";
import { detectDocType, splitFrontmatter } from "./docType.js";
import { hashFileContent, listAllDocumentFiles, listDocumentFilesByGlob } from "./files.js";
import { ensureGuideStructure } from "./guide.js";
import { toRepoPath } from "./identity.js";
import { ensureRagitStructure, resolveRagitPaths } from "./project.js";
import { isKnownDocType, KnownDocType, normalizeKnownDocType, RagitConfig } from "./types.js";
import { RAGIT_VERSION } from "./version.js";

export interface DocContract {
  docType: KnownDocType;
  requiredSections: string[];
  titlePrefix: string;
}

export interface DocCreateInput {
  docType: KnownDocType;
  title: string;
  path?: string;
  content?: string;
}

export interface DocCreateResult {
  dryRun: boolean;
  docType: KnownDocType;
  path: string;
  canonicalPath: string;
  status: "created" | "planned";
  usedTemplate: boolean;
}

export interface DocRefreshInput {
  docType?: KnownDocType;
  files?: string;
}

export interface DocValidationItem {
  path: string;
  docType: KnownDocType;
  canonicalPath: string;
  violations: string[];
}

export interface DocValidateResult {
  checkedFiles: number;
  tracked: number;
  violations: number;
  files: DocValidationItem[];
}

export interface DocAuthorityIndexEntry {
  sourcePath: string;
  canonicalPath: string;
  docType: KnownDocType;
  hash: string;
  status: "canonical" | "mapped";
  violations: string[];
}

export interface DocAuthorityIndex {
  version: string;
  generatedAt: string;
  lastReconciledAt: string;
  tracked: number;
  violations: number;
  entries: DocAuthorityIndexEntry[];
}

export interface DocReconcileOptions {
  dryRun?: boolean;
  config?: RagitConfig;
  ensureStructure?: boolean;
}

export interface DocReconcileResult {
  dryRun: boolean;
  indexPath: string;
  status: "created" | "loaded" | "planned";
  tracked: number;
  violations: number;
  lastReconciledAt: string;
  entries: DocAuthorityIndexEntry[];
}

export interface DocRefreshResult {
  dryRun: boolean;
  plannedFiles: string[];
  refreshedFiles: string[];
  unchangedFiles: string[];
  skippedFiles: string[];
  violationsBefore: number;
  violationsAfter: number;
  reconcile: DocReconcileResult;
  warnings: string[];
}

const TOPOLOGY_HEADING_REGEX = /^#{2,6}\s*(\[[A-Z][0-9]+(?:\.[a-z0-9]+)*\])\s+([^\n]+)$/m;

export const DOC_CONTRACTS: Record<KnownDocType, DocContract> = {
  adr: {
    docType: "adr",
    titlePrefix: "ADR",
    requiredSections: ["Context", "Decision", "Consequences"],
  },
  prd: {
    docType: "prd",
    titlePrefix: "PRD",
    requiredSections: ["Goal", "User Stories", "Acceptance Criteria"],
  },
  srs: {
    docType: "srs",
    titlePrefix: "SRS",
    requiredSections: ["Functional Requirements", "Non-Functional Requirements"],
  },
  spec: {
    docType: "spec",
    titlePrefix: "SPEC",
    requiredSections: ["Scope", "Functional Requirements", "Interfaces and Contracts", "State and Flow", "Acceptance Criteria"],
  },
  plan: {
    docType: "plan",
    titlePrefix: "Plan",
    requiredSections: ["Milestones", "Work Breakdown"],
  },
  ddd: {
    docType: "ddd",
    titlePrefix: "DDD",
    requiredSections: ["Bounded Context", "Aggregate"],
  },
  glossary: {
    docType: "glossary",
    titlePrefix: "Glossary",
    requiredSections: ["Terms"],
  },
  pbd: {
    docType: "pbd",
    titlePrefix: "PBD",
    requiredSections: ["Implementation Scope", "Phase Topology", "Binding Map", "Interaction Paths", "Failure and Drift Points", "Observability Notes"],
  },
};

const DEFAULT_SECTION_NOTE = "- TODO: 내용을 보강해 주세요.";

const fileExists = async (target: string): Promise<boolean> => {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

const toPosixPath = (value: string): string => value.replaceAll(path.sep, "/");

const normalizeWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim();

const slugify = (value: string): string => {
  const normalized = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s-]/g, " ")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || "document";
};

const normalizeCanonicalRoot = (config: RagitConfig): string => {
  const raw = (config.docs_authority.canonical_root || "docs").trim().replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/+$/, "");
  return raw || "docs";
};

const canonicalDirectory = (config: RagitConfig, docType: KnownDocType): string => `${normalizeCanonicalRoot(config)}/${docType}`;

const canonicalPathForSource = (config: RagitConfig, docType: KnownDocType, sourcePath: string): string => {
  const baseName = path.posix.basename(sourcePath);
  return `${canonicalDirectory(config, docType)}/${baseName}`;
};

const normalizeHeading = (value: string): string => normalizeWhitespace(value).toLowerCase();

const collectHeadings = (body: string): Set<string> => {
  const headings = new Set<string>();
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^#{1,6}\s+(.+)$/);
    if (!match) continue;
    headings.add(normalizeHeading(match[1]));
  }
  return headings;
};

const hasH1 = (body: string): boolean => /^#\s+.+$/m.test(body);

const quoteFrontmatterValue = (value: string): string => {
  if (/^[a-zA-Z0-9_./:@-]+$/.test(value)) return value;
  return `"${value.replaceAll('"', '\\"')}"`;
};

const renderFrontmatter = (attributes: Record<string, string>): string => {
  const ordered = Object.entries(attributes)
    .filter(([key]) => key.trim().length > 0)
    .sort(([left], [right]) => {
      if (left === "type") return -1;
      if (right === "type") return 1;
      return left.localeCompare(right);
    });
  const lines = ordered.map(([key, value]) => `${key}: ${quoteFrontmatterValue(value)}`);
  return `---\n${lines.join("\n")}\n---\n`;
};

const fallbackTitleFromPath = (targetPath: string): string => {
  const base = path.posix.basename(targetPath, path.posix.extname(targetPath));
  const words = base
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((chunk) => chunk.charAt(0).toUpperCase() + chunk.slice(1));
  return words.join(" ") || "Document";
};

const formatMainTitle = (docType: KnownDocType, title: string): string => {
  const contract = DOC_CONTRACTS[docType];
  if (contract.titlePrefix === "Plan") return `Plan: ${title}`;
  if (contract.titlePrefix === "Glossary") return `Glossary: ${title}`;
  return `${contract.titlePrefix}: ${title}`;
};

const ensureTrailingNewline = (value: string): string => (value.endsWith("\n") ? value : `${value}\n`);

const ensureSectionBlocks = (body: string, sections: string[]): { content: string; appended: number } => {
  const headingSet = collectHeadings(body);
  let content = body;
  let appended = 0;
  for (const section of sections) {
    if (headingSet.has(normalizeHeading(section))) continue;
    const suffix = content.trimEnd().length === 0 ? "" : "\n\n";
    content = `${content.trimEnd()}${suffix}## ${section}\n${DEFAULT_SECTION_NOTE}\n`;
    headingSet.add(normalizeHeading(section));
    appended += 1;
  }
  return {
    content: ensureTrailingNewline(content),
    appended,
  };
};

const mergeAttributes = (attributes: Record<string, string>, docType: KnownDocType): Record<string, string> => ({
  ...attributes,
  type: docType,
});

const renderFallbackDocument = (docType: KnownDocType, title: string): string => {
  const contract = DOC_CONTRACTS[docType];
  const body = [`# ${formatMainTitle(docType, title)}`, "", ...contract.requiredSections.flatMap((section) => [`## ${section}`, DEFAULT_SECTION_NOTE, ""])].join("\n");
  return `${renderFrontmatter({ type: docType })}${ensureTrailingNewline(body)}`;
};

const templatePathForType = (cwd: string, docType: KnownDocType): string => path.join(cwd, ".ragit", "guide", "templates", `${docType}.template.md`);

const readTemplate = async (cwd: string, docType: KnownDocType, materializeIfMissing: boolean): Promise<string | null> => {
  if (materializeIfMissing) {
    await ensureGuideStructure(cwd);
  }
  const templatePath = templatePathForType(cwd, docType);
  try {
    return await readFile(templatePath, "utf8");
  } catch {
    return null;
  }
};

const applyTitleToTemplate = (docType: KnownDocType, title: string, template: string): string => {
  const withTitle = template.replace(/^#\s+.+$/m, `# ${formatMainTitle(docType, title)}`);
  const { attributes, body } = splitFrontmatter(withTitle);
  const merged = mergeAttributes(attributes, docType);
  const ensuredH1 = hasH1(body) ? body : `# ${formatMainTitle(docType, title)}\n\n${body.trimStart()}`;
  return `${renderFrontmatter(merged)}${ensureTrailingNewline(ensuredH1)}`;
};

const uniqueAbsolutePath = async (initialAbsolutePath: string): Promise<string> => {
  const parsed = path.parse(initialAbsolutePath);
  let candidate = initialAbsolutePath;
  let index = 2;
  while (await fileExists(candidate)) {
    candidate = path.join(parsed.dir, `${parsed.name}-${index}${parsed.ext || ".md"}`);
    index += 1;
  }
  return candidate;
};

const resolveCreateAbsolutePath = async (cwd: string, config: RagitConfig, docType: KnownDocType, title: string, requestedPath?: string): Promise<string> => {
  if (requestedPath) {
    const relative = assertRepoRelativePath(requestedPath, "doc.path");
    return path.resolve(cwd, relative);
  }
  const fileName = `${slugify(title)}.md`;
  const target = path.resolve(cwd, canonicalDirectory(config, docType), fileName);
  return uniqueAbsolutePath(target);
};

const refreshDocumentContent = (docType: KnownDocType, sourcePath: string, source: string): string => {
  const contract = DOC_CONTRACTS[docType];
  const { attributes, body } = splitFrontmatter(source);
  const mergedAttributes = mergeAttributes(attributes, docType);
  const title = fallbackTitleFromPath(sourcePath);
  const withMainTitle = hasH1(body) ? body : `# ${formatMainTitle(docType, title)}\n\n${body.trimStart()}`;
  const sectionEnsured = ensureSectionBlocks(withMainTitle, contract.requiredSections);
  let finalized = sectionEnsured.content;
  if (docType === "pbd" && !TOPOLOGY_HEADING_REGEX.test(finalized)) {
    finalized = `${finalized.trimEnd()}\n\n## [B1] 위상 경계\n${DEFAULT_SECTION_NOTE}\n`;
  }
  return `${renderFrontmatter(mergedAttributes)}${ensureTrailingNewline(finalized)}`;
};

export const validateKnownDoc = (
  docType: KnownDocType,
  sourcePath: string,
  source: string,
  config: RagitConfig,
): DocValidationItem => {
  const contract = DOC_CONTRACTS[docType];
  const { attributes, body } = splitFrontmatter(source);
  const headings = collectHeadings(body);
  const violations: string[] = [];
  const normalizedType = normalizeKnownDocType(attributes.type);
  if (normalizedType !== docType) {
    violations.push(`frontmatter.type 값이 ${docType}와 일치하지 않습니다.`);
  }
  if (!hasH1(body)) {
    violations.push("문서의 H1 제목이 없습니다.");
  }
  for (const section of contract.requiredSections) {
    if (!headings.has(normalizeHeading(section))) {
      violations.push(`필수 섹션 누락: ${section}`);
    }
  }
  if (docType === "pbd" && !TOPOLOGY_HEADING_REGEX.test(body)) {
    violations.push("pbd 문서에 위상 식별자 헤더([B1] 등)가 없습니다.");
  }
  return {
    path: sourcePath,
    docType,
    canonicalPath: canonicalPathForSource(config, docType, sourcePath),
    violations,
  };
};

const buildAuthorityIndex = async (cwd: string, config: RagitConfig): Promise<DocAuthorityIndex> => {
  const files = await listAllDocumentFiles(cwd);
  const entries: DocAuthorityIndexEntry[] = [];
  for (const absolutePath of files) {
    const sourcePath = toRepoPath(cwd, absolutePath);
    const { content, hash } = await hashFileContent(absolutePath);
    const detected = detectDocType(absolutePath, content, cwd);
    if (!isKnownDocType(detected.docType)) continue;
    const validation = validateKnownDoc(detected.docType, sourcePath, content, config);
    entries.push({
      sourcePath,
      canonicalPath: validation.canonicalPath,
      docType: detected.docType,
      hash,
      status: sourcePath === validation.canonicalPath ? "canonical" : "mapped",
      violations: validation.violations,
    });
  }
  entries.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
  const now = new Date().toISOString();
  const violationCount = entries.reduce((sum, entry) => sum + entry.violations.length, 0);
  return {
    version: RAGIT_VERSION,
    generatedAt: now,
    lastReconciledAt: now,
    tracked: entries.length,
    violations: violationCount,
    entries,
  };
};

export const readDocAuthorityIndex = async (cwd: string): Promise<DocAuthorityIndex | null> => {
  const paths = resolveRagitPaths(cwd);
  try {
    const content = await readFile(paths.docsIndexPath, "utf8");
    return JSON.parse(content) as DocAuthorityIndex;
  } catch {
    return null;
  }
};

export const createDoc = async (cwd: string, input: DocCreateInput, dryRun = false): Promise<DocCreateResult> => {
  await ensureRagitStructure(cwd);
  const config = await loadConfig(cwd);
  const absolutePath = await resolveCreateAbsolutePath(cwd, config, input.docType, input.title, input.path);
  const repoPath = toPosixPath(toRepoPath(cwd, absolutePath));

  if (await fileExists(absolutePath)) {
    throw new Error(`이미 존재하는 문서입니다: ${repoPath}`);
  }

  const template = input.content ? null : await readTemplate(cwd, input.docType, !dryRun);
  const base = input.content
    ? input.content
    : template
      ? applyTitleToTemplate(input.docType, input.title, template)
      : renderFallbackDocument(input.docType, input.title);
  const refreshed = refreshDocumentContent(input.docType, repoPath, base);

  if (!dryRun) {
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, refreshed, "utf8");
  }

  return {
    dryRun,
    docType: input.docType,
    path: repoPath,
    canonicalPath: canonicalPathForSource(config, input.docType, repoPath),
    status: dryRun ? "planned" : "created",
    usedTemplate: Boolean(template),
  };
};

const resolveRefreshTargets = async (cwd: string, files?: string): Promise<string[]> => {
  if (!files) return listAllDocumentFiles(cwd);
  return listDocumentFilesByGlob(cwd, files);
};

export const refreshDocs = async (cwd: string, input: DocRefreshInput, dryRun = false): Promise<DocRefreshResult> => {
  await ensureRagitStructure(cwd);
  const config = await loadConfig(cwd);
  const targets = await resolveRefreshTargets(cwd, input.files);

  const plannedFiles: string[] = [];
  const refreshedFiles: string[] = [];
  const unchangedFiles: string[] = [];
  const skippedFiles: string[] = [];
  const warnings: string[] = [];
  let violationsBefore = 0;
  let violationsAfter = 0;

  for (const absolutePath of targets) {
    const repoPath = toPosixPath(toRepoPath(cwd, absolutePath));
    const { content } = await hashFileContent(absolutePath);
    const detected = detectDocType(absolutePath, content, cwd);
    if (!isKnownDocType(detected.docType)) {
      skippedFiles.push(repoPath);
      continue;
    }
    if (input.docType && detected.docType !== input.docType) {
      skippedFiles.push(repoPath);
      continue;
    }
    const before = validateKnownDoc(detected.docType, repoPath, content, config);
    violationsBefore += before.violations.length;

    const refreshed = refreshDocumentContent(detected.docType, repoPath, content);
    const after = validateKnownDoc(detected.docType, repoPath, refreshed, config);
    violationsAfter += after.violations.length;

    if (refreshed === ensureTrailingNewline(content)) {
      unchangedFiles.push(repoPath);
      continue;
    }

    plannedFiles.push(repoPath);
    if (!dryRun) {
      await writeFile(absolutePath, refreshed, "utf8");
      refreshedFiles.push(repoPath);
    }
  }

  if (plannedFiles.length === 0) {
    warnings.push("정합화할 문서가 없습니다.");
  }

  const reconcile = await reconcileDocs(cwd, { dryRun, config, ensureStructure: false });

  return {
    dryRun,
    plannedFiles,
    refreshedFiles,
    unchangedFiles,
    skippedFiles,
    violationsBefore,
    violationsAfter,
    reconcile,
    warnings,
  };
};

export const validateDocs = async (cwd: string, options: { docType?: KnownDocType; all?: boolean; files?: string } = {}): Promise<DocValidateResult> => {
  await ensureRagitStructure(cwd);
  const config = await loadConfig(cwd);
  const targets = await resolveRefreshTargets(cwd, options.files);
  const items: DocValidationItem[] = [];

  for (const absolutePath of targets) {
    const repoPath = toPosixPath(toRepoPath(cwd, absolutePath));
    const { content } = await hashFileContent(absolutePath);
    const detected = detectDocType(absolutePath, content, cwd);
    if (!isKnownDocType(detected.docType)) continue;
    if (options.docType && detected.docType !== options.docType) continue;
    items.push(validateKnownDoc(detected.docType, repoPath, content, config));
  }

  const violations = items.reduce((sum, item) => sum + item.violations.length, 0);
  return {
    checkedFiles: items.length,
    tracked: items.length,
    violations,
    files: items,
  };
};

export const reconcileDocs = async (cwd: string, options: DocReconcileOptions = {}): Promise<DocReconcileResult> => {
  const dryRun = Boolean(options.dryRun);
  if (options.ensureStructure ?? true) {
    await ensureRagitStructure(cwd);
  }
  const config = options.config ?? (await loadConfig(cwd));
  const paths = resolveRagitPaths(cwd);

  const existed = await fileExists(paths.docsIndexPath);
  const index = await buildAuthorityIndex(cwd, config);

  if (!dryRun) {
    await mkdir(paths.docsDir, { recursive: true });
    await writeFile(paths.docsIndexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  }

  return {
    dryRun,
    indexPath: toPosixPath(toRepoPath(cwd, paths.docsIndexPath)),
    status: dryRun ? "planned" : existed ? "loaded" : "created",
    tracked: index.tracked,
    violations: index.violations,
    lastReconciledAt: index.lastReconciledAt,
    entries: index.entries,
  };
};

export const inspectDocAuthority = async (cwd: string): Promise<{ status: "planned" | "loaded"; tracked: number; violations: number; lastReconciledAt: string | null; indexPath: string }> => {
  const paths = resolveRagitPaths(cwd);
  const repoPath = toPosixPath(toRepoPath(cwd, paths.docsIndexPath));
  const current = await readDocAuthorityIndex(cwd);
  if (!current) {
    return {
      status: "planned",
      tracked: 0,
      violations: 0,
      lastReconciledAt: null,
      indexPath: repoPath,
    };
  }
  return {
    status: "loaded",
    tracked: current.tracked,
    violations: current.violations,
    lastReconciledAt: current.lastReconciledAt,
    indexPath: repoPath,
  };
};

export const coerceKnownDocType = (value: string): KnownDocType => {
  const normalized = normalizeKnownDocType(value);
  if (!normalized) {
    throw new Error(`지원하지 않는 문서 타입입니다: ${value}`);
  }
  return normalized;
};
