import { execFile } from "node:child_process";
import path from "node:path";
import { buildCliEnvelope, CliFormat, emitCliOutput } from "../core/cliContract.js";
import { formatNarrativeText, NarrativeOptions, runNarrativeReport } from "../core/narrative.js";
import {
  NARRATIVE_MODEL_SCHEMA_VERSION,
  NARRATIVE_PROJECTION_MODE,
  NARRATIVE_PROJECTION_POLICY_VERSION,
} from "../core/narrative-model.js";

const openReportInBrowser = async (target: string): Promise<void> =>
  await new Promise((resolve, reject) => {
    const command =
      process.platform === "darwin"
        ? { file: "open", args: [target] }
        : process.platform === "win32"
          ? { file: "cmd", args: ["/c", "start", "", target] }
          : { file: "xdg-open", args: [target] };
    execFile(command.file, command.args, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

export const runNarrativeCommand = async (
  cwd: string,
  options: NarrativeOptions & { open?: boolean },
  format: CliFormat,
): Promise<void> => {
  const result = await runNarrativeReport(cwd, options);
  const cliResult = {
    ...result,
    schemaVersion: NARRATIVE_MODEL_SCHEMA_VERSION,
    projectionPolicyVersion: NARRATIVE_PROJECTION_POLICY_VERSION,
    projectionMode: NARRATIVE_PROJECTION_MODE,
  };
  if (options.open && options.dryRun) {
    cliResult.warnings.push("--open은 dry-run에서 무시됩니다.");
  } else if (options.open) {
    try {
      await openReportInBrowser(path.resolve(cwd, result.reportPath));
    } catch {
      cliResult.warnings.push("기본 브라우저를 열 수 없어 report 파일만 생성했습니다.");
    }
  }
  emitCliOutput({
    envelope: buildCliEnvelope("narrative", cwd, cliResult, cliResult.warnings),
    format,
    text: formatNarrativeText(cliResult),
  });
};
