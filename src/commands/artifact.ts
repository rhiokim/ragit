import { buildCliEnvelope, CliFormat, emitCliOutput } from "../core/cliContract.js";
import { readJsonInput } from "../core/cliInput.js";
import { normalizeArtifactReviewInput, reviewArtifacts } from "../core/artifacts.js";

export const runArtifactReviewCommand = async (
  cwd: string,
  input: string,
  format: CliFormat,
  dryRun = false,
): Promise<void> => {
  const payload = normalizeArtifactReviewInput(await readJsonInput(cwd, input, "artifact review"));
  const result = await reviewArtifacts(cwd, payload, dryRun);
  emitCliOutput({
    envelope: buildCliEnvelope("artifact review", cwd, result, result.warnings),
    format,
    text: [
      "# ragit artifact review",
      `- updated: ${result.updated.length}`,
      `- dry_run: ${result.dryRun}`,
    ].join("\n"),
  });
};
