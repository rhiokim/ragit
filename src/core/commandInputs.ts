import { assertAllowedKeys, assertSafeGlobText } from "./cliInput.js";

export interface QueryCommandInput {
  question: string;
  topK?: number;
  at?: string;
}

export interface ContextPackCommandInput {
  goal: string;
  budget?: number;
  at?: string;
}

export interface IngestCommandInput {
  all?: boolean;
  since?: string;
  files?: string;
}

const asObject = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 입력은 JSON 객체여야 합니다.`);
  }
  return value as Record<string, unknown>;
};

const asTrimmedString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} 값은 비어 있지 않은 문자열이어야 합니다.`);
  }
  return value.trim();
};

const asOptionalNumber = (value: unknown, label: string): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || Number.isNaN(value) || value <= 0) {
    throw new Error(`${label} 값은 0보다 큰 number여야 합니다.`);
  }
  return value;
};

const asOptionalBoolean = (value: unknown, label: string): boolean | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`${label} 값은 boolean이어야 합니다.`);
  }
  return value;
};

export const normalizeQueryCommandInput = (value: unknown): QueryCommandInput => {
  const raw = asObject(value, "query");
  assertAllowedKeys(raw, ["question", "topK", "at"], "query");
  return {
    question: asTrimmedString(raw.question, "query.question"),
    topK: asOptionalNumber(raw.topK, "query.topK"),
    at: raw.at === undefined ? undefined : asTrimmedString(raw.at, "query.at"),
  };
};

export const normalizeContextPackCommandInput = (value: unknown): ContextPackCommandInput => {
  const raw = asObject(value, "context pack");
  assertAllowedKeys(raw, ["goal", "budget", "at"], "context pack");
  return {
    goal: asTrimmedString(raw.goal, "context.goal"),
    budget: asOptionalNumber(raw.budget, "context.budget"),
    at: raw.at === undefined ? undefined : asTrimmedString(raw.at, "context.at"),
  };
};

export const normalizeIngestCommandInput = (value: unknown): IngestCommandInput => {
  const raw = asObject(value, "ingest");
  assertAllowedKeys(raw, ["all", "since", "files"], "ingest");
  const all = asOptionalBoolean(raw.all, "ingest.all");
  const since = raw.since === undefined ? undefined : asTrimmedString(raw.since, "ingest.since");
  const files = raw.files === undefined ? undefined : assertSafeGlobText(asTrimmedString(raw.files, "ingest.files"), "ingest.files");
  return { all, since, files };
};

