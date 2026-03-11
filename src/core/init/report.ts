import { CoverageSignal, InitReport } from "./types.js";

const pad = (text: string, size: number): string => `${text}${" ".repeat(Math.max(0, size - text.length))}`;

const formatCoverage = (label: string, signal: CoverageSignal): string =>
  `- ${label}: ${signal.status}${signal.sources.length > 0 ? ` (${signal.sources.join(", ")})` : ""}`;

export const formatInitSummaryTable = (summary: InitReport): string => {
  const plannedCreates = summary.actions.planned.filter((action) => action.type === "create").map((action) => action.path);
  const plannedReuses = summary.actions.reused;
  const lines = [
    "ragit init summary",
    "------------------",
    `${pad("execution mode", 18)}: ${summary.executionMode}`,
    `${pad("repository mode", 18)}: ${summary.repositoryMode}`,
    `${pad("strategy", 18)}: ${summary.strategy}`,
    `${pad("package manager", 18)}: ${summary.scan.packageManager ?? "unknown"}`,
    `${pad("monorepo", 18)}: ${summary.scan.monorepo ? "yes" : "no"}`,
    `${pad("code/docs", 18)}: ${summary.scan.codeFileCount}/${summary.scan.docFileCount}`,
    "",
    "coverage:",
    formatCoverage("project overview", summary.coverage.projectOverview),
    formatCoverage("local development", summary.coverage.localDevelopmentGuide),
    formatCoverage("architecture", summary.coverage.architectureRationale),
    formatCoverage("decision records", summary.coverage.decisionRecords),
    formatCoverage("workspace map", summary.coverage.packageOwnershipMap),
    formatCoverage("ingestion policy", summary.coverage.ingestionPolicy),
    "",
    "planned actions:",
    ...(plannedReuses.length > 0 ? plannedReuses.map((path) => `= ${path}`) : ["= none"]),
    ...(plannedCreates.length > 0 ? plannedCreates.map((path) => `+ ${path}`) : ["+ none"]),
    ...(summary.actions.skipped.length > 0 ? summary.actions.skipped.map((path) => `~ ${path}`) : []),
    "",
    "bootstrap:",
    `- agents: ${summary.bootstrap.agents.mode} (${summary.bootstrap.agents.path})`,
    `- guide-index: ${summary.bootstrap.guide.indexPath}`,
    `- zvec: ${summary.bootstrap.storage.status} (${summary.bootstrap.storage.collections.join(", ") || "documents,chunks"})`,
    "",
    "next actions:",
    ...summary.nextActions.map((action) => `- ${action}`),
  ];
  return lines.join("\n");
};
