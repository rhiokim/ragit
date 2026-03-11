import { DocType } from "../types.js";

export type InitExecutionMode = "interactive" | "non-interactive";
export type InitMode = "empty" | "existing" | "docs-heavy" | "monorepo";
export type InitModeOption = "auto" | InitMode;
export type InitStrategy = "minimal" | "balanced" | "full";
export type CoverageStatus = "sufficient" | "partial" | "missing";
export type ConfidenceLevel = "high" | "medium" | "low";
export type KnowledgeSlot =
  | "project"
  | "product"
  | "architecture"
  | "workspace"
  | "rules"
  | "decisions"
  | "operations"
  | "glossary"
  | "ingestion-policy";

export interface ScanSummary {
  gitDetected: boolean;
  packageManager: "pnpm" | "npm" | "yarn" | "bun" | null;
  languages: string[];
  frameworks: string[];
  monorepo: boolean;
  workspaceFiles: string[];
  apps: string[];
  packages: string[];
  codeFileCount: number;
  docFileCount: number;
  existingDocs: string[];
  ciFiles: string[];
  infraFiles: string[];
  buildFiles: string[];
}

export interface CoverageSignal {
  status: CoverageStatus;
  sources: string[];
}

export interface CoverageSummary {
  projectOverview: CoverageSignal;
  localDevelopmentGuide: CoverageSignal;
  architectureRationale: CoverageSignal;
  decisionRecords: CoverageSignal;
  packageOwnershipMap: CoverageSignal;
  ingestionPolicy: CoverageSignal;
}

export interface MaturityScore {
  discoverability: number;
  architectureClarity: number;
  operationalReadiness: number;
  agentReadability: number;
}

export interface KnowledgeMapEntry {
  slot: KnowledgeSlot;
  sources: string[];
}

export interface DiscoveredDocument {
  path: string;
  docType: DocType;
  roles: KnowledgeSlot[];
  title: string | null;
}

export interface GapFillAction {
  type: "create" | "reuse" | "skip";
  path: string;
  reason: string;
  confidence: ConfidenceLevel;
  sourcePaths: string[];
}

export interface InitActionSummary {
  mergeExisting: boolean;
  planned: GapFillAction[];
  created: string[];
  reused: string[];
  skipped: string[];
}

export interface InitBootstrapSummary {
  git: {
    wasRepository: boolean;
    initialized: boolean;
  };
  agents: {
    path: string;
    mode: "created" | "loaded" | "planned";
    sha256: string | null;
  };
  guide: {
    indexPath: string;
    createdFiles: string[];
    skippedFiles: string[];
    templates: string[];
  };
  storage: {
    backend: "zvec";
    status: "created" | "loaded" | "planned";
    collections: string[];
    searchReady: false;
    migrationRequired: boolean;
  };
}

export interface InitReport {
  executionMode: InitExecutionMode;
  repositoryMode: InitMode;
  strategy: InitStrategy;
  scan: ScanSummary;
  coverage: CoverageSummary;
  maturity: MaturityScore;
  knowledgeMap: KnowledgeMapEntry[];
  actions: InitActionSummary;
  bootstrap: InitBootstrapSummary;
  nextActions: string[];
}
