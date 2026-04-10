import { buildCliEnvelope, CliFormat, CliView, emitCliOutput } from "../core/cliContract.js";
import { formatRepairText, RepairOptions, runRepair } from "../core/repair.js";

export const runRepairCommand = async (
  cwd: string,
  options: RepairOptions,
  format: CliFormat,
  view: CliView,
): Promise<void> => {
  const result = await runRepair(cwd, options);
  emitCliOutput({
    envelope: buildCliEnvelope("repair", cwd, result, result.warnings, result.summary.failed === 0),
    format,
    text: formatRepairText(result, view),
  });
};
