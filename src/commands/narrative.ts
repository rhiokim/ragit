import { execFile } from "node:child_process";
import path from "node:path";
import { buildCliEnvelope, CliFormat, emitCliOutput } from "../core/cliContract.js";
import { formatNarrativeText, NarrativeOptions, runNarrativeReport } from "../core/narrative.js";

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
  if (options.open && options.dryRun) {
    result.warnings.push("--open은 dry-run에서 무시됩니다.");
  } else if (options.open) {
    try {
      await openReportInBrowser(path.resolve(cwd, result.reportPath));
    } catch {
      result.warnings.push("기본 브라우저를 열 수 없어 report 파일만 생성했습니다.");
    }
  }
  emitCliOutput({
    envelope: buildCliEnvelope("narrative", cwd, result, result.warnings),
    format,
    text: formatNarrativeText(result),
  });
};
