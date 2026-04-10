import { CliView } from "./cliContract.js";
import { listGitCommits } from "./git.js";
import { deriveLogSemanticOverlay } from "./logSemantic.js";
import { loadSnapshotManifestIfExists } from "./manifest.js";
import { attachRedactionSummary, sanitizeStructuredValue } from "./security.js";
import {
  DocType,
  DocumentRecord,
  KnownDocType,
  RagitLogSemanticOverlay,
  RedactionSummary,
  SnapshotManifest,
} from "./types.js";

export interface RagitLogOptions {
  revRange?: string;
  maxCount?: number;
  docType?: KnownDocType | null;
  path?: string;
  showMissing?: boolean;
}

export interface RagitLogChangedDoc {
  path: string;
  status: "A" | "M" | "D";
  docType: DocType;
  sectionCountBefore: number;
  sectionCountAfter: number;
  chunkCountBefore: number;
  chunkCountAfter: number;
  memoryPath: boolean;
}

export interface RagitLogEntry {
  commitSha: string;
  subject: string;
  authorName: string;
  authoredAt: string;
  snapshot: {
    status: "indexed" | "missing";
    createdAt: string | null;
    previousSnapshotSha: string | null;
    docs: number;
    chunks: number;
    delta: {
      added: number;
      modified: number;
      deleted: number;
    };
    types: Record<string, number>;
    changed: RagitLogChangedDoc[];
  };
  semantic: RagitLogSemanticOverlay;
}

export interface RagitLogResult {
  revRange: string | null;
  maxCount: number | null;
  showMissing: boolean;
  filters: {
    docType: KnownDocType | null;
    path: string | null;
  };
  entries: RagitLogEntry[];
  redactionSummary: RedactionSummary;
}

export interface ProjectedRagitLogResult {
  revRange: string | null;
  maxCount: number | null;
  showMissing: boolean;
  view: CliView;
  filters: {
    docType: KnownDocType | null;
    path: string | null;
  };
  redactionSummary: RedactionSummary;
  entries: Array<{
    commitSha: string;
    subject: string;
    authorName: string;
    authoredAt: string;
    snapshot: {
      status: "indexed" | "missing";
      createdAt: string | null;
      previousSnapshotSha?: string | null;
      docs: number;
      chunks: number;
      delta: {
        added: number;
        modified: number;
        deleted: number;
      };
      types: Record<string, number>;
      changed?: Array<{
        path: string;
        status: "A" | "M" | "D";
        docType: DocType;
        sectionCountBefore?: number;
        sectionCountAfter?: number;
        chunkCountBefore?: number;
        chunkCountAfter?: number;
        memoryPath?: boolean;
      }>;
    };
    semantic: {
      available: boolean;
      headline: string;
      counts: {
        beliefs: number;
        openLoops: number;
        evidence: number;
        artifacts: number;
      };
      beliefs?: Array<{
        artifactId: string;
        kind: string;
        scope: string;
        status: string;
        title: string;
        summary: string;
        authority?: string | null;
        confidence?: number | null;
        sourceSessionId?: string | null;
        goalId?: string | null;
        episodeId?: string | null;
      }>;
      openLoops?: Array<{
        artifactId: string;
        kind: string;
        scope: string;
        status: string;
        title: string;
        summary: string;
        authority?: string | null;
        confidence?: number | null;
        sourceSessionId?: string | null;
        goalId?: string | null;
        episodeId?: string | null;
      }>;
      evidence?: Array<{
        artifactId: string;
        artifactKind: string;
        artifactScope: string;
        artifactStatus: string;
        evidenceId: string;
        excerpt: string;
        authority?: string | null;
        confidence?: number | null;
        sourceSessionId?: string | null;
        goalId?: string | null;
        episodeId?: string | null;
      }>;
      artifacts?: Array<{
        artifactId: string;
        kind: string;
        scope: string;
        status: string;
        tier?: string;
        bindingStatus?: string;
        searchPolicy?: string;
        sourceSessionId?: string | null;
        goalId?: string | null;
        episodeId?: string | null;
        sourceHeadSha?: string | null;
        path?: string;
        loaded?: boolean;
        title?: string | null;
        summary?: string | null;
        authority?: string | null;
        confidence?: number | null;
      }>;
    };
  }>;
}

const shortSha = (sha: string): string => sha.slice(0, 7);

const normalizeRepoPath = (value: string): string => value.replaceAll("\\", "/");

const escapeRegex = (value: string): string => value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");

const compileGlobPattern = (pattern: string): RegExp => {
  const normalized = normalizeRepoPath(pattern.trim());
  let regex = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const current = normalized[index];
    const next = normalized[index + 1];
    const afterNext = normalized[index + 2];
    if (current === "*" && next === "*" && afterNext === "/") {
      regex += "(?:.*/)?";
      index += 2;
      continue;
    }
    if (current === "*" && next === "*") {
      regex += ".*";
      index += 1;
      continue;
    }
    if (current === "*") {
      regex += "[^/]*";
      continue;
    }
    if (current === "?") {
      regex += "[^/]";
      continue;
    }
    regex += escapeRegex(current);
  }
  regex += "$";
  return new RegExp(regex);
};

const createPathMatcher = (globText?: string): ((candidate: string) => boolean) => {
  if (!globText) return () => true;
  const matchers = globText
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(compileGlobPattern);
  if (matchers.length === 0) return () => true;
  return (candidate: string) => {
    const normalized = normalizeRepoPath(candidate);
    return matchers.some((matcher) => matcher.test(normalized));
  };
};

const createChunkCountMap = (manifest: SnapshotManifest): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const chunk of manifest.chunks) {
    counts.set(chunk.documentId, (counts.get(chunk.documentId) ?? 0) + 1);
  }
  return counts;
};

const isMemoryPath = (repoPath: string): boolean => {
  const normalized = normalizeRepoPath(repoPath);
  return normalized.startsWith("docs/memory/");
};

const filterDocuments = (
  docs: DocumentRecord[],
  options: {
    docType?: KnownDocType | null;
    pathMatcher: (candidate: string) => boolean;
  },
): DocumentRecord[] =>
  docs.filter((doc) => {
    if (options.docType && doc.docType !== options.docType) return false;
    return options.pathMatcher(doc.path);
  });

const docsByPath = (docs: DocumentRecord[]): Map<string, DocumentRecord> =>
  new Map(docs.map((doc) => [normalizeRepoPath(doc.path), doc]));

const compareChangedDocs = (
  currentDocs: DocumentRecord[],
  previousDocs: DocumentRecord[],
  currentChunkCounts: Map<string, number>,
  previousChunkCounts: Map<string, number>,
): RagitLogChangedDoc[] => {
  const currentByPath = docsByPath(currentDocs);
  const previousByPath = docsByPath(previousDocs);
  const changed: RagitLogChangedDoc[] = [];

  for (const current of currentDocs) {
    const previous = previousByPath.get(normalizeRepoPath(current.path));
    if (!previous) {
      changed.push({
        path: normalizeRepoPath(current.path),
        status: "A",
        docType: current.docType,
        sectionCountBefore: 0,
        sectionCountAfter: current.sections.length,
        chunkCountBefore: 0,
        chunkCountAfter: currentChunkCounts.get(current.id) ?? 0,
        memoryPath: isMemoryPath(current.path),
      });
      continue;
    }
    if (previous.versionId !== current.versionId || previous.hash !== current.hash) {
      changed.push({
        path: normalizeRepoPath(current.path),
        status: "M",
        docType: current.docType,
        sectionCountBefore: previous.sections.length,
        sectionCountAfter: current.sections.length,
        chunkCountBefore: previousChunkCounts.get(previous.id) ?? 0,
        chunkCountAfter: currentChunkCounts.get(current.id) ?? 0,
        memoryPath: isMemoryPath(current.path),
      });
    }
  }

  for (const previous of previousDocs) {
    if (currentByPath.has(normalizeRepoPath(previous.path))) continue;
    changed.push({
      path: normalizeRepoPath(previous.path),
      status: "D",
      docType: previous.docType,
      sectionCountBefore: previous.sections.length,
      sectionCountAfter: 0,
      chunkCountBefore: previousChunkCounts.get(previous.id) ?? 0,
      chunkCountAfter: 0,
      memoryPath: isMemoryPath(previous.path),
    });
  }

  const statusOrder = new Map<RagitLogChangedDoc["status"], number>([
    ["A", 0],
    ["M", 1],
    ["D", 2],
  ]);
  changed.sort((left, right) => {
    const pathCompare = left.path.localeCompare(right.path);
    if (pathCompare !== 0) return pathCompare;
    return (statusOrder.get(left.status) ?? 0) - (statusOrder.get(right.status) ?? 0);
  });
  return changed;
};

const summarizeTypes = (docs: DocumentRecord[]): Record<string, number> => {
  const counts = new Map<string, number>();
  for (const doc of docs) {
    counts.set(doc.docType, (counts.get(doc.docType) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort((left, right) => left[0].localeCompare(right[0])));
};

const hasMeaningfulSnapshotContent = (entry: RagitLogEntry): boolean =>
  entry.snapshot.docs > 0 ||
  entry.snapshot.chunks > 0 ||
  entry.snapshot.changed.length > 0 ||
  Object.keys(entry.snapshot.types).length > 0 ||
  entry.semantic.counts.artifacts > 0;

const compactText = (value: string | null | undefined, max = 96): string => {
  if (!value) return "";
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
};

export const runRagitLog = async (cwd: string, options: RagitLogOptions = {}): Promise<RagitLogResult> => {
  const commits = await listGitCommits(cwd, { revRange: options.revRange });
  const manifests = new Map<string, SnapshotManifest | null>();
  const artifactCache = new Map();
  const loadManifest = async (sha: string): Promise<SnapshotManifest | null> => {
    if (!manifests.has(sha)) {
      manifests.set(sha, await loadSnapshotManifestIfExists(cwd, sha));
    }
    return manifests.get(sha) ?? null;
  };

  const pathMatcher = createPathMatcher(options.path);
  const entries: RagitLogEntry[] = [];

  for (let index = 0; index < commits.length; index += 1) {
    const commit = commits[index];
    const manifest = await loadManifest(commit.sha);
    if (!manifest) {
      if (!options.showMissing) continue;
      entries.push({
        commitSha: commit.sha,
        subject: commit.subject,
        authorName: commit.authorName,
        authoredAt: commit.authoredAt,
        snapshot: {
          status: "missing",
          createdAt: null,
          previousSnapshotSha: null,
          docs: 0,
          chunks: 0,
          delta: {
            added: 0,
            modified: 0,
            deleted: 0,
          },
          types: {},
          changed: [],
        },
        semantic: await deriveLogSemanticOverlay(cwd, null, {
          docType: options.docType,
          pathMatcher,
          hasPathFilter: Boolean(options.path),
          artifactCache,
        }),
      });
      continue;
    }

    let previousSnapshotSha: string | null = null;
    let previousManifest: SnapshotManifest | null = null;
    for (let olderIndex = index + 1; olderIndex < commits.length; olderIndex += 1) {
      const candidate = await loadManifest(commits[olderIndex].sha);
      if (candidate) {
        previousSnapshotSha = candidate.commitSha;
        previousManifest = candidate;
        break;
      }
    }

    const currentDocs = filterDocuments(manifest.docs, {
      docType: options.docType,
      pathMatcher,
    });
    const previousDocs = previousManifest
      ? filterDocuments(previousManifest.docs, {
          docType: options.docType,
          pathMatcher,
        })
      : [];
    const currentChunkCounts = createChunkCountMap(manifest);
    const previousChunkCounts = previousManifest ? createChunkCountMap(previousManifest) : new Map<string, number>();
    const changed = compareChangedDocs(currentDocs, previousDocs, currentChunkCounts, previousChunkCounts);
    const docsCount = currentDocs.length;
    const chunksCount = currentDocs.reduce((total, doc) => total + (currentChunkCounts.get(doc.id) ?? 0), 0);
    const entry: RagitLogEntry = {
      commitSha: commit.sha,
      subject: commit.subject,
      authorName: commit.authorName,
      authoredAt: commit.authoredAt,
      snapshot: {
        status: "indexed",
        createdAt: manifest.createdAt,
        previousSnapshotSha,
        docs: docsCount,
        chunks: chunksCount,
        delta: {
          added: changed.filter((item) => item.status === "A").length,
          modified: changed.filter((item) => item.status === "M").length,
          deleted: changed.filter((item) => item.status === "D").length,
        },
        types: summarizeTypes(currentDocs),
        changed,
      },
      semantic: await deriveLogSemanticOverlay(cwd, manifest, {
        docType: options.docType,
        pathMatcher,
        hasPathFilter: Boolean(options.path),
        artifactCache,
      }),
    };
    if (!options.docType && !options.path) {
      entries.push(entry);
      continue;
    }
    if (hasMeaningfulSnapshotContent(entry)) {
      entries.push(entry);
    }
  }

  const maxCount = options.maxCount && options.maxCount > 0 ? options.maxCount : null;
  const result: Omit<RagitLogResult, "redactionSummary"> = {
    revRange: options.revRange ?? null,
    maxCount,
    showMissing: Boolean(options.showMissing),
    filters: {
      docType: options.docType ?? null,
      path: options.path ?? null,
    },
    entries: maxCount ? entries.slice(0, maxCount) : entries,
  };
  const sanitized = sanitizeStructuredValue(result, "log.output", "log");
  return attachRedactionSummary(sanitized.value, sanitized.summary);
};

const formatTypesLine = (types: Record<string, number>): string => {
  const entries = Object.entries(types);
  if (entries.length === 0) return "none";
  return entries.map(([type, count]) => `${type}=${count}`).join(" ");
};

const formatSemanticCounts = (semantic: RagitLogSemanticOverlay): string =>
  semantic.available
    ? `beliefs=${semantic.counts.beliefs} open=${semantic.counts.openLoops} evidence=${semantic.counts.evidence} artifacts=${semantic.counts.artifacts}`
    : "unavailable";

const renderChangedLine = (changed: RagitLogChangedDoc, view: CliView): string => {
  const head = `  ${changed.status} ${changed.path} [${changed.docType}]`;
  if (view !== "full") return head;
  return `${head} sections=${changed.sectionCountBefore}->${changed.sectionCountAfter} chunks=${changed.chunkCountBefore}->${changed.chunkCountAfter} memory=${changed.memoryPath}`;
};

const renderSemanticStatementLine = (
  item: RagitLogSemanticOverlay["beliefs"][number],
  view: CliView,
): string => {
  const head = `  - ${item.title} [${item.kind} ${item.status}]`;
  if (view !== "full") {
    return item.summary ? `${head} ${compactText(item.summary)}` : head;
  }
  return `${head} authority=${item.authority ?? "none"} confidence=${item.confidence ?? "none"} session=${item.sourceSessionId ?? "none"} goal=${item.goalId ?? "none"} summary=${compactText(item.summary, 140)}`;
};

const renderSemanticEvidenceLine = (
  item: RagitLogSemanticOverlay["evidence"][number],
  view: CliView,
): string => {
  const head = `  - ${item.artifactId}/${item.evidenceId} [${item.artifactKind} ${item.artifactStatus}] ${compactText(item.excerpt)}`;
  if (view !== "full") return head;
  return `${head} authority=${item.authority ?? "none"} confidence=${item.confidence ?? "none"} session=${item.sourceSessionId ?? "none"}`;
};

const renderSemanticArtifactLine = (
  item: RagitLogSemanticOverlay["artifacts"][number],
  view: CliView,
): string => {
  const head = `  - ${item.artifactId} [${item.kind} ${item.status} ${item.scope}]${item.title ? ` ${item.title}` : ""}`;
  if (view !== "full") return head;
  return `${head} loaded=${item.loaded} binding=${item.bindingStatus} authority=${item.authority ?? "none"} confidence=${item.confidence ?? "none"} path=${item.path}`;
};

const renderEntryText = (entry: RagitLogEntry, view: CliView): string => {
  if (view === "minimal") {
    if (entry.snapshot.status === "missing") {
      return `${shortSha(entry.commitSha)} missing | semantic ${formatSemanticCounts(entry.semantic)} | ${entry.subject}`;
    }
    return `${shortSha(entry.commitSha)} indexed docs=${entry.snapshot.docs} chunks=${entry.snapshot.chunks} +${entry.snapshot.delta.added} ~${entry.snapshot.delta.modified} -${entry.snapshot.delta.deleted} | ${formatTypesLine(entry.snapshot.types)} | semantic ${formatSemanticCounts(entry.semantic)} | ${entry.subject}`;
  }

  const lines = [
    `commit ${entry.commitSha}`,
    `Subject: ${entry.subject}`,
    `Author: ${entry.authorName}`,
    `AuthoredAt: ${entry.authoredAt}`,
  ];
  if (entry.snapshot.status === "missing") {
    lines.push("");
    lines.push("Snapshot: missing");
    lines.push("Knowledge: no indexed snapshot for this commit");
    lines.push(`Semantic: ${entry.semantic.headline}`);
    return lines.join("\n");
  }

  lines.push("");
  lines.push(`Snapshot: indexed${entry.snapshot.createdAt ? ` (${entry.snapshot.createdAt})` : ""}`);
  lines.push(`Based on: ${entry.snapshot.previousSnapshotSha ?? "none"}`);
  lines.push(`Knowledge: docs=${entry.snapshot.docs} chunks=${entry.snapshot.chunks}`);
  lines.push(`Semantic delta: +${entry.snapshot.delta.added} modified=${entry.snapshot.delta.modified} deleted=${entry.snapshot.delta.deleted}`);
  lines.push(`Semantic: ${entry.semantic.headline}`);
  lines.push(`Semantic counts: ${formatSemanticCounts(entry.semantic)}`);
  lines.push("Beliefs:");
  if (entry.semantic.beliefs.length === 0) {
    lines.push("  none");
  } else {
    lines.push(...entry.semantic.beliefs.map((item) => renderSemanticStatementLine(item, view)));
  }
  lines.push("Open loops:");
  if (entry.semantic.openLoops.length === 0) {
    lines.push("  none");
  } else {
    lines.push(...entry.semantic.openLoops.map((item) => renderSemanticStatementLine(item, view)));
  }
  lines.push("Evidence:");
  if (entry.semantic.evidence.length === 0) {
    lines.push("  none");
  } else {
    lines.push(...entry.semantic.evidence.map((item) => renderSemanticEvidenceLine(item, view)));
  }
  lines.push("Artifacts:");
  if (entry.semantic.artifacts.length === 0) {
    lines.push("  none");
  } else {
    lines.push(...entry.semantic.artifacts.map((item) => renderSemanticArtifactLine(item, view)));
  }
  lines.push("Changed:");
  if (entry.snapshot.changed.length === 0) {
    lines.push("  none");
  } else {
    lines.push(...entry.snapshot.changed.map((changed) => renderChangedLine(changed, view)));
  }
  lines.push("Types:");
  if (Object.keys(entry.snapshot.types).length === 0) {
    lines.push("  none");
  } else {
    for (const [type, count] of Object.entries(entry.snapshot.types)) {
      lines.push(`  ${type}=${count}`);
    }
  }
  return lines.join("\n");
};

export const formatRagitLogText = (result: RagitLogResult, view: CliView): string => {
  const header = [
    "# ragit log",
    `- entries: ${result.entries.length}`,
    `- show_missing: ${result.showMissing}`,
    `- view: ${view}`,
    `- rev_range: ${result.revRange ?? "HEAD"}`,
    `- max_count: ${result.maxCount ?? "none"}`,
    `- type_filter: ${result.filters.docType ?? "none"}`,
    `- path_filter: ${result.filters.path ?? "none"}`,
    `- redaction_applied: ${result.redactionSummary.applied}`,
    `- masked_count: ${result.redactionSummary.maskedCount}`,
  ];
  if (result.entries.length === 0) {
    return [...header, "", "- no matching entries"].join("\n");
  }
  return [...header, "", ...result.entries.map((entry) => renderEntryText(entry, view))].join("\n\n");
};

const projectSemanticOverlay = (semantic: RagitLogSemanticOverlay, view: CliView) => {
  const base = {
    available: semantic.available,
    headline: semantic.headline,
    counts: semantic.counts,
  };
  if (view === "minimal") {
    return base;
  }
  return {
    ...base,
    beliefs: semantic.beliefs.map((item) => ({
      artifactId: item.artifactId,
      kind: item.kind,
      scope: item.scope,
      status: item.status,
      title: item.title,
      summary: item.summary,
      ...(view === "full"
        ? {
            authority: item.authority,
            confidence: item.confidence,
            sourceSessionId: item.sourceSessionId,
            goalId: item.goalId,
            episodeId: item.episodeId,
          }
        : {}),
    })),
    openLoops: semantic.openLoops.map((item) => ({
      artifactId: item.artifactId,
      kind: item.kind,
      scope: item.scope,
      status: item.status,
      title: item.title,
      summary: item.summary,
      ...(view === "full"
        ? {
            authority: item.authority,
            confidence: item.confidence,
            sourceSessionId: item.sourceSessionId,
            goalId: item.goalId,
            episodeId: item.episodeId,
          }
        : {}),
    })),
    evidence: semantic.evidence.map((item) => ({
      artifactId: item.artifactId,
      artifactKind: item.artifactKind,
      artifactScope: item.artifactScope,
      artifactStatus: item.artifactStatus,
      evidenceId: item.evidenceId,
      excerpt: item.excerpt,
      ...(view === "full"
        ? {
            authority: item.authority,
            confidence: item.confidence,
            sourceSessionId: item.sourceSessionId,
            goalId: item.goalId,
            episodeId: item.episodeId,
          }
        : {}),
    })),
    artifacts: semantic.artifacts.map((item) => ({
      artifactId: item.artifactId,
      kind: item.kind,
      scope: item.scope,
      status: item.status,
      ...(view === "full"
        ? {
            tier: item.tier,
            bindingStatus: item.bindingStatus,
            searchPolicy: item.searchPolicy,
            sourceSessionId: item.sourceSessionId,
            goalId: item.goalId,
            episodeId: item.episodeId,
            sourceHeadSha: item.sourceHeadSha,
            path: item.path,
            loaded: item.loaded,
            title: item.title,
            summary: item.summary,
            authority: item.authority,
            confidence: item.confidence,
          }
        : {
            loaded: item.loaded,
            title: item.title,
          }),
    })),
  };
};

export const projectRagitLogResult = (result: RagitLogResult, view: CliView): ProjectedRagitLogResult => ({
  revRange: result.revRange,
  maxCount: result.maxCount,
  showMissing: result.showMissing,
  view,
  filters: result.filters,
  redactionSummary: result.redactionSummary,
  entries: result.entries.map((entry) => ({
    commitSha: entry.commitSha,
    subject: entry.subject,
    authorName: entry.authorName,
    authoredAt: entry.authoredAt,
    snapshot: {
      status: entry.snapshot.status,
      createdAt: entry.snapshot.createdAt,
      previousSnapshotSha: view === "minimal" ? undefined : entry.snapshot.previousSnapshotSha,
      docs: entry.snapshot.docs,
      chunks: entry.snapshot.chunks,
      delta: entry.snapshot.delta,
      types: entry.snapshot.types,
      changed:
        view === "minimal"
          ? undefined
          : entry.snapshot.changed.map((changed) => ({
              path: changed.path,
              status: changed.status,
              docType: changed.docType,
              ...(view === "full"
                ? {
                    sectionCountBefore: changed.sectionCountBefore,
                    sectionCountAfter: changed.sectionCountAfter,
                    chunkCountBefore: changed.chunkCountBefore,
                    chunkCountAfter: changed.chunkCountAfter,
                    memoryPath: changed.memoryPath,
                  }
              : {}),
            })),
    },
    semantic: projectSemanticOverlay(entry.semantic, view),
  })),
});
