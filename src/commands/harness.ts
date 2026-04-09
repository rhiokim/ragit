import { buildCliEnvelope, CliFormat, emitCliOutput } from "../core/cliContract.js";
import { readJsonInput } from "../core/cliInput.js";
import {
  captureHarness,
  normalizeHarnessCaptureInput,
  normalizeHarnessPromoteInput,
  packHarness,
  promoteHarness,
  verifyHarness,
} from "../core/harness.js";

export const runHarnessCaptureCommand = async (
  cwd: string,
  input: string,
  format: CliFormat,
  dryRun = false,
): Promise<void> => {
  const payload = normalizeHarnessCaptureInput(await readJsonInput(cwd, input, "harness capture"));
  const result = await captureHarness(cwd, payload, dryRun);
  emitCliOutput({
    envelope: buildCliEnvelope("harness capture", cwd, result, result.warnings),
    format,
    text: [
      "# ragit harness capture",
      `- suite_id: ${result.suiteId}`,
      `- artifact_ids: ${result.artifactIds.length}`,
      `- dry_run: ${result.dryRun}`,
    ].join("\n"),
  });
};

export const runHarnessPromoteCommand = async (
  cwd: string,
  input: string,
  format: CliFormat,
  dryRun = false,
): Promise<void> => {
  const payload = normalizeHarnessPromoteInput(await readJsonInput(cwd, input, "harness promote"));
  const result = await promoteHarness(cwd, payload, dryRun);
  emitCliOutput({
    envelope: buildCliEnvelope("harness promote", cwd, result, result.warnings),
    format,
    text: [
      "# ragit harness promote",
      `- planned_files: ${result.plannedFiles.length}`,
      `- created_files: ${result.createdFiles.length}`,
      `- ingested: ${result.ingested}`,
      `- dry_run: ${result.dryRun}`,
    ].join("\n"),
  });
};

export const runHarnessPackCommand = async (
  cwd: string,
  suiteRef: string,
  format: CliFormat,
): Promise<void> => {
  const result = await packHarness(cwd, suiteRef);
  emitCliOutput({
    envelope: buildCliEnvelope("harness pack", cwd, result),
    format,
    text: [
      "# ragit harness pack",
      `- suite_id: ${result.suiteId}`,
      `- resources: ${result.resources.length}`,
    ].join("\n"),
  });
};

export const runHarnessVerifyCommand = async (
  cwd: string,
  suiteRef: string,
  format: CliFormat,
): Promise<void> => {
  const result = await verifyHarness(cwd, suiteRef);
  emitCliOutput({
    envelope: buildCliEnvelope("harness verify", cwd, result, [], !result.hasFailure),
    format,
    text: [
      "# ragit harness verify",
      `- suite_id: ${result.suiteId}`,
      `- has_failure: ${result.hasFailure}`,
      "",
      ...result.checks.map((check) => `${check.ok ? "OK" : "FAIL"} ${check.name}: ${check.detail}`),
    ].join("\n"),
  });
};
