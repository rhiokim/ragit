import path from "node:path";
import { RagitErrorPayload, RagitOperationalError } from "./errors.js";
import { tryGetGitRoot } from "./git.js";
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
  error?: RagitErrorPayload;
}

export type CliFailureEnvelope = CliEnvelope<null> & {
  ok: false;
  error: RagitErrorPayload;
};

export interface CliFailureContext {
  command: string;
  cwd: string;
  format: CliFormat;
}

const FORMAT_ALIASES: Record<string, CliFormat> = {
  both: "both",
  json: "json",
  markdown: "text",
  table: "text",
  text: "text",
};

const VIEW_VALUES: CliView[] = ["minimal", "default", "full"];

const NESTED_COMMANDS = new Set([
  "artifact",
  "config",
  "context",
  "doc",
  "harness",
  "hooks",
  "memory",
  "migrate",
  "security",
  "session",
]);

const FAILURE_FORMAT_DEFAULTS: Record<string, CliFormat> = {
  "context pack": "both",
  ingest: "json",
  "memory recall": "both",
  query: "both",
};

const readRawOption = (argv: string[], name: "cwd" | "format"): string | undefined => {
  const flag = `--${name}`;
  let value: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") break;
    if (argument.startsWith(`${flag}=`)) {
      value = argument.slice(flag.length + 1);
      continue;
    }
    if (argument === flag) {
      const candidate = argv[index + 1];
      if (candidate !== undefined && !candidate.startsWith("--")) {
        value = candidate;
      }
    }
  }
  return value;
};

const resolveFailureCommand = (argv: string[]): string => {
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") break;
    if (argument === "--cwd" || argument === "--format") {
      if (argv[index + 1] !== undefined && !argv[index + 1].startsWith("--")) {
        index += 1;
      }
      continue;
    }
    if (argument.startsWith("--cwd=") || argument.startsWith("--format=") || argument.startsWith("-")) {
      continue;
    }
    positionals.push(argument);
  }

  const rootCommand = positionals[0] ?? "ragit";
  return NESTED_COMMANDS.has(rootCommand) && positionals[1]
    ? `${rootCommand} ${positionals[1]}`
    : rootCommand;
};

const resolveFailureFormat = (command: string, value?: string): CliFormat => {
  const fallback = FAILURE_FORMAT_DEFAULTS[command] ?? "text";
  if (!value) return fallback;
  return FORMAT_ALIASES[value.trim().toLowerCase()] ?? fallback;
};

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

export const buildCliFailureEnvelope = (
  command: string,
  cwd: string,
  error: RagitOperationalError,
  warnings: string[] = [],
): CliFailureEnvelope => ({
  command,
  ok: false,
  version: RAGIT_VERSION,
  cwd,
  data: null,
  warnings,
  error: error.toPayload(),
});

export const resolveCliFailureContext = async (argv: string[]): Promise<CliFailureContext> => {
  const command = resolveFailureCommand(argv);
  const requestedCwd = path.resolve(readRawOption(argv, "cwd") ?? process.cwd());
  return {
    command,
    cwd: (await tryGetGitRoot(requestedCwd)) ?? requestedCwd,
    format: resolveFailureFormat(command, readRawOption(argv, "format")),
  };
};

const formatCliFailureText = (error: RagitErrorPayload): string =>
  [
    "[ragit] operational error",
    `- code: ${error.code}`,
    `- message: ${error.message}`,
    `- retryable: ${error.retryable}`,
    `- details: ${JSON.stringify(error.details)}`,
    `- recovery: ${error.recovery.command}`,
  ].join("\n");

export const emitCliFailure = (params: {
  envelope: CliFailureEnvelope;
  format: CliFormat;
}): void => {
  if (params.format === "text" || params.format === "both") {
    process.stderr.write(`${formatCliFailureText(params.envelope.error)}\n`);
  }
  if (params.format === "json" || params.format === "both") {
    process.stdout.write(`${JSON.stringify(params.envelope, null, 2)}\n`);
  }
};

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
