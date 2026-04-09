export const KNOWN_DOC_TYPES = ["adr", "prd", "srs", "spec", "plan", "ddd", "glossary", "pbd"] as const;

export type KnownDocType = (typeof KNOWN_DOC_TYPES)[number];
export type DocType = KnownDocType | "unknown";
export type RetrievalScope = "durable" | "session" | "harness" | "evidence" | "all";
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
    provider: "local-placeholder";
    dimensions: number;
    version: string;
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
  };
  output: {
    format: "text" | "json" | "both";
    language: "ko" | "en";
  };
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
