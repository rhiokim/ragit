import path from "node:path";
import { hashFileContent, listAllDocumentFiles } from "../files.js";
import { detectDocType } from "../docType.js";
import { CoverageSignal, CoverageSummary, DiscoveredDocument, KnowledgeSlot, ScanSummary } from "./types.js";

const titleFromBody = (body: string): string | null =>
  body
    .split(/\r?\n/)
    .find((line) => line.trim().startsWith("#"))
    ?.replace(/^#+\s*/, "")
    .trim() ?? null;

const rolesFromPath = (relativePath: string, docType: DiscoveredDocument["docType"]): KnowledgeSlot[] => {
  const roles = new Set<KnowledgeSlot>();
  const normalized = relativePath.toLowerCase();

  if (normalized === "readme.md") {
    roles.add("project");
    roles.add("product");
  }
  if (normalized === "contributing.md" || normalized.includes("/contributing.md") || /setup|onboarding|getting-started|development/.test(normalized)) {
    roles.add("rules");
  }
  if (/architecture|system-design|technical-overview|infra/.test(normalized)) {
    roles.add("architecture");
  }
  if (/(^|\/)workspace-map\.md$/.test(normalized) || /(apps|packages)\/[^/]+\/readme\.md$/.test(normalized)) {
    roles.add("workspace");
  }
  if (/ingestion-policy/.test(normalized)) {
    roles.add("ingestion-policy");
  }
  if (/runbook|operations|operational|deploy|deployment|playbook/.test(normalized)) {
    roles.add("operations");
  }

  if (docType === "prd") roles.add("product");
  if (docType === "adr") roles.add("decisions");
  if (docType === "ddd") {
    roles.add("architecture");
    roles.add("glossary");
  }
  if (docType === "glossary") roles.add("glossary");
  if (docType === "spec" || docType === "srs") roles.add("architecture");

  return [...roles];
};

const coverageSignal = (status: CoverageSignal["status"], sources: Iterable<string>): CoverageSignal => ({
  status,
  sources: [...new Set(sources)].sort(),
});

export interface DocumentationCensus {
  documents: DiscoveredDocument[];
  coverage: CoverageSummary;
}

export const censusDocumentation = async (cwd: string, scan: ScanSummary): Promise<DocumentationCensus> => {
  const files = await listAllDocumentFiles(cwd);
  const documents: DiscoveredDocument[] = [];
  const slotSources = new Map<KnowledgeSlot, Set<string>>();

  const addSlotSource = (slot: KnowledgeSlot, source: string): void => {
    const current = slotSources.get(slot) ?? new Set<string>();
    current.add(source);
    slotSources.set(slot, current);
  };

  for (const absolutePath of files) {
    const relativePath = path.relative(cwd, absolutePath).replaceAll(path.sep, "/");
    const { content } = await hashFileContent(absolutePath);
    const detected = detectDocType(absolutePath, content, cwd);
    const roles = rolesFromPath(relativePath, detected.docType);
    for (const role of roles) addSlotSource(role, relativePath);
    documents.push({
      path: relativePath,
      docType: detected.docType,
      roles,
      title: titleFromBody(detected.body),
    });
  }

  const getSources = (slot: KnowledgeSlot): string[] => [...(slotSources.get(slot) ?? new Set<string>())].sort();

  const coverage: CoverageSummary = {
    projectOverview: coverageSignal(
      getSources("project").length > 0 ? "sufficient" : scan.docFileCount > 0 ? "partial" : "missing",
      getSources("project"),
    ),
    localDevelopmentGuide: coverageSignal(
      getSources("rules").length > 0 ? "sufficient" : getSources("project").length > 0 ? "partial" : "missing",
      getSources("rules").length > 0 ? getSources("rules") : getSources("project"),
    ),
    architectureRationale: coverageSignal(
      getSources("architecture").length > 0 ? "sufficient" : getSources("decisions").length > 0 ? "partial" : "missing",
      getSources("architecture").length > 0 ? getSources("architecture") : getSources("decisions"),
    ),
    decisionRecords: coverageSignal(
      getSources("decisions").length > 0 ? "sufficient" : getSources("architecture").length > 0 ? "partial" : "missing",
      getSources("decisions").length > 0 ? getSources("decisions") : getSources("architecture"),
    ),
    packageOwnershipMap: coverageSignal(
      getSources("workspace").length > 0 ? "sufficient" : scan.monorepo || scan.workspaceFiles.length > 0 ? "partial" : "missing",
      getSources("workspace").length > 0 ? getSources("workspace") : [...scan.workspaceFiles, ...scan.apps, ...scan.packages],
    ),
    ingestionPolicy: coverageSignal(
      getSources("ingestion-policy").length > 0 ? "sufficient" : scan.buildFiles.includes("package.json") ? "partial" : "missing",
      getSources("ingestion-policy").length > 0 ? getSources("ingestion-policy") : [".ragit/config.toml"],
    ),
  };

  return {
    documents: documents.sort((a, b) => a.path.localeCompare(b.path)),
    coverage,
  };
};
