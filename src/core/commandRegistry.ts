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
  group: "root" | "config" | "context" | "hooks" | "memory" | "migrate";
  docSlug: string;
  relatedCommands: string[];
  stability: "read-only" | "mutating";
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
    path: "init",
    description: "RAGit 프로젝트 구조와 기본 저장소를 초기화합니다.",
    group: "root",
    docSlug: "commands/init",
    relatedCommands: ["hooks install", "ingest", "status"],
    stability: "mutating",
    mutating: true,
    supportsDryRun: false,
    supportsRawJsonInput: false,
    outputSchemaSummary: ["mode", "git", "agents", "guide", "storage", "nextActions[]"],
    arguments: [],
    options: [
      { name: "--cwd", type: "path", description: "대상 저장소 경로" },
      { name: "--yes", type: "boolean", description: "질문 없이 기본값으로 초기화" },
      { name: "--non-interactive", type: "boolean", description: "질문 없이 기본값으로 초기화" },
      { name: "--output", type: "enum", description: "출력 형식", enum: ["text", "json", "both"], defaultValue: "text" },
      { name: "--git-init", type: "boolean", description: "비대화형 모드에서 git 저장소 자동 초기화" },
    ],
    examples: [
      "ragit init --yes --git-init",
      "ragit init --output json",
    ],
  },
  {
    path: "describe",
    description: "command contract와 지원 옵션을 설명합니다.",
    group: "root",
    docSlug: "commands/describe",
    relatedCommands: ["query", "context pack", "memory recall"],
    stability: "read-only",
    mutating: false,
    supportsDryRun: false,
    supportsRawJsonInput: false,
    outputSchemaSummary: ["command", "availableCommands[]", "spec"],
    arguments: [{ name: "commandPath", type: "string", required: true, description: "설명할 command path" }],
    options: [{ name: "--format", type: "enum", description: "출력 형식", enum: ["text", "json", "both"], defaultValue: "json" }],
    examples: [
      "ragit describe query --format json",
      "ragit describe memory promote --format both",
    ],
  },
  {
    path: "config set",
    description: "설정 키를 업데이트합니다.",
    group: "config",
    docSlug: "commands/config/set",
    relatedCommands: ["init", "status", "doctor"],
    stability: "mutating",
    mutating: true,
    supportsDryRun: false,
    supportsRawJsonInput: false,
    outputSchemaSummary: ["stdoutMessage"],
    arguments: [
      { name: "key", type: "string", required: true, description: "업데이트할 설정 키" },
      { name: "value", type: "string", required: true, description: "설정할 값" },
    ],
    options: [{ name: "--cwd", type: "path", description: "대상 저장소 경로" }],
    examples: [
      "ragit config set output.format markdown",
      "ragit config set memory.recall_top_k 8",
    ],
  },
  {
    path: "hooks install",
    description: "ragit 관리 hook를 설치합니다.",
    group: "hooks",
    docSlug: "commands/hooks/install",
    relatedCommands: ["hooks status", "hooks uninstall", "ingest"],
    stability: "mutating",
    mutating: true,
    supportsDryRun: true,
    supportsRawJsonInput: false,
    outputSchemaSummary: ["dryRun", "root", "hooks[]"],
    arguments: [],
    options: [
      { name: "--cwd", type: "path", description: "대상 저장소 경로" },
      { name: "--dry-run", type: "boolean", description: "쓰기 없이 설치 계획만 확인" },
      { name: "--format", type: "enum", description: "출력 형식", enum: ["text", "json", "both"], defaultValue: "text" },
    ],
    examples: [
      "ragit hooks install --dry-run --format json",
      "ragit hooks install --format text",
    ],
  },
  {
    path: "hooks uninstall",
    description: "ragit 관리 hook를 제거합니다.",
    group: "hooks",
    docSlug: "commands/hooks/uninstall",
    relatedCommands: ["hooks install", "hooks status", "ingest"],
    stability: "mutating",
    mutating: true,
    supportsDryRun: true,
    supportsRawJsonInput: false,
    outputSchemaSummary: ["dryRun", "root", "hooks[]"],
    arguments: [],
    options: [
      { name: "--cwd", type: "path", description: "대상 저장소 경로" },
      { name: "--dry-run", type: "boolean", description: "쓰기 없이 제거 계획만 확인" },
      { name: "--format", type: "enum", description: "출력 형식", enum: ["text", "json", "both"], defaultValue: "text" },
    ],
    examples: [
      "ragit hooks uninstall --dry-run --format json",
      "ragit hooks uninstall --format text",
    ],
  },
  {
    path: "hooks status",
    description: "ragit 관리 hook 상태를 확인합니다.",
    group: "hooks",
    docSlug: "commands/hooks/status",
    relatedCommands: ["hooks install", "hooks uninstall", "status"],
    stability: "read-only",
    mutating: false,
    supportsDryRun: false,
    supportsRawJsonInput: false,
    outputSchemaSummary: ["dryRun", "root", "hooks[]"],
    arguments: [],
    options: [
      { name: "--cwd", type: "path", description: "대상 저장소 경로" },
      { name: "--format", type: "enum", description: "출력 형식", enum: ["text", "json", "both"], defaultValue: "json" },
    ],
    examples: [
      "ragit hooks status --format json",
      "ragit hooks status --format both",
    ],
  },
  {
    path: "ingest",
    description: "문서를 인덱싱하고 snapshot manifest를 갱신합니다.",
    group: "root",
    docSlug: "commands/ingest",
    relatedCommands: ["hooks install", "status", "query"],
    stability: "mutating",
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
  {
    path: "query",
    description: "snapshot 범위에서 지식을 검색합니다.",
    group: "root",
    docSlug: "commands/query",
    relatedCommands: ["context pack", "memory recall", "describe"],
    stability: "read-only",
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
    path: "status",
    description: "현재 저장소와 zvec 상태를 요약합니다.",
    group: "root",
    docSlug: "commands/status",
    relatedCommands: ["doctor", "ingest", "hooks status"],
    stability: "read-only",
    mutating: false,
    supportsDryRun: false,
    supportsRawJsonInput: false,
    outputSchemaSummary: ["branch", "head", "backend", "zvec", "supported_types", "manifests", "embedding", "format"],
    arguments: [],
    options: [
      { name: "--format", type: "enum", description: "출력 형식", enum: ["text", "json", "both"], defaultValue: "json" },
      { name: "--cwd", type: "path", description: "대상 저장소 경로" },
    ],
    examples: [
      "ragit status --format json",
      "ragit status --format both",
    ],
  },
  {
    path: "doctor",
    description: "환경과 저장소 일관성을 진단합니다.",
    group: "root",
    docSlug: "commands/doctor",
    relatedCommands: ["status", "init", "ingest"],
    stability: "read-only",
    mutating: false,
    supportsDryRun: false,
    supportsRawJsonInput: false,
    outputSchemaSummary: ["checks[]", "hasFailure"],
    arguments: [],
    options: [
      { name: "--format", type: "enum", description: "출력 형식", enum: ["text", "json", "both"], defaultValue: "text" },
      { name: "--cwd", type: "path", description: "대상 저장소 경로" },
    ],
    examples: [
      "ragit doctor --format both",
      "ragit doctor --format json",
    ],
  },
  {
    path: "context pack",
    description: "목표 기준 컨텍스트 패킷을 생성합니다.",
    group: "context",
    docSlug: "commands/context/pack",
    relatedCommands: ["query", "memory recall", "describe"],
    stability: "read-only",
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
    group: "memory",
    docSlug: "commands/memory/wrap",
    relatedCommands: ["memory recall", "memory promote", "context pack"],
    stability: "mutating",
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
    group: "memory",
    docSlug: "commands/memory/recall",
    relatedCommands: ["memory wrap", "memory promote", "query"],
    stability: "read-only",
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
    group: "memory",
    docSlug: "commands/memory/promote",
    relatedCommands: ["memory wrap", "memory recall", "ingest"],
    stability: "mutating",
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
    path: "migrate from-json-store",
    description: "legacy json store를 zvec 기반 저장소로 변환합니다.",
    group: "migrate",
    docSlug: "commands/migrate/from-json-store",
    relatedCommands: ["migrate from-sqlitevss", "status", "ingest"],
    stability: "mutating",
    mutating: true,
    supportsDryRun: true,
    supportsRawJsonInput: false,
    outputSchemaSummary: ["mode", "docs", "chunks", "snapshotSha"],
    arguments: [],
    options: [
      { name: "--dry-run", type: "boolean", description: "마이그레이션 계획만 확인" },
      { name: "--cwd", type: "path", description: "대상 저장소 경로" },
    ],
    examples: [
      "ragit migrate from-json-store --dry-run",
      "ragit migrate from-json-store",
    ],
  },
  {
    path: "migrate from-sqlitevss",
    description: "sqlite-vss export를 zvec 기반 저장소로 변환합니다.",
    group: "migrate",
    docSlug: "commands/migrate/from-sqlitevss",
    relatedCommands: ["migrate from-json-store", "status", "ingest"],
    stability: "mutating",
    mutating: true,
    supportsDryRun: true,
    supportsRawJsonInput: false,
    outputSchemaSummary: ["mode", "docs", "chunks", "snapshotSha"],
    arguments: [],
    options: [
      { name: "--dry-run", type: "boolean", description: "마이그레이션 계획만 확인" },
      { name: "--cwd", type: "path", description: "대상 저장소 경로" },
    ],
    examples: [
      "ragit migrate from-sqlitevss --dry-run",
      "ragit migrate from-sqlitevss",
    ],
  },
];

const normalizePath = (value: string): string => value.trim().replace(/\s+/g, " ");

export const listCommandSpecs = (): CommandDescribeSpec[] => COMMAND_SPECS.map((spec) => ({
  ...spec,
  relatedCommands: [...spec.relatedCommands],
  outputSchemaSummary: [...spec.outputSchemaSummary],
  arguments: spec.arguments.map((argument) => ({ ...argument })),
  options: spec.options.map((option) => ({ ...option, enum: option.enum ? [...option.enum] : undefined })),
  examples: [...spec.examples],
}));

export const listDescribableCommands = (): string[] => COMMAND_SPECS.map((spec) => spec.path);

export const describeCommandPath = (path: string): CommandDescribeSpec => {
  const normalized = normalizePath(path);
  const match = COMMAND_SPECS.find((spec) => spec.path === normalized);
  if (!match) {
    throw new Error(`설명 가능한 command가 아닙니다: ${path}`);
  }
  return {
    ...match,
    relatedCommands: [...match.relatedCommands],
    outputSchemaSummary: [...match.outputSchemaSummary],
    arguments: match.arguments.map((argument) => ({ ...argument })),
    options: match.options.map((option) => ({ ...option, enum: option.enum ? [...option.enum] : undefined })),
    examples: [...match.examples],
  };
};
