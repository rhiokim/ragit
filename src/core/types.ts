export type DocType = "adr" | "prd" | "srs" | "plan" | "ddd" | "glossary" | "unknown";

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
  security: {
    secret_masking: boolean;
  };
  output: {
    format: "markdown" | "json" | "both";
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
  path: string;
  docType: DocType;
  commitSha: string;
  hash: string;
  sections: DocumentSection[];
}

export interface ChunkRecord {
  id: string;
  documentId: string;
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
