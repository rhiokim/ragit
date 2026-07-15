export type RagitErrorCategory =
  | "invalid_input"
  | "not_ready"
  | "corrupt_or_incompatible"
  | "transient";

export type RagitErrorCode =
  | "SNAPSHOT_REF_INVALID"
  | "SNAPSHOT_REF_AMBIGUOUS"
  | "SNAPSHOT_NOT_INDEXED"
  | "SNAPSHOT_MANIFEST_INVALID"
  | "SNAPSHOT_SCHEMA_UNSUPPORTED"
  | "SNAPSHOT_STORE_UNAVAILABLE"
  | "INGEST_BASE_NOT_INDEXED"
  | "INGEST_BASE_NOT_ANCESTOR"
  | "INGEST_CANDIDATES_DIRTY"
  | "INGEST_STORE_WRITE_UNVERIFIED"
  | "STORE_WRITE_BUSY"
  | "STORE_WRITE_LOCK_STALE"
  | "REPOSITORY_STATE_CHANGED";

export interface RagitRecovery {
  command: string;
}

export interface RagitErrorPayload {
  code: RagitErrorCode;
  category: RagitErrorCategory;
  message: string;
  retryable: boolean;
  details: Record<string, unknown>;
  recovery: RagitRecovery;
}

export const RAGIT_ERROR_DEFINITIONS = {
  SNAPSHOT_REF_INVALID: {
    category: "invalid_input",
    exitCode: 2,
    retryable: false,
  },
  SNAPSHOT_REF_AMBIGUOUS: {
    category: "invalid_input",
    exitCode: 2,
    retryable: false,
  },
  SNAPSHOT_NOT_INDEXED: {
    category: "not_ready",
    exitCode: 3,
    retryable: false,
  },
  SNAPSHOT_MANIFEST_INVALID: {
    category: "corrupt_or_incompatible",
    exitCode: 4,
    retryable: false,
  },
  SNAPSHOT_SCHEMA_UNSUPPORTED: {
    category: "corrupt_or_incompatible",
    exitCode: 4,
    retryable: false,
  },
  SNAPSHOT_STORE_UNAVAILABLE: {
    category: "not_ready",
    exitCode: 3,
    retryable: false,
  },
  INGEST_BASE_NOT_INDEXED: {
    category: "not_ready",
    exitCode: 3,
    retryable: false,
  },
  INGEST_BASE_NOT_ANCESTOR: {
    category: "invalid_input",
    exitCode: 2,
    retryable: false,
  },
  INGEST_CANDIDATES_DIRTY: {
    category: "not_ready",
    exitCode: 3,
    retryable: false,
  },
  INGEST_STORE_WRITE_UNVERIFIED: {
    category: "transient",
    exitCode: 3,
    retryable: true,
  },
  STORE_WRITE_BUSY: {
    category: "transient",
    exitCode: 3,
    retryable: true,
  },
  STORE_WRITE_LOCK_STALE: {
    category: "not_ready",
    exitCode: 3,
    retryable: false,
  },
  REPOSITORY_STATE_CHANGED: {
    category: "transient",
    exitCode: 3,
    retryable: true,
  },
} as const satisfies Record<
  RagitErrorCode,
  {
    category: RagitErrorCategory;
    exitCode: 2 | 3 | 4;
    retryable: boolean;
  }
>;

export interface RagitOperationalErrorOptions {
  details: Record<string, unknown>;
  recovery: RagitRecovery;
  cause?: unknown;
}

export class RagitOperationalError extends Error {
  readonly code: RagitErrorCode;
  readonly category: RagitErrorCategory;
  readonly exitCode: 2 | 3 | 4;
  readonly retryable: boolean;
  readonly details: Record<string, unknown>;
  readonly recovery: RagitRecovery;

  constructor(
    code: RagitErrorCode,
    message: string,
    options: RagitOperationalErrorOptions,
  ) {
    super(message, { cause: options.cause });

    const definition = RAGIT_ERROR_DEFINITIONS[code];

    this.name = "RagitOperationalError";
    this.code = code;
    this.category = definition.category;
    this.exitCode = definition.exitCode;
    this.retryable = definition.retryable;
    this.details = options.details;
    this.recovery = options.recovery;
  }

  toPayload(): RagitErrorPayload {
    return {
      code: this.code,
      category: this.category,
      message: this.message,
      retryable: this.retryable,
      details: this.details,
      recovery: this.recovery,
    };
  }
}

export function isRagitOperationalError(
  value: unknown,
): value is RagitOperationalError {
  return value instanceof RagitOperationalError;
}
