import { assertAllowedKeys, assertRepoRelativePathArray, assertSafeGlobText } from "./cliInput.js";
import { RetrievalScope } from "./types.js";

export interface QueryCommandInput {
  question: string;
  topK?: number;
  at?: string;
  scope?: RetrievalScope;
  explain?: boolean;
}

export interface ContextPackCommandInput {
  goal: string;
  budget?: number;
  at?: string;
  scope?: RetrievalScope;
}

export interface IngestCommandInput {
  all?: boolean;
  since?: string;
  files?: string;
  paths?: string[];
  scope?: "durable" | "all";
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

const asOptionalPositiveSafeInteger = (value: unknown, label: string): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} 값은 양의 안전한 정수여야 합니다.`);
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

const asOptionalStringArray = (value: unknown, label: string): string[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`${label} 값은 string[] 이어야 합니다.`);
  }
  const values = value.map((entry, index) => asTrimmedString(entry, `${label}[${index}]`));
  return values;
};

const asOptionalRetrievalScope = (value: unknown, label: string): RetrievalScope | undefined => {
  if (value === undefined) return undefined;
  const normalized = asTrimmedString(value, label).toLowerCase();
  if (normalized === "durable" || normalized === "session" || normalized === "harness" || normalized === "evidence" || normalized === "all") {
    return normalized;
  }
  throw new Error(`${label} 값은 durable|session|harness|evidence|all 중 하나여야 합니다.`);
};

const asOptionalIngestScope = (value: unknown, label: string): "durable" | "all" | undefined => {
  if (value === undefined) return undefined;
  const normalized = asTrimmedString(value, label).toLowerCase();
  if (normalized === "durable" || normalized === "all") {
    return normalized;
  }
  throw new Error(`${label} 값은 durable|all 중 하나여야 합니다.`);
};

export const normalizeQueryCommandInput = (value: unknown): QueryCommandInput => {
  const raw = asObject(value, "query");
  assertAllowedKeys(raw, ["question", "topK", "at", "scope", "explain"], "query");
  return {
    question: asTrimmedString(raw.question, "query.question"),
    topK: asOptionalNumber(raw.topK, "query.topK"),
    at: raw.at === undefined ? undefined : asTrimmedString(raw.at, "query.at"),
    scope: asOptionalRetrievalScope(raw.scope, "query.scope"),
    explain: asOptionalBoolean(raw.explain, "query.explain"),
  };
};

export const normalizeContextPackCommandInput = (value: unknown): ContextPackCommandInput => {
  const raw = asObject(value, "context pack");
  assertAllowedKeys(raw, ["goal", "budget", "at", "scope"], "context pack");
  return {
    goal: asTrimmedString(raw.goal, "context.goal"),
    budget: asOptionalPositiveSafeInteger(raw.budget, "context.budget"),
    at: raw.at === undefined ? undefined : asTrimmedString(raw.at, "context.at"),
    scope: asOptionalRetrievalScope(raw.scope, "context.scope"),
  };
};

export const normalizeIngestCommandInput = (value: unknown): IngestCommandInput => {
  const raw = asObject(value, "ingest");
  assertAllowedKeys(raw, ["all", "since", "files", "paths", "scope"], "ingest");
  const all = asOptionalBoolean(raw.all, "ingest.all");
  const since = raw.since === undefined ? undefined : asTrimmedString(raw.since, "ingest.since");
  const files = raw.files === undefined ? undefined : assertSafeGlobText(asTrimmedString(raw.files, "ingest.files"), "ingest.files");
  const paths = raw.paths === undefined ? undefined : assertRepoRelativePathArray(asOptionalStringArray(raw.paths, "ingest.paths") ?? [], "ingest.paths");
  const scope = asOptionalIngestScope(raw.scope, "ingest.scope");
  return { all, since, files, paths, scope };
};
