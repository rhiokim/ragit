import { InitMode, InitModeOption, ScanSummary } from "./types.js";

export const normalizeInitMode = (value: string | undefined): InitModeOption => {
  if (!value) return "auto";
  const normalized = value.trim().toLowerCase();
  if (normalized === "auto") return "auto";
  if (normalized === "empty" || normalized === "existing" || normalized === "docs-heavy" || normalized === "monorepo") {
    return normalized;
  }
  throw new Error(`지원하지 않는 init mode입니다: ${value}`);
};

export const detectRepositoryMode = (scan: ScanSummary): InitMode => {
  if (scan.monorepo) return "monorepo";
  if (scan.codeFileCount === 0 && scan.docFileCount <= 1 && scan.buildFiles.length <= 1) {
    return "empty";
  }
  if (scan.docFileCount >= 8 && scan.docFileCount >= Math.max(4, Math.floor(scan.codeFileCount * 0.75))) {
    return "docs-heavy";
  }
  return "existing";
};
