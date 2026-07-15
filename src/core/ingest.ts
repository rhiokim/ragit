import { access, lstat, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { buildArtifactIndexData, bindPendingArtifacts } from "./artifacts.js";
import { chunkSections, parseSections } from "./chunk.js";
import { CONFIG_PATH, defaultConfig, loadConfig } from "./config.js";
import { validateKnownDoc } from "./doc-authority.js";
import { detectDocType } from "./docType.js";
import { RagitOperationalError } from "./errors.js";
import { appendLedgerEvent } from "./event-ledger.js";
import { hashFileContent, listAllDocumentFiles, listDocumentFilesByGlob } from "./files.js";
import {
  getHeadShaIfExists,
  getParentShaForCommit,
  listChangedFilesBetween,
  listDirtyPathsAgainstHead,
  listTrackedPaths,
  workingTreePathMatchesHead,
} from "./git.js";
import { chunkVersionId, documentIdFromPath, documentVersionId, toRepoPath } from "./identity.js";
import {
  createIngestTransaction,
  failIngestTransaction,
  IngestTransactionJournal,
  updateIngestTransaction,
} from "./ingest-transaction.js";
import { maskSecrets } from "./mask.js";
import { buildSnapshotManifest, writeSnapshotManifest } from "./manifest.js";
import { embedTexts, resolveEmbeddingProfile, toEmbeddingContract } from "./embedding.js";
import { ensureRagitStructure } from "./project.js";
import { withStoreWriteLock } from "./store-write-lock.js";
import {
  assertKnowledgeWriteSecurity,
  appendAdmissionRecord,
  canUseRemoteEmbedding,
  createAdmissionSummary,
  evaluateRepoDocCandidate,
  persistQuarantineSummary,
  recordAdmissionDecision,
  sanitizeKnowledgeText,
} from "./security.js";
import {
  bootstrapCanonicalStore,
  CanonicalStore,
  closeCanonicalStore,
  writeChunksToCanonicalStore,
  writeDocumentsToCanonicalStore,
} from "./store.js";
import { resolveRepositoryContext, selectIngestBase } from "./snapshot.js";
import { AdmissionSummary, ChunkRecord, DocType, DocumentRecord, isKnownDocType } from "./types.js";
import { RAGIT_VERSION } from "./version.js";

export interface IngestOptions {
  all?: boolean;
  since?: string;
  files?: string;
  paths?: string[];
  scope?: "durable" | "all";
  dryRun?: boolean;
}

export type IngestTestBoundary = "store-written" | "store-verified" | "before-manifest" | "after-manifest";

export interface IngestTestHookContext {
  cwd: string;
  headSha: string;
  transaction: IngestTransactionJournal;
  documentVersionIds: string[];
  chunkIds: string[];
  store?: CanonicalStore;
}

export interface RunIngestDependencies {
  testHook?: (boundary: IngestTestBoundary, context: IngestTestHookContext) => Promise<void> | void;
}

interface ResolvedIngestTargets {
  files: string[];
  deletedDocumentIds: string[];
  fullSnapshot: boolean;
  selectorMode: "implicit" | "explicit";
}

const fileExists = async (target: string): Promise<boolean> => {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

const pathEntryExists = async (target: string): Promise<boolean> => {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
};

const INTERNAL_REPO_PATH_SEGMENTS = new Set([".git", ".ragit", "node_modules", "dist"]);

const isDocumentLikePath = (target: string): boolean => {
  const normalized = target.replaceAll(path.sep, "/");
  if (normalized.split("/").some((segment) => INTERNAL_REPO_PATH_SEGMENTS.has(segment))) {
    return false;
  }
  const extension = path.extname(normalized).toLowerCase();
  return extension === ".md" || extension === ".mdx";
};

const matchesAnyGlob = (target: string, patterns: string[]): boolean =>
  patterns.some((pattern) => path.matchesGlob(target, pattern));

const parseIngestFilePatterns = (globText: string): string[] =>
  globText
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

const matchesIngestFilePatterns = (target: string, patterns: string[]): boolean => {
  const positivePatterns = patterns.filter((pattern) => !pattern.startsWith("!"));
  const negativePatterns = patterns
    .filter((pattern) => pattern.startsWith("!") && pattern.length > 1)
    .map((pattern) => pattern.slice(1));
  return matchesAnyGlob(target, positivePatterns) && !matchesAnyGlob(target, negativePatterns);
};

const isImplicitIngestPath = (repoPath: string, config: Awaited<ReturnType<typeof loadConfig>>): boolean => {
  const normalized = repoPath.replaceAll(path.sep, "/");
  if (!isDocumentLikePath(normalized)) return false;
  if (!matchesAnyGlob(normalized, config.ingest.doc_globs)) return false;
  if (!matchesAnyGlob(normalized, config.ingest.include)) return false;
  if (config.ingest.exclude.some((pattern) => path.matchesGlob(normalized, pattern))) return false;
  return true;
};

const normalizeExplicitRepoPath = (cwd: string, entry: string): string => {
  const absolute = path.resolve(cwd, entry);
  const relative = path.relative(cwd, absolute).replaceAll(path.sep, "/");
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`ingest.path 값은 저장소 내부 상대 경로여야 합니다: ${entry}`);
  }
  if (!isDocumentLikePath(relative)) {
    throw new Error(`ingest.path 값은 markdown 문서여야 합니다: ${entry}`);
  }
  return relative;
};

const resolveCandidates = async (
  cwd: string,
  config: Awaited<ReturnType<typeof loadConfig>>,
  options: IngestOptions,
  headSha: string,
  normalizedBaseSha: string | null,
): Promise<ResolvedIngestTargets> => {
  if (options.paths && options.paths.length > 0) {
    const files = options.paths.map((entry) => path.resolve(cwd, normalizeExplicitRepoPath(cwd, entry)));
    return {
      files,
      deletedDocumentIds: [],
      fullSnapshot: false,
      selectorMode: "explicit",
    };
  }
  if (options.files) {
    const patterns = parseIngestFilePatterns(options.files);
    const files = await listDocumentFilesByGlob(cwd, patterns.join(","));
    return {
      files: files.filter((file) => {
        const repoPath = toRepoPath(cwd, file);
        return isDocumentLikePath(repoPath) && !repoPath.startsWith(".git/") && !repoPath.startsWith(".ragit/");
      }),
      deletedDocumentIds: [],
      fullSnapshot: false,
      selectorMode: "explicit",
    };
  }
  if (options.since) {
    if (normalizedBaseSha === null) {
      throw new Error("normalized --since base SHA가 없습니다.");
    }
    const changed = await listChangedFilesBetween(cwd, normalizedBaseSha, headSha);
    const files: string[] = [];
    const deletedDocumentIds: string[] = [];
    const seenFiles = new Set<string>();
    const seenDeleted = new Set<string>();
    for (const relativePath of changed) {
      const repoPath = relativePath.replaceAll(path.sep, "/");
      if (!isImplicitIngestPath(repoPath, config)) continue;
      const absolutePath = path.resolve(cwd, relativePath);
      if (await fileExists(absolutePath)) {
        if (!seenFiles.has(absolutePath)) {
          seenFiles.add(absolutePath);
          files.push(absolutePath);
        }
        continue;
      }
      const documentId = documentIdFromPath(repoPath);
      if (!seenDeleted.has(documentId)) {
        seenDeleted.add(documentId);
        deletedDocumentIds.push(documentId);
      }
    }
    return {
      files,
      deletedDocumentIds,
      fullSnapshot: false,
      selectorMode: "implicit",
    };
  }
  return {
    files: (await listAllDocumentFiles(cwd)).filter((file) => isImplicitIngestPath(toRepoPath(cwd, file), config)),
    deletedDocumentIds: [],
    fullSnapshot: true,
    selectorMode: "implicit",
  };
};

const isSupported = (docType: DocType, supported: DocType[]): boolean =>
  docType !== "unknown" && supported.includes(docType);

const isFullSnapshotRequest = (options: IngestOptions): boolean =>
  !(options.paths && options.paths.length > 0) && !options.files && !options.since;

const loadIngestConfig = async (cwd: string): Promise<Awaited<ReturnType<typeof loadConfig>>> =>
  (await fileExists(path.join(cwd, CONFIG_PATH))) ? loadConfig(cwd) : defaultConfig();

const resolveDirtyCandidates = async (
  cwd: string,
  config: Awaited<ReturnType<typeof loadConfig>>,
  options: IngestOptions,
  headSha: string,
  normalizedBaseSha: string | null,
  candidateFiles: string[],
): Promise<string[]> => {
  const filePatterns = options.files ? parseIngestFilePatterns(options.files) : [];
  let relevantPaths: Set<string> | null = null;

  if (options.paths && options.paths.length > 0) {
    relevantPaths = new Set(options.paths.map((entry) => normalizeExplicitRepoPath(cwd, entry)));
  } else if (!options.files && options.since) {
    if (normalizedBaseSha === null) {
      throw new Error("normalized --since base SHA가 없습니다.");
    }
    relevantPaths = new Set(
      (await listChangedFilesBetween(cwd, normalizedBaseSha, headSha))
        .map((entry) => entry.replaceAll(path.sep, "/"))
        .filter((entry) => isImplicitIngestPath(entry, config)),
    );
  }

  const isRelevantPath = (entry: string): boolean => {
    if (relevantPaths !== null) return relevantPaths.has(entry);
    if (options.files) {
      return isDocumentLikePath(entry) && matchesIngestFilePatterns(entry, filePatterns);
    }
    return isImplicitIngestPath(entry, config);
  };

  const [visibleDirtyPaths, trackedPathEntries] = await Promise.all([
    listDirtyPathsAgainstHead(cwd, headSha),
    listTrackedPaths(cwd),
  ]);
  const dirtyPaths = new Set(visibleDirtyPaths.map((entry) => entry.path.replaceAll(path.sep, "/")));
  const trackedPaths = new Map(
    trackedPathEntries.map((entry) => [entry.path.replaceAll(path.sep, "/"), entry]),
  );
  for (const trackedPath of trackedPathEntries) {
    const repoPath = trackedPath.path.replaceAll(path.sep, "/");
    if (!trackedPath.worktreeChangesHidden || !isRelevantPath(repoPath)) continue;
    if (!(await pathEntryExists(path.resolve(cwd, repoPath)))) {
      dirtyPaths.add(repoPath);
    }
  }
  for (const candidateFile of candidateFiles) {
    const repoPath = toRepoPath(cwd, candidateFile);
    const trackedPath = trackedPaths.get(repoPath);
    if (trackedPath === undefined && await pathEntryExists(candidateFile)) {
      dirtyPaths.add(repoPath);
      continue;
    }
    if (trackedPath?.worktreeChangesHidden && await pathEntryExists(candidateFile)) {
      const stats = await lstat(candidateFile);
      if (!stats.isFile() || !(await workingTreePathMatchesHead(cwd, repoPath))) {
        dirtyPaths.add(repoPath);
      }
    }
  }

  return [...dirtyPaths]
    .filter(isRelevantPath)
    .sort((left, right) => left.localeCompare(right));
};

const missingHeadForIngest = (): RagitOperationalError =>
  new RagitOperationalError(
    "SNAPSHOT_NOT_INDEXED",
    "현재 HEAD가 없어 ingest할 commit을 결정할 수 없습니다.",
    {
      details: { headSha: null },
      recovery: { command: "git status" },
    },
  );

const isRegularRepoFile = async (
  absolutePath: string,
  repoPath: string,
  realGitRoot: string,
): Promise<boolean> => {
  const [stats, resolvedPath] = await Promise.all([lstat(absolutePath), realpath(absolutePath)]);
  const expectedPath = path.resolve(realGitRoot, repoPath);
  return stats.isFile() && resolvedPath === expectedPath;
};

export interface IngestSummary {
  mode: "apply" | "dry-run";
  processed: number;
  skipped: number;
  masked: number;
  commitSha: string;
  manifestPath: string | null;
  searchReady: boolean;
  plannedFiles: string[];
  deletedDocumentIds: string[];
  dirtyCandidates: string[];
  wouldFail: boolean;
  fullSnapshot: boolean;
  scope: "durable" | "all";
  boundArtifactIds: string[];
  admission: AdmissionSummary;
  docAuthority: {
    validated: boolean;
    violations: number;
    skipped: number;
  };
  warnings: string[];
}

const sortDocuments = (documents: DocumentRecord[]): DocumentRecord[] =>
  [...documents].sort((left, right) => left.path.localeCompare(right.path) || left.versionId.localeCompare(right.versionId));

const sortChunkEntries = (chunks: Array<Pick<ChunkRecord, "id" | "documentId" | "documentVersionId">>): Array<
  Pick<ChunkRecord, "id" | "documentId" | "documentVersionId">
> => [...chunks].sort((left, right) => left.id.localeCompare(right.id));

const runIngestTestHook = async (
  dependencies: RunIngestDependencies,
  boundary: IngestTestBoundary,
  context: IngestTestHookContext,
): Promise<void> => {
  await dependencies.testHook?.(boundary, context);
};

const unverifiedStoreWrite = (
  transactionId: string,
  missingDocumentVersionIds: string[],
  missingChunkIds: string[],
): RagitOperationalError =>
  new RagitOperationalError(
    "INGEST_STORE_WRITE_UNVERIFIED",
    "새 ingest record를 canonical store에서 다시 읽을 수 없습니다.",
    {
      details: { transactionId, missingDocumentVersionIds, missingChunkIds },
      recovery: { command: "ragit ingest --all" },
    },
  );

const appendIngestAdmissionEvent = async (
  cwd: string,
  admission: AdmissionSummary,
  recordedAt: string,
  sourceHeadSha: string,
  sourceRefs: string[],
): Promise<void> => {
  if (admission.items.length === 0) return;
  await appendLedgerEvent(cwd, {
    eventType: "security.admission",
    recordedAt,
    goalId: null,
    episodeId: null,
    sessionId: null,
    sourceHeadSha,
    summary: `Admission control flagged ${admission.blocked} blocked and ${admission.quarantined} quarantined ingest candidate(s)`,
    relatedPaths: sourceRefs,
    metadata: {
      commandPath: "ingest",
      mode: admission.mode,
      surface: "ingest.document",
      decisionCounts: {
        allowed: admission.allowed,
        quarantined: admission.quarantined,
        blocked: admission.blocked,
      },
      sourceRefs,
      contentHashes: admission.items.map((item: AdmissionSummary["items"][number]) => `${item.operation}:${item.sourceRef}`),
      reasonCodes: Array.from(new Set(admission.items.flatMap((item: AdmissionSummary["items"][number]) => item.reasonCodes))),
    },
    provenance: {
      actor: "assistant",
      producer: "ragit",
      producerVersion: RAGIT_VERSION,
      operation: "security.admission",
      inputRefs: sourceRefs,
      outputRefs: [],
      evidenceRefs: [],
      contentHash: `${sourceHeadSha}:${admission.blocked}:${admission.quarantined}:${sourceRefs.join(",")}`,
    },
  });
};

const runIngestUnlocked = async (
  cwd: string,
  options: IngestOptions,
  dependencies: RunIngestDependencies = {},
): Promise<IngestSummary> => {
  const context = await resolveRepositoryContext(cwd);
  if (context.headSha === null) throw missingHeadForIngest();
  cwd = context.gitRoot;
  const headSha = context.headSha;
  const fullSnapshot = isFullSnapshotRequest(options);
  const baseSelection = await selectIngestBase(
    cwd,
    { fullSnapshot, since: options.since },
    context,
  );
  const config = await loadIngestConfig(cwd);
  const candidates = await resolveCandidates(cwd, config, options, headSha, baseSelection.baseSha);
  const dirtyCandidates = await resolveDirtyCandidates(
    cwd,
    config,
    options,
    headSha,
    baseSelection.baseSha,
    candidates.files,
  );
  if (!options.dryRun && dirtyCandidates.length > 0) {
    throw new RagitOperationalError(
      "INGEST_CANDIDATES_DIRTY",
      "ingest 대상에 커밋되지 않은 변경이 있습니다.",
      {
        details: { dirtyCandidates },
        recovery: { command: "git status --short" },
      },
    );
  }
  const dirtyCandidateSet = new Set(dirtyCandidates);
  const processableFiles: string[] = [];
  const realGitRoot = await realpath(cwd);
  for (const absolutePath of candidates.files) {
    const repoPath = toRepoPath(cwd, absolutePath);
    if (options.dryRun && dirtyCandidateSet.has(repoPath) && !(await fileExists(absolutePath))) {
      continue;
    }
    if (!(await isRegularRepoFile(absolutePath, repoPath, realGitRoot))) {
      if (options.dryRun && dirtyCandidateSet.has(repoPath)) {
        continue;
      }
      throw new Error(`ingest 대상은 symlink가 아닌 regular file이어야 합니다: ${repoPath}`);
    }
    processableFiles.push(absolutePath);
  }
  if (!options.dryRun) {
    await ensureRagitStructure(cwd, config);
  }
  assertKnowledgeWriteSecurity(config, "ingest", Boolean(options.dryRun));
  const embeddingProfile = resolveEmbeddingProfile(config);
  if (!canUseRemoteEmbedding(config, embeddingProfile, "durable-doc")) {
    throw new Error("현재 embedding provider는 remote egress가 필요하지만 security.remote_embedding_policy=local-only 입니다.");
  }
  const cacheMode = options.dryRun ? "readonly" : "readwrite";
  const scope = options.scope ?? "durable";
  let processed = 0;
  let skipped = 0;
  let masked = 0;
  const admission = createAdmissionSummary(config.security.admission_mode);
  const changedDocuments = new Map<string, DocumentRecord>();
  const changedChunks = new Map<string, ChunkRecord[]>();
  const plannedFiles = candidates.files.map((file) => toRepoPath(cwd, file));
  const warnings: string[] = [];
  const blockedExplicitDocs: string[] = [];
  let contractViolations = 0;
  let contractSkipped = 0;

  for (const absolutePath of processableFiles) {
    const { content, hash } = await hashFileContent(absolutePath);
    const repoPath = toRepoPath(cwd, absolutePath);
    const admissionDecision = evaluateRepoDocCandidate(repoPath, candidates.selectorMode, content);
    if (admissionDecision.action !== "allow") {
      recordAdmissionDecision(admission, admissionDecision.action, {
        sourceRef: admissionDecision.sourceRef,
        surface: admissionDecision.surface,
        action: admissionDecision.action,
        reasonCodes: admissionDecision.reasonCodes,
        operation: "ingest",
      });
    } else {
      recordAdmissionDecision(admission, "allow");
    }
    if (admissionDecision.action === "block" && config.security.admission_mode === "enforce") {
      warnings.push(`admission control이 문서를 차단했습니다: ${repoPath} (${admissionDecision.reasonCodes.join(", ")})`);
      if (candidates.selectorMode === "explicit") {
        blockedExplicitDocs.push(repoPath);
      } else {
        skipped += 1;
      }
      continue;
    }
    const maskedContent = sanitizeKnowledgeText(content, "ingest.document", repoPath);
    masked += maskedContent.summary.maskedCount;
    if (!options.dryRun) {
      await persistQuarantineSummary(cwd, config, {
        surface: "ingest.document",
        sourceRef: repoPath,
        summary: maskedContent.summary,
        previewBySource: maskedContent.previewBySource,
        operation: "ingest.completed",
      });
    }
    const detection = detectDocType(absolutePath, maskedContent.text, cwd);
    if (!isSupported(detection.docType, config.ingest.supported_types)) {
      skipped += 1;
      continue;
    }
    if (config.docs_authority.validate_on_ingest && isKnownDocType(detection.docType)) {
      const validation = validateKnownDoc(detection.docType, repoPath, maskedContent.text, config);
      if (validation.violations.length > 0) {
        contractViolations += validation.violations.length;
        warnings.push(
          `문서 계약 위반이 감지되었습니다: ${repoPath} (${validation.violations.join("; ")})`,
        );
      }
    }
    const logicalDocumentId = documentIdFromPath(repoPath);
    const versionId = documentVersionId(logicalDocumentId, headSha, hash);
    const sections = parseSections(detection.body);
    const doc: DocumentRecord = {
      id: logicalDocumentId,
      versionId,
      path: repoPath,
      docType: detection.docType,
      commitSha: headSha,
      hash,
      sections,
    };
    const chunkCandidates = chunkSections(sections);
    const embeddings = await embedTexts(
      chunkCandidates.map((chunk) => chunk.text),
      embeddingProfile,
      { cwd, cacheMode },
    );
    const chunks = chunkCandidates.map((chunk, index) => {
      const id = chunkVersionId(versionId, chunk.sectionId, index, chunk.text);
      const record: ChunkRecord = {
        id,
        documentId: doc.id,
        documentVersionId: doc.versionId,
        sectionId: chunk.sectionId,
        sectionTitle: chunk.sectionTitle,
        path: doc.path,
        docType: doc.docType,
        commitSha: headSha,
        text: chunk.text,
        tokenCount: chunk.tokenCount,
        embedding: embeddings[index] ?? [],
      };
      return record;
    });
    changedDocuments.set(doc.id, doc);
    changedChunks.set(doc.id, chunks);
    processed += 1;
  }

  if (options.dryRun) {
    return {
      mode: "dry-run",
      processed,
      skipped,
      masked,
      commitSha: headSha,
      manifestPath: `.ragit/manifest/${headSha}.json`,
      searchReady: false,
      plannedFiles,
      deletedDocumentIds: candidates.deletedDocumentIds,
      dirtyCandidates,
      wouldFail:
        dirtyCandidates.length > 0 ||
        (blockedExplicitDocs.length > 0 && config.security.admission_mode === "enforce"),
      fullSnapshot: candidates.fullSnapshot,
      scope,
      boundArtifactIds: [],
      admission,
      docAuthority: {
        validated: config.docs_authority.validate_on_ingest,
        violations: contractViolations,
        skipped: contractSkipped,
      },
      warnings,
    };
  }

  if (admission.items.length > 0) {
    const recordedAt = new Date().toISOString();
    await appendAdmissionRecord(cwd, admission, recordedAt);
    await appendIngestAdmissionEvent(cwd, admission, recordedAt, headSha, plannedFiles);
  }
  if (blockedExplicitDocs.length > 0 && config.security.admission_mode === "enforce") {
    throw new Error(`admission control이 explicit ingest 문서를 차단했습니다: ${blockedExplicitDocs.join(", ")}`);
  }

  const parentSha = await getParentShaForCommit(cwd, headSha);
  const boundArtifactIds = await bindPendingArtifacts(cwd, headSha);
  const baseSnapshot = baseSelection.manifest;
  const documentMap = new Map<string, DocumentRecord>();
  const chunkEntries = new Map<string, Pick<ChunkRecord, "id" | "documentId" | "documentVersionId">>();

  if (baseSnapshot) {
    for (const document of baseSnapshot.docs) {
      documentMap.set(document.id, document);
    }
    for (const chunk of baseSnapshot.chunks) {
      chunkEntries.set(chunk.id, chunk);
    }
  }

  const removedDocumentIds = new Set<string>(candidates.deletedDocumentIds);
  for (const documentId of changedDocuments.keys()) {
    removedDocumentIds.add(documentId);
  }

  if (candidates.fullSnapshot) {
    documentMap.clear();
    chunkEntries.clear();
  } else if (removedDocumentIds.size > 0) {
    for (const documentId of removedDocumentIds) {
      documentMap.delete(documentId);
    }
    for (const [chunkId, chunk] of chunkEntries.entries()) {
      if (removedDocumentIds.has(chunk.documentId)) {
        chunkEntries.delete(chunkId);
      }
    }
  }

  const newDocuments = Array.from(changedDocuments.values());
  const artifactIndex = await buildArtifactIndexData(cwd, headSha, scope, embeddingProfile, cacheMode);
  const newChunks = [...Array.from(changedChunks.values()).flat(), ...artifactIndex.chunks];
  const documentVersionIds = newDocuments.map((document) => document.versionId);
  const chunkIds = newChunks.map((chunk) => chunk.id);
  const manifestPath = `.ragit/manifest/${headSha}.json`;
  let transaction = await createIngestTransaction(cwd, {
    targetHeadSha: headSha,
    baseSha: baseSelection.baseSha,
    manifestPath,
    documentVersionIds,
    chunkIds,
  });

  try {
    const store = await bootstrapCanonicalStore(cwd, toEmbeddingContract(embeddingProfile), false);
    try {
      writeDocumentsToCanonicalStore(store, newDocuments);
      writeChunksToCanonicalStore(store, newChunks);
      transaction = await updateIngestTransaction(cwd, transaction, { phase: "store-written" });
      await runIngestTestHook(dependencies, "store-written", {
        cwd,
        headSha,
        transaction,
        documentVersionIds,
        chunkIds,
        store,
      });
    } finally {
      closeCanonicalStore(store);
    }

    const verificationStore = await bootstrapCanonicalStore(cwd, toEmbeddingContract(embeddingProfile), true);
    try {
      const fetchedDocuments = documentVersionIds.length === 0
        ? {}
        : verificationStore.documents.fetchSync(documentVersionIds);
      const fetchedChunks = chunkIds.length === 0
        ? {}
        : verificationStore.chunks.fetchSync(chunkIds);
      const missingDocumentVersionIds = documentVersionIds.filter((id) => !(id in fetchedDocuments));
      const missingChunkIds = chunkIds.filter((id) => !(id in fetchedChunks));
      if (missingDocumentVersionIds.length > 0 || missingChunkIds.length > 0) {
        throw unverifiedStoreWrite(transaction.transactionId, missingDocumentVersionIds, missingChunkIds);
      }
    } finally {
      closeCanonicalStore(verificationStore);
    }

    transaction = await updateIngestTransaction(cwd, transaction, { phase: "store-verified" });
    await runIngestTestHook(dependencies, "store-verified", {
      cwd,
      headSha,
      transaction,
      documentVersionIds,
      chunkIds,
    });

    const finalHeadSha = await getHeadShaIfExists(cwd);
    if (finalHeadSha !== headSha) {
      throw new RagitOperationalError(
        "REPOSITORY_STATE_CHANGED",
        "ingest 중 HEAD가 변경되었습니다.",
        {
          details: { selectedHeadSha: headSha, finalHeadSha },
          recovery: { command: "git status" },
        },
      );
    }
    const finalDirtyCandidates = await resolveDirtyCandidates(
      cwd,
      config,
      options,
      headSha,
      baseSelection.baseSha,
      candidates.files,
    );
    if (finalDirtyCandidates.length > 0) {
      throw new RagitOperationalError(
        "INGEST_CANDIDATES_DIRTY",
        "ingest 대상에 커밋되지 않은 변경이 있습니다.",
        {
          details: { dirtyCandidates: finalDirtyCandidates },
          recovery: { command: "git status --short" },
        },
      );
    }
    await runIngestTestHook(dependencies, "before-manifest", {
      cwd,
      headSha,
      transaction,
      documentVersionIds,
      chunkIds,
    });

    for (const document of newDocuments) {
      documentMap.set(document.id, document);
    }
    for (const chunk of newChunks) {
      chunkEntries.set(chunk.id, {
        id: chunk.id,
        documentId: chunk.documentId,
        documentVersionId: chunk.documentVersionId,
      });
    }

    const manifest = buildSnapshotManifest(
      headSha,
      parentSha,
      sortDocuments(Array.from(documentMap.values())),
      sortChunkEntries(Array.from(chunkEntries.values())),
      {
        artifactEntries: artifactIndex.artifactEntries,
        chunkScopes: {
          durable: Array.from(changedChunks.values())
            .flat()
            .map((chunk) => chunk.id)
            .concat(
              candidates.fullSnapshot
                ? []
                : Array.from(chunkEntries.values())
                    .map((chunk) => chunk.id)
                    .filter((id) => !artifactIndex.chunks.some((chunk) => chunk.id === id)),
            )
            .filter((value, index, items) => items.indexOf(value) === index),
          session: artifactIndex.chunkScopes.session,
          harness: artifactIndex.chunkScopes.harness,
          evidence: artifactIndex.chunkScopes.evidence,
        },
      },
    );
    await writeSnapshotManifest(cwd, manifest);
    transaction = { ...transaction, phase: "manifest-committed" };
    transaction = await updateIngestTransaction(cwd, transaction, { phase: "manifest-committed" });
    await runIngestTestHook(dependencies, "after-manifest", {
      cwd,
      headSha,
      transaction,
      documentVersionIds,
      chunkIds,
    });

    await appendLedgerEvent(cwd, {
      eventType: "ingest.completed",
      goalId: null,
      episodeId: null,
      sessionId: null,
      sourceHeadSha: headSha,
      summary: `Ingested ${processed} document${processed === 1 ? "" : "s"} into ${scope} scope`,
      artifactIds: boundArtifactIds,
      relatedPaths: plannedFiles,
      provenance: {
        actor: "assistant",
        producer: "ragit",
        producerVersion: RAGIT_VERSION,
        operation: "ingest.completed",
        inputRefs: plannedFiles,
        outputRefs: [manifestPath],
        evidenceRefs: [],
        contentHash: `${headSha}:${processed}:${scope}:${manifestPath}`,
      },
    });
    await updateIngestTransaction(cwd, transaction, { status: "completed", phase: "completed" });
    return {
      mode: "apply",
      processed,
      skipped,
      masked,
      commitSha: headSha,
      manifestPath,
      searchReady: true,
      plannedFiles,
      deletedDocumentIds: candidates.deletedDocumentIds,
      dirtyCandidates,
      wouldFail: false,
      fullSnapshot: candidates.fullSnapshot,
      scope,
      boundArtifactIds,
      admission,
      docAuthority: {
        validated: config.docs_authority.validate_on_ingest,
        violations: contractViolations,
        skipped: contractSkipped,
      },
      warnings,
    };
  } catch (error) {
    await failIngestTransaction(cwd, transaction, error);
    throw error;
  }
};

export const runIngest = async (
  cwd: string,
  options: IngestOptions,
  dependencies: RunIngestDependencies = {},
): Promise<IngestSummary> => {
  if (options.dryRun) return runIngestUnlocked(cwd, options, dependencies);

  const context = await resolveRepositoryContext(cwd);
  if (context.headSha === null) return runIngestUnlocked(context.gitRoot, options, dependencies);

  return withStoreWriteLock(
    context.gitRoot,
    { command: "ingest", headSha: context.headSha },
    () => runIngestUnlocked(context.gitRoot, options, dependencies),
  );
};
