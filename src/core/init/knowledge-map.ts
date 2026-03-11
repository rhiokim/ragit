import { CoverageSummary, DiscoveredDocument, KnowledgeMapEntry, KnowledgeSlot, ScanSummary } from "./types.js";

const SLOT_ORDER: KnowledgeSlot[] = [
  "project",
  "product",
  "architecture",
  "workspace",
  "rules",
  "decisions",
  "operations",
  "glossary",
  "ingestion-policy",
];

const uniqueSorted = (values: Iterable<string>): string[] => [...new Set(values)].sort();

const addSource = (map: Map<KnowledgeSlot, Set<string>>, slot: KnowledgeSlot, source: string): void => {
  const current = map.get(slot) ?? new Set<string>();
  current.add(source);
  map.set(slot, current);
};

export const buildKnowledgeMap = (
  scan: ScanSummary,
  coverage: CoverageSummary,
  documents: DiscoveredDocument[],
): KnowledgeMapEntry[] => {
  const slotSources = new Map<KnowledgeSlot, Set<string>>();

  for (const document of documents) {
    for (const role of document.roles) {
      addSource(slotSources, role, document.path);
    }
  }

  for (const workspaceFile of scan.workspaceFiles) addSource(slotSources, "workspace", workspaceFile);
  for (const ciFile of scan.ciFiles) addSource(slotSources, "operations", ciFile);
  for (const infraFile of scan.infraFiles) addSource(slotSources, "operations", infraFile);
  if (coverage.projectOverview.sources.includes("README.md")) addSource(slotSources, "project", "README.md");
  if (coverage.localDevelopmentGuide.sources.includes("CONTRIBUTING.md")) addSource(slotSources, "rules", "CONTRIBUTING.md");
  addSource(slotSources, "ingestion-policy", ".ragit/config.toml");

  return SLOT_ORDER.map((slot) => ({
    slot,
    sources: uniqueSorted(slotSources.get(slot) ?? []),
  }));
};
