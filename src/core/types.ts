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
