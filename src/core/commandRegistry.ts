export interface CommandArgumentSpec {
  name: string;
  type: "string" | "number" | "path" | "json";
  required: boolean;
  description: string;
}

export interface CommandOptionSpec {
  name: string;
  type: "boolean" | "string" | "number" | "path" | "enum";
  required?: boolean;
  description: string;
  enum?: string[];
  defaultValue?: string | number | boolean;
}

export interface CommandDescribeSpec {
  path: string;
  description: string;
  mutating: boolean;
  supportsDryRun: boolean;
  supportsRawJsonInput: boolean;
  outputSchemaSummary: string[];
  arguments: CommandArgumentSpec[];
  options: CommandOptionSpec[];
  examples: string[];
}

const COMMAND_SPECS: CommandDescribeSpec[] = [
  {
    path: "query",
    description: "snapshot 범위에서 지식을 검색합니다.",
    mutating: false,
    supportsDryRun: false,
    supportsRawJsonInput: true,
    outputSchemaSummary: ["query", "snapshotSha", "hits[]"],
    arguments: [{ name: "question", type: "string", required: false, description: "검색 질문" }],
    options: [
      { name: "--input", type: "path", description: "JSON 입력 파일 경로 또는 -" },
      { name: "--top-k", type: "number", description: "검색 결과 개수", defaultValue: 5 },
      { name: "--at", type: "string", description: "조회할 snapshot SHA 또는 prefix" },
      { name: "--view", type: "enum", description: "출력 축소 수준", enum: ["minimal", "default", "full"], defaultValue: "default" },
      { name: "--format", type: "enum", description: "출력 형식", enum: ["text", "json", "both"], defaultValue: "both" },
    ],
    examples: [
      'ragit query "restore auth context" --format json',
      "ragit query --input query.json --view minimal",
    ],
  },
  {
    path: "context pack",
    description: "목표 기준 컨텍스트 패킷을 생성합니다.",
    mutating: false,
    supportsDryRun: false,
    supportsRawJsonInput: true,
    outputSchemaSummary: ["goal", "snapshotSha", "budget", "usedTokens", "selectedHits", "hits[]"],
    arguments: [{ name: "goal", type: "string", required: false, description: "컨텍스트를 만들 목표" }],
    options: [
      { name: "--input", type: "path", description: "JSON 입력 파일 경로 또는 -" },
      { name: "--budget", type: "number", description: "토큰 예산", defaultValue: 1200 },
      { name: "--at", type: "string", description: "조회할 snapshot SHA 또는 prefix" },
      { name: "--view", type: "enum", description: "출력 축소 수준", enum: ["minimal", "default", "full"], defaultValue: "default" },
      { name: "--format", type: "enum", description: "출력 형식", enum: ["text", "json", "both"], defaultValue: "both" },
    ],
    examples: [
      'ragit context pack "implementation plan for auth" --budget 1200',
      "ragit context pack --input context-pack.json --view minimal --format json",
    ],
  },
  {
    path: "memory wrap",
    description: "세션 상태를 working memory에 기록합니다.",
    mutating: true,
    supportsDryRun: true,
    supportsRawJsonInput: true,
    outputSchemaSummary: ["sessionId", "sessionPath", "currentPath", "openLoopsPath", "sourceHeadSha", "dryRun"],
    arguments: [],
    options: [
      { name: "--input", type: "path", required: true, description: "JSON 입력 파일 경로 또는 -" },
      { name: "--dry-run", type: "boolean", description: "쓰기 없이 계획만 검증" },
      { name: "--format", type: "enum", description: "출력 형식", enum: ["text", "json", "both"], defaultValue: "json" },
    ],
    examples: [
      "ragit memory wrap --input session-wrap.json",
      "ragit memory wrap --input - --dry-run --format json",
    ],
  },
  {
    path: "memory recall",
    description: "working memory와 snapshot retrieval을 합쳐 recall packet을 만듭니다.",
    mutating: false,
    supportsDryRun: false,
    supportsRawJsonInput: false,
    outputSchemaSummary: ["goal", "constraints", "openLoops", "relatedDecisions", "retrievedHits", "nextActions"],
    arguments: [{ name: "goal", type: "string", required: true, description: "복원할 목표" }],
    options: [
      { name: "--view", type: "enum", description: "출력 축소 수준", enum: ["minimal", "default", "full"], defaultValue: "default" },
      { name: "--format", type: "enum", description: "출력 형식", enum: ["text", "json", "both"], defaultValue: "both" },
    ],
    examples: [
      'ragit memory recall "resume auth flow" --view minimal',
      'ragit memory recall "resume auth flow" --format json',
    ],
  },
  {
    path: "memory promote",
    description: "promotion candidate를 docs/memory 문서로 승격합니다.",
    mutating: true,
    supportsDryRun: true,
    supportsRawJsonInput: true,
    outputSchemaSummary: ["createdFiles", "plannedFiles", "sourceHeadSha", "ingested", "dryRun", "warnings"],
    arguments: [],
    options: [
      { name: "--input", type: "path", required: true, description: "JSON 입력 파일 경로 또는 -" },
      { name: "--dry-run", type: "boolean", description: "쓰기 없이 계획만 검증" },
      { name: "--format", type: "enum", description: "출력 형식", enum: ["text", "json", "both"], defaultValue: "json" },
    ],
    examples: [
      "ragit memory promote --input promotion-batch.json",
      "ragit memory promote --input promotion-batch.json --dry-run --format json",
    ],
  },
  {
    path: "ingest",
    description: "문서를 인덱싱하고 snapshot manifest를 갱신합니다.",
    mutating: true,
    supportsDryRun: true,
    supportsRawJsonInput: true,
    outputSchemaSummary: ["mode", "processed", "skipped", "masked", "commitSha", "manifestPath", "plannedFiles", "deletedDocumentIds"],
    arguments: [],
    options: [
      { name: "--input", type: "path", description: "JSON 입력 파일 경로 또는 -" },
      { name: "--all", type: "boolean", description: "전체 문서 인덱싱" },
      { name: "--since", type: "string", description: "지정 SHA 이후 변경분 인덱싱" },
      { name: "--files", type: "string", description: "특정 glob 인덱싱" },
      { name: "--dry-run", type: "boolean", description: "쓰기 없이 계획만 검증" },
      { name: "--format", type: "enum", description: "출력 형식", enum: ["text", "json", "both"], defaultValue: "json" },
    ],
    examples: [
      "ragit ingest --all --format json",
      "ragit ingest --input ingest.json --dry-run",
    ],
  },
];

const normalizePath = (value: string): string => value.trim().replace(/\s+/g, " ");

export const listDescribableCommands = (): string[] => COMMAND_SPECS.map((spec) => spec.path);

export const describeCommandPath = (path: string): CommandDescribeSpec => {
  const normalized = normalizePath(path);
  const match = COMMAND_SPECS.find((spec) => spec.path === normalized);
  if (!match) {
    throw new Error(`설명 가능한 command가 아닙니다: ${path}`);
  }
  return match;
};

