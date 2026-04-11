import { buildCliEnvelope, CliFormat, emitCliOutput } from "../core/cliContract.js";
import { runSecurityAudit, runSecurityPurge } from "../core/security.js";
import { SecurityAuditResult, SecurityPurgeTarget } from "../core/types.js";

const formatAuditFinding = (finding: SecurityAuditResult["findings"][number]): string =>
  `- [${finding.severity}] ${finding.path}${finding.field ? `#${finding.field}` : ""}: ${finding.reason} -> ${finding.suggestedAction}`;

const formatSecurityAuditText = (result: SecurityAuditResult): string =>
  [
    "# ragit security audit",
    `- critical: ${result.summary.critical}`,
    `- warn: ${result.summary.warn}`,
    `- info: ${result.summary.info}`,
    `- quarantine_entries: ${result.summary.quarantineEntries}`,
    `- admission_blocked: ${result.summary.admissionBlocked}`,
    `- admission_quarantined: ${result.summary.admissionQuarantined}`,
    `- legacy_control_plane_files: ${result.summary.legacyControlPlaneFiles}`,
    `- legacy_store_findings: ${result.summary.legacyStoreFindings}`,
    `- repo_docs_flagged: ${result.summary.repoDocsFlagged}`,
    `- provider: ${result.providerEgress.provider}`,
    `- provider_egress_class: ${result.providerEgress.class}`,
    `- remote_embedding_policy: ${result.providerEgress.policy}`,
    `- artifact_remote_embedding_allowed: ${result.providerEgress.artifactRemoteEmbeddingAllowed}`,
    "",
    ...(result.findings.length === 0 ? ["- no findings"] : result.findings.map(formatAuditFinding)),
  ].join("\n");

const formatSecurityPurgeText = (
  result: Awaited<ReturnType<typeof runSecurityPurge>>,
): string =>
  [
    "# ragit security purge",
    `- mode: ${result.mode}`,
    `- target: ${result.target}`,
    `- planned: ${result.planned.length}`,
    `- rewritten: ${result.rewritten.length}`,
    `- deleted: ${result.deleted.length}`,
    `- warnings: ${result.warnings.length}`,
    "",
    ...(result.planned.length === 0 ? ["- no planned targets"] : result.planned.map((item) => `- planned ${item}`)),
    ...(result.rewritten.length === 0 ? [] : ["", ...result.rewritten.map((item) => `- rewritten ${item}`)]),
    ...(result.deleted.length === 0 ? [] : ["", ...result.deleted.map((item) => `- deleted ${item}`)]),
    ...(result.warnings.length === 0 ? [] : ["", ...result.warnings.map((item) => `- warning ${item}`)]),
  ].join("\n");

export const runSecurityAuditCommand = async (
  cwd: string,
  format: CliFormat,
): Promise<void> => {
  const result = await runSecurityAudit(cwd);
  emitCliOutput({
    envelope: buildCliEnvelope("security audit", cwd, result),
    format,
    text: formatSecurityAuditText(result),
  });
};

export const runSecurityPurgeCommand = async (
  cwd: string,
  target: SecurityPurgeTarget,
  format: CliFormat,
  dryRun = false,
): Promise<void> => {
  const result = await runSecurityPurge(cwd, target, dryRun);
  emitCliOutput({
    envelope: buildCliEnvelope("security purge", cwd, result, result.warnings),
    format,
    text: formatSecurityPurgeText(result),
  });
};
