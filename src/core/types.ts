export const KNOWN_DOC_TYPES = ["adr", "prd", "srs", "spec", "plan", "ddd", "glossary", "pbd"] as const;

export type KnownDocType = (typeof KNOWN_DOC_TYPES)[number];
export type DocType = KnownDocType | "unknown";
export type RetrievalScope = "durable" | "session" | "harness" | "evidence" | "all";
export type DriftScope = "durable" | "memory" | "harness" | "all";
export type DriftStatus = "fresh" | "suspect" | "stale";
export type RepairActionKind =
  | "ingest"
  | "ingest-recover"
  | "doc-refresh"
  | "artifact-review"
  | "harness-verify"
  | "harness-run"
  | "memory-promote";
export type RepairActionStatus = "planned" | "executed" | "blocked" | "skipped" | "failed";
export type DriftReasonCode =
  | "no_baseline"
  | "missing_manifest_anchor"
  | "missing_binding"
  | "binding_local_only"
  | "tracked_path_changed"
  | "related_path_changed"
  | "related_path_missing"
  | "source_head_behind"
  | "bound_head_behind"
  | "failure_evidence_present"
  | "dependency_stale";
export type EmbeddingProvider = "local-placeholder" | "openai" | "ollama";
export type TimelineKind = "session" | "artifact" | "memory" | "harness" | "ingest" | "security";
export type ArtifactStatus = "captured" | "reviewed" | "promoted" | "superseded" | "retracted" | "archived";
export type ArtifactBindingStatus = "pending" | "bound" | "local_only";
export type ArtifactTier = "candidate" | "durable";
export type ArtifactAuthority = "user_asserted" | "assistant_inferred" | "reviewed_harness" | "promoted_durable";
export type ArtifactScope = "session" | "harness";
export type SearchPolicy = "none" | "session" | "harness" | "evidence";
export type SessionArtifactKind = "feedback" | "constraint" | "failure" | "insight" | "openLoop";
export type HarnessArtifactKind =
  | "case"
  | "oracle"
  | "failure"
  | "fixture"
  | "golden"
  | "checker"
  | "rubric"
  | "promptTemplate"
  | "trace"
  | "envAssumption"
  | "suite";
export type ArtifactKind = SessionArtifactKind | HarnessArtifactKind;
export type RagitEventType =
  | "session.materialize"
  | "artifact.review"
  | "memory.wrap"
  | "memory.promote"
  | "harness.capture"
  | "harness.run"
  | "harness.promote"
  | "security.admission"
  | "ingest.completed";

export interface HarnessExpectedRules {
  exitCode?: number;
  mustInclude?: string[];
  mustNotInclude?: string[];
  stderrMustInclude?: string[];
  stderrMustNotInclude?: string[];
  jsonSubset?: Record<string, unknown>;
}

export interface HarnessRunExecutorInput {
  kind: "command";
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface HarnessCommandExecutor {
  kind: "command";
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}

export interface HarnessRecordedExecutor {
  kind: "command";
  argv: string[];
  cwd: string;
  envKeys: string[];
  timeoutMs: number;
}

export interface HarnessRunInput {
  suiteRef: string;
  executor: HarnessRunExecutorInput;
  cases?: string[];
  concurrency?: number;
}

export interface HarnessCheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

export interface HarnessCaseCheckResult extends HarnessCheckResult {
  sourceArtifactId: string | null;
  sourceKind: HarnessArtifactKind | "case";
}

export type HarnessCaseStatus = "passed" | "failed" | "errored" | "skipped";

export interface HarnessCaseResult {
  caseId: string;
  title: string;
  status: HarnessCaseStatus;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  stdoutExcerpt: string | null;
  stderrExcerpt: string | null;
  stdoutHash: string | null;
  stderrHash: string | null;
  structuredOutputSummary?: unknown;
  checkResults: HarnessCaseCheckResult[];
  failureArtifactIds: string[];
}

export interface HarnessRunSummary {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  skipped: number;
}

export interface HarnessRunPreflight {
  hasFailure: boolean;
  checks: HarnessCheckResult[];
}

export interface HarnessRunResult {
  runId: string;
  suiteId: string;
  runPath: string | null;
  preflight: HarnessRunPreflight;
  dryRun: boolean;
  hasFailure: boolean;
  summary: HarnessRunSummary;
  caseResults: HarnessCaseResult[];
  admission: AdmissionSummary;
  warnings: string[];
}

export interface HarnessRunRecord {
  version: 1;
  runId: string;
  suiteId: string;
  goalId: string | null;
  episodeId: string | null;
  sourceSessionId: string | null;
  sourceHeadSha: string | null;
  executor: HarnessRecordedExecutor;
  selectedCaseIds: string[];
  summary: HarnessRunSummary;
  caseResults: HarnessCaseResult[];
  startedAt: string;
  finishedAt: string;
  dryRun: boolean;
  warnings: string[];
  provenance: ArtifactEventProvenance;
}

export const isKnownDocType = (value: string): value is KnownDocType =>
  KNOWN_DOC_TYPES.includes(value as KnownDocType);

const DOC_TYPE_ALIASES: Record<string, KnownDocType> = {
  term: "glossary",
  terms: "glossary",
  specification: "spec",
  pb: "pbd",
  pbd: "pbd",
  "phase-binding": "pbd",
  "phase-bindings": "pbd",
  "phase-and-bindings": "pbd",
  "phase-binding-documents": "pbd",
  "phase-and-binding-documents": "pbd",
};

export const normalizeKnownDocType = (value: string | undefined): KnownDocType | null => {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (isKnownDocType(normalized)) return normalized;
  return DOC_TYPE_ALIASES[normalized] ?? null;
};

export interface RagitConfig {
  project: {
    name: string;
    default_branch: string;
    mode: "auto" | "empty" | "existing" | "docs-heavy" | "monorepo";
  };
  init: {
    strategy: "minimal" | "balanced" | "full";
    merge_existing: boolean;
  };
  docs: {
    entrypoint: string;
    workspace_map: string;
    ingestion_policy: string;
    known_gaps: string;
    adr_dir: string;
  };
  docs_authority: {
    auto_refresh_on_hook: boolean;
    validate_on_ingest: boolean;
    canonical_root: string;
  };
  storage: {
    backend: "zvec";
    manifest_dir: string;
    vector_dir: string;
  };
  embedding: {
    provider: EmbeddingProvider;
    model?: string;
    base_url?: string;
    timeout_ms?: number;
    cache_enabled?: boolean;
    cache_dir?: string;
    dimensions?: number;
    version?: string;
  };
  ingest: {
    supported_types: DocType[];
    type_detection: "frontmatter-first";
    doc_globs: string[];
    include: string[];
    exclude: string[];
  };
  hooks: {
    post_commit: boolean;
    post_merge: boolean;
  };
  retrieval: {
    alpha: number;
    top_k: number;
    keyword_enabled: boolean;
  };
  memory: {
    corpus_dir: string;
    session_dir: string;
    working_dir: string;
    auto_ingest_promotions: boolean;
    recall_top_k: number;
  };
  security: {
    secret_masking: boolean;
    remote_embedding_policy: "allow-sanitized" | "local-only";
    quarantine_on_redaction: boolean;
    admission_mode: "report-only" | "enforce";
  };
  output: {
    format: "text" | "json" | "both";
    language: "ko" | "en";
  };
}

export type RemoteEmbeddingPolicy = RagitConfig["security"]["remote_embedding_policy"];
export type AdmissionMode = RagitConfig["security"]["admission_mode"];
export type EmbeddingEgressClass = "local" | "remote";

export interface RedactionSummary {
  applied: boolean;
  maskedCount: number;
  sources: string[];
}

export type SecuritySurface =
  | "ingest.document"
  | "session.turn"
  | "session.toolTrace"
  | "memory.wrap"
  | "memory.recall"
  | "memory.promote"
  | "harness.capture"
  | "harness.run"
  | "harness.pack"
  | "harness.promote"
  | "event.ledger"
  | "retrieval.query"
  | "retrieval.hit"
  | "query.output"
  | "context.pack"
  | "timeline.output"
  | "log.output"
  | "narrative.output"
  | "audit"
  | "purge";

export type AdmissionAction = "allow" | "quarantine" | "block";

export type AdmissionReasonCode =
  | "private_key_block"
  | "credential_dump"
  | "env_dump"
  | "header_or_cookie_dump"
  | "multi_secret_payload"
  | "high_risk_path"
  | "secret_pattern";

export interface AdmissionItem {
  sourceRef: string;
  surface: SecuritySurface;
  action: Exclude<AdmissionAction, "allow">;
  reasonCodes: AdmissionReasonCode[];
  operation: string;
}

export interface AdmissionSummary {
  mode: AdmissionMode;
  allowed: number;
  quarantined: number;
  blocked: number;
  items: AdmissionItem[];
}

export interface SecurityAuditFinding {
  findingId: string;
  severity: "critical" | "warn" | "info";
  surface: SecuritySurface | "control-plane" | "store" | "repo-doc";
  path: string;
  field: string | null;
  reason: string;
  suggestedAction: string;
}

export interface SecurityAuditResult {
  summary: {
    critical: number;
    warn: number;
    info: number;
    quarantineEntries: number;
    admissionBlocked: number;
    admissionQuarantined: number;
    legacyControlPlaneFiles: number;
    legacyStoreFindings: number;
    repoDocsFlagged: number;
  };
  providerEgress: {
    provider: EmbeddingProvider;
    class: EmbeddingEgressClass;
    policy: RemoteEmbeddingPolicy;
    artifactRemoteEmbeddingAllowed: boolean;
  };
  findings: SecurityAuditFinding[];
}

export type SecurityPurgeTarget = "control-plane" | "store" | "cache" | "quarantine" | "all";

export interface SecurityPurgeResult {
  mode: "dry-run" | "apply";
  target: SecurityPurgeTarget;
  planned: string[];
  rewritten: string[];
  deleted: string[];
  warnings: string[];
}

export interface EmbeddingConfiguredState {
  provider: EmbeddingProvider;
  model: string;
  baseUrl: string | null;
  timeoutMs: number;
  cacheEnabled: boolean;
  cacheDir: string;
  deprecatedDimensions: number | null;
  deprecatedVersion: string | null;
}

export interface EmbeddingProfile {
  provider: EmbeddingProvider;
  model: string;
  dimensions: number;
  version: string;
  baseUrl: string | null;
  timeoutMs: number;
  cacheEnabled: boolean;
  cacheDir: string;
  ignoredLegacyFields: Array<"dimensions" | "version">;
}

export interface DocumentSection {
  id: string;
  title: string;
  level: number;
  content: string;
}

export interface DocumentRecord {
  id: string;
  versionId: string;
  path: string;
  docType: DocType;
  commitSha: string;
  hash: string;
  sections: DocumentSection[];
  originType?: "document" | "artifact";
  artifactId?: string | null;
  artifactKind?: ArtifactKind | null;
  sourceSessionId?: string | null;
}

export interface ChunkRecord {
  id: string;
  documentId: string;
  documentVersionId: string;
  sectionId: string;
  sectionTitle: string;
  path: string;
  docType: DocType;
  commitSha: string;
  text: string;
  tokenCount: number;
  embedding: number[];
  originType?: "document" | "artifact";
  artifactId?: string | null;
  artifactKind?: ArtifactKind | null;
  tier?: ArtifactTier | null;
  status?: ArtifactStatus | null;
  authority?: ArtifactAuthority | null;
  confidence?: number | null;
  goalId?: string | null;
  episodeId?: string | null;
  sourceSessionId?: string | null;
  bindingStatus?: ArtifactBindingStatus | null;
  searchPolicy?: SearchPolicy | null;
}

export interface ArtifactEvidenceRef {
  evidenceId: string;
  turnIds?: string[];
  toolTraceIds?: string[];
  excerpt: string;
}

export interface ArtifactEventProvenance {
  actor: "user" | "assistant" | "system";
  producer: string;
  producerVersion: string;
  operation: string;
  inputRefs: string[];
  outputRefs: string[];
  evidenceRefs: string[];
  contentHash: string;
}

export type RagitEventMetadata = Record<string, unknown>;

export interface BaseArtifactRecord {
  artifactId: string;
  artifactScope: ArtifactScope;
  kind: ArtifactKind;
  tier: ArtifactTier;
  status: ArtifactStatus;
  title: string;
  summary: string;
  text: string;
  goalId: string | null;
  episodeId: string | null;
  sourceSessionId: string | null;
  sourceHeadSha: string | null;
  captureHeadSha: string | null;
  boundHeadSha: string | null;
  bindingStatus: ArtifactBindingStatus;
  authority: ArtifactAuthority;
  confidence: number;
  searchPolicy: SearchPolicy;
  relatedPaths: string[];
  tags: string[];
  supersedes: string[];
  evidenceRefs: ArtifactEvidenceRef[];
  provenance: ArtifactEventProvenance;
  createdAt: string;
  updatedAt: string;
  payload?: Record<string, unknown>;
}

export interface ArtifactRecord extends BaseArtifactRecord {}

export interface RagitEventRecord {
  version: 1;
  eventId: string;
  eventType: RagitEventType;
  recordedAt: string;
  goalId: string | null;
  episodeId: string | null;
  sessionId: string | null;
  sourceHeadSha: string | null;
  summary: string;
  artifactIds: string[];
  relatedPaths: string[];
  openLoops: string[];
  nextActions: string[];
  metadata?: RagitEventMetadata;
  provenance: ArtifactEventProvenance;
}

export interface ArtifactManifestEntry {
  artifactId: string;
  artifactScope: ArtifactScope;
  kind: ArtifactKind;
  tier: ArtifactTier;
  status: ArtifactStatus;
  path: string;
  chunkIds: string[];
  searchPolicy: SearchPolicy;
  sourceSessionId: string | null;
  sourceHeadSha: string | null;
  goalId: string | null;
  episodeId: string | null;
  bindingStatus: ArtifactBindingStatus;
}

export interface SnapshotChunkScopes {
  durable: string[];
  session: string[];
  harness: string[];
  evidence: string[];
}

export interface SnapshotManifest {
  commitSha: string;
  parentSha: string | null;
  createdAt: string;
  indexVersion: number;
  docs: DocumentRecord[];
  chunks: Array<{
    id: string;
    documentId: string;
    documentVersionId: string;
  }>;
  artifactEntries?: ArtifactManifestEntry[];
  chunkScopes?: SnapshotChunkScopes;
}

export interface RagitLogSemanticCounts {
  beliefs: number;
  openLoops: number;
  evidence: number;
  artifacts: number;
}

export interface RagitLogSemanticStatement {
  artifactId: string;
  kind: ArtifactKind;
  scope: ArtifactScope;
  status: ArtifactStatus;
  title: string;
  summary: string;
  authority: ArtifactAuthority | null;
  confidence: number | null;
  sourceSessionId: string | null;
  goalId: string | null;
  episodeId: string | null;
}

export interface RagitLogSemanticEvidence {
  artifactId: string;
  artifactKind: ArtifactKind;
  artifactScope: ArtifactScope;
  artifactStatus: ArtifactStatus;
  evidenceId: string;
  excerpt: string;
  authority: ArtifactAuthority | null;
  confidence: number | null;
  sourceSessionId: string | null;
  goalId: string | null;
  episodeId: string | null;
}

export interface RagitLogSemanticArtifactSupport {
  artifactId: string;
  kind: ArtifactKind;
  scope: ArtifactScope;
  status: ArtifactStatus;
  tier: ArtifactTier;
  bindingStatus: ArtifactBindingStatus;
  searchPolicy: SearchPolicy;
  sourceSessionId: string | null;
  goalId: string | null;
  episodeId: string | null;
  sourceHeadSha: string | null;
  path: string;
  loaded: boolean;
  title: string | null;
  summary: string | null;
  authority: ArtifactAuthority | null;
  confidence: number | null;
}

export interface RagitLogSemanticOverlay {
  available: boolean;
  headline: string;
  counts: RagitLogSemanticCounts;
  beliefs: RagitLogSemanticStatement[];
  openLoops: RagitLogSemanticStatement[];
  evidence: RagitLogSemanticEvidence[];
  artifacts: RagitLogSemanticArtifactSupport[];
}

export interface RetrievalHit {
  chunkId: string;
  path: string;
  sectionTitle: string;
  scoreVector: number;
  scoreKeyword: number;
  scoreFinal: number;
  text: string;
  scope?: RetrievalScope;
  originType?: "document" | "artifact";
  artifactId?: string | null;
  artifactKind?: ArtifactKind | null;
  authority?: ArtifactAuthority | null;
  confidence?: number | null;
}

export interface DriftItem {
  scope: Exclude<DriftScope, "all">;
  itemType: "baseline" | "document" | "memoryArtifact" | "harnessSuite";
  id: string;
  title: string;
  status: DriftStatus;
  reasonCodes: DriftReasonCode[];
  affectedPaths: string[];
  sourceRefs: {
    headSha: string | null;
    snapshotSha?: string | null;
    anchorSha?: string | null;
    sourceHeadSha?: string | null;
    boundHeadSha?: string | null;
    captureHeadSha?: string | null;
    artifactId?: string | null;
    goalId?: string | null;
    episodeId?: string | null;
    sourceSessionId?: string | null;
  };
  recommendedActions: string[];
}

export interface DriftResult {
  overallStatus: DriftStatus;
  counts: Record<DriftStatus, number>;
  filters: {
    scope: DriftScope;
    path: string | null;
    goalId: string | null;
    sessionId: string | null;
    maxCount: number | null;
  };
  baseline: {
    headSha: string | null;
    snapshotSha: string | null;
    snapshotCommitSha: string | null;
    reasonCodes: DriftReasonCode[];
  };
  items: DriftItem[];
}

export interface RepairAction {
  actionId: string;
  action: RepairActionKind;
  sourceItemId: string;
  sourceScope: Exclude<DriftScope, "all">;
  reasonCodes: DriftReasonCode[];
  status: RepairActionStatus;
  safeToApply: boolean;
  requiresInput: boolean;
  commandPath: string;
  args: string[];
  notes: string[];
}

export interface RepairResult {
  mode: "plan" | "apply";
  summary: {
    planned: number;
    executed: number;
    blocked: number;
    failed: number;
    skipped: number;
  };
  filters: {
    scope: DriftScope;
    path: string | null;
    goalId: string | null;
    sessionId: string | null;
    maxCount: number | null;
    actions: RepairActionKind[];
  };
  drift: DriftResult;
  plannedActions: RepairAction[];
  executedActions: RepairAction[];
  skippedActions: RepairAction[];
  warnings: string[];
}
