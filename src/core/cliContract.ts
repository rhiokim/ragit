import { RAGIT_VERSION } from "./version.js";

export type CliFormat = "text" | "json" | "both";
export type CliView = "minimal" | "default" | "full";

export interface CliEnvelope<T> {
  command: string;
  ok: boolean;
  version: string;
  cwd: string;
  data: T;
  warnings: string[];
}

const FORMAT_ALIASES: Record<string, CliFormat> = {
  both: "both",
  json: "json",
  markdown: "text",
  table: "text",
  text: "text",
};

const VIEW_VALUES: CliView[] = ["minimal", "default", "full"];

export const normalizeCliFormat = (value?: string, fallback: CliFormat = "text"): CliFormat => {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  const resolved = FORMAT_ALIASES[normalized];
  if (!resolved) {
    throw new Error(`지원하지 않는 output format입니다: ${value}`);
  }
  return resolved;
};

export const normalizeCliView = (value?: string, fallback: CliView = "default"): CliView => {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (!VIEW_VALUES.includes(normalized as CliView)) {
    throw new Error(`지원하지 않는 view입니다: ${value}`);
  }
  return normalized as CliView;
};

export const buildCliEnvelope = <T>(
  command: string,
  cwd: string,
  data: T,
  warnings: string[] = [],
  ok = true,
): CliEnvelope<T> => ({
  command,
  ok,
  version: RAGIT_VERSION,
  cwd,
  data,
  warnings,
});

export const emitCliOutput = <T>(params: {
  envelope: CliEnvelope<T>;
  format: CliFormat;
  text?: string;
}): void => {
  const json = JSON.stringify(params.envelope, null, 2);
  if (params.format === "text") {
    if (params.text) console.log(params.text);
    return;
  }
  if (params.format === "json") {
    console.log(json);
    return;
  }
  if (params.text) console.log(params.text);
  console.log(json);
};
