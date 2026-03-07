import { readFile } from "node:fs/promises";
import path from "node:path";

const DISALLOWED_CONTROL_CHAR_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

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

const ensureInputPathInsideRepo = (cwd: string, inputPath: string): string => {
  const resolved = path.resolve(cwd, inputPath);
  const relative = path.relative(cwd, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`repo 밖 input 경로는 허용되지 않습니다: ${inputPath}`);
  }
  return resolved;
};

const scanControlCharacters = (value: unknown, trail: string): void => {
  if (typeof value === "string") {
    if (DISALLOWED_CONTROL_CHAR_PATTERN.test(value)) {
      throw new Error(`${trail} 값에 허용되지 않는 control character가 포함되어 있습니다.`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanControlCharacters(entry, `${trail}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      scanControlCharacters(entry, `${trail}.${key}`);
    }
  }
};

export const assertAllowedKeys = (raw: Record<string, unknown>, allowed: string[], label: string): void => {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(raw)) {
    if (!allowedSet.has(key)) {
      throw new Error(`${label}에 예상하지 못한 필드가 있습니다: ${key}`);
    }
  }
};

export const assertRepoRelativePath = (value: string, label: string): string => {
  const normalized = value.trim().replaceAll(path.sep, "/");
  if (!normalized) {
    throw new Error(`${label} 값은 비어 있을 수 없습니다.`);
  }
  if (path.isAbsolute(normalized) || normalized.startsWith("../") || normalized.includes("/../") || normalized === "..") {
    throw new Error(`${label} 값은 repo 내부 상대 경로여야 합니다: ${value}`);
  }
  return normalized;
};

export const assertRepoRelativePathArray = (values: string[], label: string): string[] =>
  values.map((value, index) => assertRepoRelativePath(value, `${label}[${index}]`));

export const assertSafeGlobText = (globText: string, label: string): string => {
  const normalized = globText.trim();
  if (!normalized) {
    throw new Error(`${label} 값은 비어 있을 수 없습니다.`);
  }
  if (DISALLOWED_CONTROL_CHAR_PATTERN.test(normalized)) {
    throw new Error(`${label} 값에 허용되지 않는 control character가 포함되어 있습니다.`);
  }
  const patterns = normalized
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (patterns.length === 0) {
    throw new Error(`${label} 값에 유효한 glob 패턴이 없습니다.`);
  }
  for (const pattern of patterns) {
    if (path.isAbsolute(pattern) || pattern.startsWith("../") || pattern.includes("/../") || pattern === "..") {
      throw new Error(`${label} 값은 repo 내부 glob이어야 합니다: ${pattern}`);
    }
  }
  return patterns.join(",");
};

export const readJsonInput = async (cwd: string, input: string, label: string): Promise<unknown> => {
  const raw = input === "-" ? await readStdin() : await readFile(ensureInputPathInsideRepo(cwd, input), "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} JSON 입력을 파싱할 수 없습니다: ${message}`);
  }
  scanControlCharacters(parsed, label);
  return parsed;
};

