import { buildCliEnvelope, CliFormat, CliView, emitCliOutput } from "../core/cliContract.js";
import { formatTimelineText, queryTimeline, TimelineQueryOptions } from "../core/event-ledger.js";

export const runTimelineCommand = async (
  cwd: string,
  filters: TimelineQueryOptions,
  format: CliFormat,
  view: CliView,
): Promise<void> => {
  const result = await queryTimeline(cwd, filters);
  emitCliOutput({
    envelope: buildCliEnvelope("timeline", cwd, result),
    format,
    text: formatTimelineText(result, view),
  });
};
