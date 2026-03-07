import { readFile } from "node:fs/promises";
import path from "node:path";
import { formatRecallPacket, normalizePromotionBatchInput, normalizeSessionWrapInput, promoteMemory, recallMemory, runMemoryWrap } from "../core/memory.js";
import { OutputFormat } from "../core/output.js";

const readStdin = async (): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    process.stdin.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    process.stdin.on("error", reject);
  });

const readJsonInput = async (cwd: string, input: string): Promise<unknown> => {
  const raw = input === "-" ? await readStdin() : await readFile(path.resolve(cwd, input), "utf8");
  try {
    return JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`JSON 입력을 파싱할 수 없습니다: ${message}`);
  }
};

export const runMemoryWrapCommand = async (cwd: string, input: string): Promise<void> => {
  const payload = normalizeSessionWrapInput(await readJsonInput(cwd, input));
  const result = await runMemoryWrap(cwd, payload);
  console.log(JSON.stringify(result, null, 2));
};

export const runMemoryRecallCommand = async (cwd: string, goal: string, format: OutputFormat = "both"): Promise<void> => {
  const result = await recallMemory(cwd, goal);
  const formatted = formatRecallPacket(result.packet);
  if (format === "markdown") {
    console.log(formatted.markdown);
    return;
  }
  if (format === "json") {
    console.log(formatted.json);
    return;
  }
  console.log(formatted.markdown);
  console.log(formatted.json);
};

export const runMemoryPromoteCommand = async (cwd: string, input: string): Promise<void> => {
  const raw = await readJsonInput(cwd, input);
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
  const result = await promoteMemory(cwd, normalized);
  console.log(JSON.stringify(result, null, 2));
};
