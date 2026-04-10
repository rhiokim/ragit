import { buildCliEnvelope, CliFormat, CliView, emitCliOutput } from "../core/cliContract.js";
import { DriftQueryOptions, formatDriftText, runDrift } from "../core/drift.js";

export const runDriftCommand = async (
  cwd: string,
  filters: DriftQueryOptions,
  format: CliFormat,
  view: CliView,
): Promise<void> => {
  const result = await runDrift(cwd, filters);
  emitCliOutput({
    envelope: buildCliEnvelope("drift", cwd, result),
    format,
    text: formatDriftText(result, view),
  });
};
