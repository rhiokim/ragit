import { buildCliEnvelope, CliFormat, emitCliOutput } from "../core/cliContract.js";
import { readJsonInput } from "../core/cliInput.js";
import { normalizeSessionMaterializeInput, sessionMaterialize } from "../core/artifacts.js";

export const runSessionMaterializeCommand = async (
  cwd: string,
  input: string,
  format: CliFormat,
  dryRun = false,
): Promise<void> => {
  const payload = normalizeSessionMaterializeInput(await readJsonInput(cwd, input, "session materialize"));
  const result = await sessionMaterialize(cwd, payload, dryRun);
  emitCliOutput({
    envelope: buildCliEnvelope("session materialize", cwd, result, result.warnings),
    format,
    text: [
      "# ragit session materialize",
      `- session_id: ${result.sessionId}`,
      `- transcript_path: ${result.transcriptPath}`,
      `- event_path: ${result.eventPath}`,
      `- artifact_ids: ${result.artifactIds.length}`,
      `- admission_mode: ${result.admission.mode}`,
      `- admission_quarantined: ${result.admission.quarantined}`,
      `- admission_blocked: ${result.admission.blocked}`,
      `- dry_run: ${result.dryRun}`,
    ].join("\n"),
  });
};
