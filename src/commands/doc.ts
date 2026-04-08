import { buildCliEnvelope, CliFormat, emitCliOutput } from "../core/cliContract.js";
import {
  coerceKnownDocType,
  createDoc,
  readDocAuthorityIndex,
  reconcileDocs,
  refreshDocs,
  validateDocs,
} from "../core/doc-authority.js";

const formatDocCreateText = (result: Awaited<ReturnType<typeof createDoc>>, reconcile: Awaited<ReturnType<typeof reconcileDocs>>) =>
  [
    "# ragit doc create",
    `- dry_run: ${result.dryRun}`,
    `- status: ${result.status}`,
    `- type: ${result.docType}`,
    `- path: ${result.path}`,
    `- canonical_path: ${result.canonicalPath}`,
    `- used_template: ${result.usedTemplate}`,
    `- reconcile_status: ${reconcile.status}`,
    `- tracked: ${reconcile.tracked}`,
    `- violations: ${reconcile.violations}`,
  ].join("\n");

const formatDocRefreshText = (result: Awaited<ReturnType<typeof refreshDocs>>) =>
  [
    "# ragit doc refresh",
    `- dry_run: ${result.dryRun}`,
    `- planned_files: ${result.plannedFiles.length}`,
    `- refreshed_files: ${result.refreshedFiles.length}`,
    `- unchanged_files: ${result.unchangedFiles.length}`,
    `- skipped_files: ${result.skippedFiles.length}`,
    `- violations_before: ${result.violationsBefore}`,
    `- violations_after: ${result.violationsAfter}`,
    `- reconcile_status: ${result.reconcile.status}`,
    `- tracked: ${result.reconcile.tracked}`,
    `- violations: ${result.reconcile.violations}`,
  ].join("\n");

const formatDocValidateText = (result: Awaited<ReturnType<typeof validateDocs>>) =>
  [
    "# ragit doc validate",
    `- checked_files: ${result.checkedFiles}`,
    `- tracked: ${result.tracked}`,
    `- violations: ${result.violations}`,
  ].join("\n");

const formatDocReconcileText = (result: Awaited<ReturnType<typeof reconcileDocs>>) =>
  [
    "# ragit doc reconcile",
    `- dry_run: ${result.dryRun}`,
    `- status: ${result.status}`,
    `- index_path: ${result.indexPath}`,
    `- tracked: ${result.tracked}`,
    `- violations: ${result.violations}`,
    `- last_reconciled_at: ${result.lastReconciledAt}`,
  ].join("\n");

export const runDocCreateCommand = async (
  cwd: string,
  input: { docType: string; title: string; path?: string },
  format: CliFormat,
  dryRun = false,
): Promise<void> => {
  const result = await createDoc(
    cwd,
    {
      docType: coerceKnownDocType(input.docType),
      title: input.title,
      path: input.path,
    },
    dryRun,
  );
  const reconcile = await reconcileDocs(cwd, { dryRun });
  const data = {
    ...result,
    reconcile,
  };
  const envelope = buildCliEnvelope("doc create", cwd, data);
  emitCliOutput({
    envelope,
    format,
    text: formatDocCreateText(result, reconcile),
  });
};

export const runDocRefreshCommand = async (
  cwd: string,
  input: { docType?: string; files?: string },
  format: CliFormat,
  dryRun = false,
): Promise<void> => {
  const result = await refreshDocs(
    cwd,
    {
      docType: input.docType ? coerceKnownDocType(input.docType) : undefined,
      files: input.files,
    },
    dryRun,
  );
  const envelope = buildCliEnvelope("doc refresh", cwd, result, result.warnings);
  emitCliOutput({
    envelope,
    format,
    text: formatDocRefreshText(result),
  });
};

export const runDocValidateCommand = async (
  cwd: string,
  input: { docType?: string; all?: boolean },
  format: CliFormat,
): Promise<void> => {
  if (input.docType && input.all) {
    throw new Error("doc validate는 --type과 --all을 함께 사용할 수 없습니다.");
  }
  const result = await validateDocs(cwd, {
    docType: input.docType ? coerceKnownDocType(input.docType) : undefined,
    all: input.all,
  });
  const envelope = buildCliEnvelope("doc validate", cwd, result);
  emitCliOutput({
    envelope,
    format,
    text: formatDocValidateText(result),
  });
};

export const runDocReconcileCommand = async (cwd: string, format: CliFormat, dryRun = false): Promise<void> => {
  const result = await reconcileDocs(cwd, { dryRun });
  const envelope = buildCliEnvelope("doc reconcile", cwd, result);
  emitCliOutput({
    envelope,
    format,
    text: formatDocReconcileText(result),
  });
};

export const readDocAuthoritySummary = async (
  cwd: string,
): Promise<{ tracked: number; violations: number; lastReconciledAt: string | null } | null> => {
  const index = await readDocAuthorityIndex(cwd);
  if (!index) return null;
  return {
    tracked: index.tracked,
    violations: index.violations,
    lastReconciledAt: index.lastReconciledAt,
  };
};
