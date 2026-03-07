export const KNOWN_DOC_TYPES = ["adr", "prd", "srs", "spec", "plan", "ddd", "glossary", "pbd"] as const;

export type KnownDocType = (typeof KNOWN_DOC_TYPES)[number];
export type DocType = KnownDocType | "unknown";

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
}

export interface RetrievalHit {
  chunkId: string;
  path: string;
  sectionTitle: string;
  scoreVector: number;
  scoreKeyword: number;
  scoreFinal: number;
  text: string;
}
