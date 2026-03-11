import { CoverageStatus, CoverageSummary, MaturityScore, ScanSummary } from "./types.js";

const scoreStatus = (status: CoverageStatus): number => {
  if (status === "sufficient") return 3;
  if (status === "partial") return 1;
  return 0;
};

const clampTen = (value: number): number => Math.max(0, Math.min(10, value));

export const assessMaturity = (scan: ScanSummary, coverage: CoverageSummary): MaturityScore => ({
  discoverability: clampTen(
    scoreStatus(coverage.projectOverview.status) * 2 +
      scoreStatus(coverage.localDevelopmentGuide.status) +
      scoreStatus(coverage.packageOwnershipMap.status) +
      (scan.docFileCount > 0 ? 1 : 0),
  ),
  architectureClarity: clampTen(
    scoreStatus(coverage.architectureRationale.status) * 2 +
      scoreStatus(coverage.decisionRecords.status) +
      (scan.codeFileCount > 0 ? 1 : 0),
  ),
  operationalReadiness: clampTen(
    scoreStatus(coverage.localDevelopmentGuide.status) +
      scoreStatus(coverage.ingestionPolicy.status) * 2 +
      (scan.ciFiles.length > 0 ? 2 : 0) +
      (scan.packageManager ? 1 : 0),
  ),
  agentReadability: clampTen(
    scoreStatus(coverage.projectOverview.status) +
      scoreStatus(coverage.architectureRationale.status) +
      scoreStatus(coverage.ingestionPolicy.status) * 2 +
      (scan.docFileCount >= 3 ? 2 : scan.docFileCount > 0 ? 1 : 0),
  ),
});
