import { buildCliEnvelope, CliFormat, CliView, emitCliOutput } from "../core/cliContract.js";
import { readJsonInput } from "../core/cliInput.js";
import {
  formatRecallPacket,
  normalizePromotionBatchInput,
  normalizeSessionWrapInput,
  projectRecallPacket,
  promoteMemory,
  recallMemory,
  runMemoryWrap,
} from "../core/memory.js";

export const runMemoryWrapCommand = async (
  cwd: string,
  input: string,
  format: CliFormat,
  dryRun = false,
): Promise<void> => {
  const payload = normalizeSessionWrapInput(await readJsonInput(cwd, input, "memory wrap"));
  const result = await runMemoryWrap(cwd, payload, dryRun);
  const envelope = buildCliEnvelope("memory wrap", cwd, result, result.warnings);
  const text = [
    "# ragit memory wrap",
    `- session_id: ${result.sessionId}`,
    `- session_path: ${result.sessionPath}`,
    `- current_path: ${result.currentPath}`,
    `- open_loops_path: ${result.openLoopsPath}`,
    `- source_head: ${result.sourceHeadSha ?? "none"}`,
    `- dry_run: ${result.dryRun}`,
  ].join("\n");
  emitCliOutput({ envelope, format, text });
};

export const runMemoryRecallCommand = async (
  cwd: string,
  goal: string,
  format: CliFormat = "both",
  view: CliView = "default",
): Promise<void> => {
  const result = await recallMemory(cwd, goal);
  const formatted = formatRecallPacket(result.packet, view);
  const envelope = buildCliEnvelope("memory recall", cwd, projectRecallPacket(result.packet, view), result.packet.warnings);
  emitCliOutput({ envelope, format, text: formatted.markdown });
};

export const runMemoryPromoteCommand = async (
  cwd: string,
  input: string,
  format: CliFormat,
  dryRun = false,
): Promise<void> => {
  const raw = await readJsonInput(cwd, input, "memory promote");
  const normalized = normalizePromotionBatchInput(
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? {
          ...(raw as Record<string, unknown>),
          sourceSessionId:
            (raw as Record<string, unknown>).sourceSessionId ??
            (raw as Record<string, unknown>).sessionId,
        }
      : raw,
  );
  const result = await promoteMemory(cwd, normalized, dryRun);
  const envelope = buildCliEnvelope("memory promote", cwd, result, result.warnings);
  const text = [
    "# ragit memory promote",
    `- dry_run: ${result.dryRun}`,
    `- planned_files: ${result.plannedFiles.length}`,
    `- created_files: ${result.createdFiles.length}`,
    `- ingested: ${result.ingested}`,
    `- source_head: ${result.sourceHeadSha ?? "none"}`,
  ].join("\n");
  emitCliOutput({ envelope, format, text });
};

