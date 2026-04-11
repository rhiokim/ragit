import { access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { buildArtifactIndexData, bindPendingArtifacts } from "./artifacts.js";
import { chunkSections, parseSections } from "./chunk.js";
import { loadConfig } from "./config.js";
import { validateKnownDoc } from "./doc-authority.js";
import { detectDocType } from "./docType.js";
import { appendLedgerEvent } from "./event-ledger.js";
import { hashFileContent, listAllDocumentFiles, listDocumentFilesByGlob } from "./files.js";
import { getHeadSha, getParentSha, listChangedFilesSince } from "./git.js";
import { chunkVersionId, documentIdFromPath, documentVersionId, toRepoPath } from "./identity.js";
import { maskSecrets } from "./mask.js";
import { buildSnapshotManifest, latestSnapshotSha, loadSnapshotManifestIfExists, writeSnapshotManifest } from "./manifest.js";
import { embedTexts, resolveEmbeddingProfile, toEmbeddingContract } from "./embedding.js";
import { ensureRagitStructure } from "./project.js";
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
import { bootstrapCanonicalStore, closeCanonicalStore, writeChunksToCanonicalStore, writeDocumentsToCanonicalStore } from "./store.js";
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

const isDocumentLikePath = (target: string): boolean => {
  const normalized = target.replaceAll(path.sep, "/");
  if (normalized.includes("/.git/") || normalized.includes("/.ragit/") || normalized.includes("/node_modules/") || normalized.includes("/dist/")) {
    return false;
  }
  const extension = path.extname(normalized).toLowerCase();
  return extension === ".md" || extension === ".mdx";
};

const matchesAnyGlob = (target: string, patterns: string[]): boolean =>
  patterns.some((pattern) => path.matchesGlob(target, pattern));

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
    const files = await listDocumentFilesByGlob(cwd, options.files);
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
    const changed = await listChangedFilesSince(cwd, options.since);
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

export const runIngest = async (cwd: string, options: IngestOptions): Promise<IngestSummary> => {
  await ensureRagitStructure(cwd);
  const config = await loadConfig(cwd);
  assertKnowledgeWriteSecurity(config, "ingest", Boolean(options.dryRun));
  const embeddingProfile = resolveEmbeddingProfile(config);
  if (!canUseRemoteEmbedding(config, embeddingProfile, "durable-doc")) {
    throw new Error("현재 embedding provider는 remote egress가 필요하지만 security.remote_embedding_policy=local-only 입니다.");
  }
  const cacheMode = options.dryRun ? "readonly" : "readwrite";
  const candidates = await resolveCandidates(cwd, config, options);
  const scope = options.scope ?? "durable";
  const headSha = await getHeadSha(cwd);
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

  for (const absolutePath of candidates.files) {
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

  const parentSha = await getParentSha(cwd);
  const boundArtifactIds = await bindPendingArtifacts(cwd, headSha);
  const store = await bootstrapCanonicalStore(cwd, toEmbeddingContract(embeddingProfile), false);

  try {

    const baseSnapshot =
      candidates.fullSnapshot
        ? null
        : (await loadSnapshotManifestIfExists(cwd, parentSha)) ??
          (await loadSnapshotManifestIfExists(cwd, await latestSnapshotSha(cwd)));

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
    writeDocumentsToCanonicalStore(store, newDocuments);
    writeChunksToCanonicalStore(store, newChunks);

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
    const manifestPath = `.ragit/manifest/${headSha}.json`;
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
  } finally {
    closeCanonicalStore(store);
  }
};
