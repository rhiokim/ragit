import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { assertAllowedKeys, assertRepoRelativePathArray } from "./cliInput.js";
import { CliView } from "./cliContract.js";
import { loadConfig } from "./config.js";
import { toRepoPath } from "./identity.js";
import { runIngest } from "./ingest.js";
import {
  MemoryDecision,
  MemoryOpenLoop,
  MemoryPromoteResult,
  MemoryWrapResult,
  OpenLoopRegistry,
  PlanPromotionCandidate,
  PromotionBatchInput,
  PromotionCandidate,
  RecallPacket,
  SessionWrapInput,
  SessionWrapRecord,
  WorkingMemoryState,
} from "./memoryTypes.js";
import { ensureRagitStructure } from "./project.js";
import { QueryResult, searchKnowledge } from "./retrieval.js";
import { projectRetrievalHits } from "./output.js";
import { RagitConfig, RetrievalHit } from "./types.js";
import { getHeadSha } from "./git.js";

interface ResolvedMemoryPaths {
  corpusDir: string;
  decisionsDir: string;
  glossaryDir: string;
  plansDir: string;
  sessionDir: string;
  workingDir: string;
  currentPath: string;
  openLoopsPath: string;
}

const fileExists = async (target: string): Promise<boolean> => {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

const normalizeWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim();

const asString = (value: unknown, label: string): string => {
  if (typeof value !== "string") {
    throw new Error(`memory payload의 ${label} 값은 문자열이어야 합니다.`);
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`memory payload의 ${label} 값은 비어 있을 수 없습니다.`);
  }
  return normalized;
};

const asOptionalString = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
};

const asStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
};

const stableId = (...parts: string[]): string => createHash("sha1").update(parts.join(":")).digest("hex");

const normalizeDecision = (value: unknown): MemoryDecision => {
  if (!value || typeof value !== "object") {
    throw new Error("memory payload의 decisions 항목은 객체여야 합니다.");
  }
  const raw = value as Record<string, unknown>;
  assertAllowedKeys(raw, ["id", "title", "summary", "rationale", "alternatives", "consequences", "relatedFiles"], "decisions[]");
  const title = asString(raw.title, "decisions[].title");
  const summary = asString(raw.summary, "decisions[].summary");
  return {
    id: asOptionalString(raw.id) ?? stableId(title, summary),
    title,
    summary,
    rationale: asOptionalString(raw.rationale),
    alternatives: asStringArray(raw.alternatives),
    consequences: asStringArray(raw.consequences),
    relatedFiles: assertRepoRelativePathArray(asStringArray(raw.relatedFiles), "decisions[].relatedFiles"),
  };
};

const normalizeOpenLoop = (value: unknown): MemoryOpenLoop => {
  if (!value || typeof value !== "object") {
    throw new Error("memory payload의 openLoops 항목은 객체여야 합니다.");
  }
  const raw = value as Record<string, unknown>;
  assertAllowedKeys(raw, ["id", "title", "status", "nextAction", "blockingConditions", "relatedFiles", "sourceSessionId"], "openLoops[]");
  const title = asString(raw.title, "openLoops[].title");
  const nextAction = asString(raw.nextAction, "openLoops[].nextAction");
  const status = asOptionalString(raw.status);
  const normalizedStatus =
    status === "blocked" || status === "in_progress" || status === "closed" ? status : "open";
  return {
    id: asOptionalString(raw.id) ?? stableId(title, nextAction),
    title,
    status: normalizedStatus,
    nextAction,
    blockingConditions: asStringArray(raw.blockingConditions),
    relatedFiles: assertRepoRelativePathArray(asStringArray(raw.relatedFiles), "openLoops[].relatedFiles"),
    sourceSessionId: asOptionalString(raw.sourceSessionId),
  };
};

const normalizePromotionCandidate = (value: unknown): PromotionCandidate => {
  if (!value || typeof value !== "object") {
    throw new Error("memory payload의 promotionCandidates 항목은 객체여야 합니다.");
  }
  const raw = value as Record<string, unknown>;
  assertAllowedKeys(
    raw,
    [
      "id",
      "kind",
      "title",
      "summary",
      "tags",
      "context",
      "decision",
      "consequences",
      "alternatives",
      "term",
      "definition",
      "aliases",
      "milestones",
      "workBreakdown",
    ],
    "promotionCandidates[]",
  );
  const kind = asString(raw.kind, "promotionCandidates[].kind");
  const title = asString(raw.title, "promotionCandidates[].title");
  const summary = asString(raw.summary, "promotionCandidates[].summary");
  const base = {
    id: asOptionalString(raw.id),
    title,
    summary,
    tags: asStringArray(raw.tags),
  };
  if (kind === "decision") {
    return {
      ...base,
      kind,
      context: asOptionalString(raw.context),
      decision: asOptionalString(raw.decision),
      consequences: asStringArray(raw.consequences),
      alternatives: asStringArray(raw.alternatives),
    };
  }
  if (kind === "glossary") {
    return {
      ...base,
      kind,
      term: asOptionalString(raw.term),
      definition: asOptionalString(raw.definition),
      aliases: asStringArray(raw.aliases),
    };
  }
  if (kind === "plan") {
    return {
      ...base,
      kind,
      milestones: asStringArray(raw.milestones),
      workBreakdown: asStringArray(raw.workBreakdown),
    };
  }
  throw new Error(`지원하지 않는 promotionCandidates[].kind 값입니다: ${kind}`);
};

export const normalizeSessionWrapInput = (value: unknown): SessionWrapInput => {
  if (!value || typeof value !== "object") {
    throw new Error("memory wrap 입력은 JSON 객체여야 합니다.");
  }
  const raw = value as Record<string, unknown>;
  assertAllowedKeys(
    raw,
    ["goal", "summary", "constraints", "decisions", "openLoops", "nextActions", "promotionCandidates", "sourceHeadSha", "createdAt"],
    "memory wrap",
  );
  return {
    goal: asString(raw.goal, "goal"),
    summary: asString(raw.summary, "summary"),
    constraints: asStringArray(raw.constraints),
    decisions: Array.isArray(raw.decisions) ? raw.decisions.map(normalizeDecision) : [],
    openLoops: Array.isArray(raw.openLoops) ? raw.openLoops.map(normalizeOpenLoop) : [],
    nextActions: asStringArray(raw.nextActions),
    promotionCandidates: Array.isArray(raw.promotionCandidates)
      ? raw.promotionCandidates.map(normalizePromotionCandidate)
      : [],
    sourceHeadSha: raw.sourceHeadSha === null ? null : asOptionalString(raw.sourceHeadSha),
    createdAt: asOptionalString(raw.createdAt),
  };
};

export const normalizePromotionBatchInput = (value: unknown): PromotionBatchInput => {
  if (Array.isArray(value)) {
    return {
      promotionCandidates: value.map(normalizePromotionCandidate),
    };
  }
  if (!value || typeof value !== "object") {
    throw new Error("memory promote 입력은 JSON 객체 또는 배열이어야 합니다.");
  }
  const raw = value as Record<string, unknown>;
  assertAllowedKeys(raw, ["promotionCandidates", "sourceSessionId", "sourceHeadSha", "sessionId"], "memory promote");
  return {
    promotionCandidates: Array.isArray(raw.promotionCandidates)
      ? raw.promotionCandidates.map(normalizePromotionCandidate)
      : [],
    sourceSessionId: raw.sourceSessionId === null ? null : asOptionalString(raw.sourceSessionId),
    sourceHeadSha: raw.sourceHeadSha === null ? null : asOptionalString(raw.sourceHeadSha),
  };
};

const resolveMemoryPaths = (cwd: string, config: RagitConfig): ResolvedMemoryPaths => {
  const corpusDir = path.resolve(cwd, config.memory.corpus_dir);
  const sessionDir = path.resolve(cwd, config.memory.session_dir);
  const workingDir = path.resolve(cwd, config.memory.working_dir);
  return {
    corpusDir,
    decisionsDir: path.join(corpusDir, "decisions"),
    glossaryDir: path.join(corpusDir, "glossary"),
    plansDir: path.join(corpusDir, "plans"),
    sessionDir,
    workingDir,
    currentPath: path.join(workingDir, "current.json"),
    openLoopsPath: path.join(workingDir, "open-loops.json"),
  };
};

const ensureMemoryLayout = async (
  paths: ResolvedMemoryPaths,
  options: { includeCorpus?: boolean } = {},
): Promise<void> => {
  await mkdir(paths.sessionDir, { recursive: true });
  await mkdir(paths.workingDir, { recursive: true });
  if (options.includeCorpus ?? true) {
    await mkdir(paths.decisionsDir, { recursive: true });
    await mkdir(paths.glossaryDir, { recursive: true });
    await mkdir(paths.plansDir, { recursive: true });
  }
};

const readJsonIfExists = async <T>(target: string): Promise<T | null> => {
  if (!(await fileExists(target))) return null;
  const content = await readFile(target, "utf8");
  return JSON.parse(content) as T;
};

const writeJson = async (target: string, payload: unknown): Promise<void> => {
  await writeFile(target, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
};

const safeHeadSha = async (cwd: string): Promise<string | null> => {
  try {
    return await getHeadSha(cwd);
  } catch {
    return null;
  }
};

const toSessionTimestamp = (isoString: string): string => isoString.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

const createSessionId = (createdAt: string, goal: string): string => {
  const seed = createHash("sha1").update(goal).digest("hex").slice(0, 8);
  return `${toSessionTimestamp(createdAt)}-${seed}`;
};

const activeOpenLoops = (items: MemoryOpenLoop[]): MemoryOpenLoop[] => items.filter((item) => item.status !== "closed");

const uniqueBy = <T>(items: T[], keyOf: (item: T) => string): T[] => {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const key = keyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
};

const compactText = (text: string, max = 200): string => {
  const normalized = normalizeWhitespace(text);
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max)}...`;
};

const fallbackDecisionTitle = (targetPath: string): string => {
  const base = path.basename(targetPath, path.extname(targetPath));
  return base
    .split(/[-_]/g)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
};

const hitToDecision = (hit: RetrievalHit): MemoryDecision => ({
  id: hit.chunkId,
  title: fallbackDecisionTitle(hit.path),
  summary: compactText(hit.text),
});

const isRecoverableRecallError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("사용 가능한 snapshot이 없습니다.") ||
    message.includes("snapshot을 찾을 수 없습니다") ||
    message.includes("zvec store가 아직 초기화되지 않았습니다.")
  );
};

const renderStringList = (title: string, items: string[]): string[] => {
  if (items.length === 0) return [`## ${title}`, "- 없음", ""];
  return [`## ${title}`, ...items.map((item) => `- ${item}`), ""];
};

const renderOpenLoops = (items: MemoryOpenLoop[]): string[] => {
  if (items.length === 0) return ["## Open Loops", "- 없음", ""];
  return [
    "## Open Loops",
    ...items.flatMap((item) => [
      `- [${item.status}] ${item.title}`,
      `  next: ${item.nextAction}`,
      ...(item.blockingConditions && item.blockingConditions.length > 0 ? [`  blockers: ${item.blockingConditions.join("; ")}`] : []),
    ]),
    "",
  ];
};

const renderDecisions = (items: MemoryDecision[]): string[] => {
  if (items.length === 0) return ["## Related Decisions", "- 없음", ""];
  return [
    "## Related Decisions",
    ...items.flatMap((item) => [`- ${item.title}`, `  ${compactText(item.summary, 240)}`]),
    "",
  ];
};

const renderRetrievedHits = (hits: RetrievalHit[], view: CliView): string[] => {
  if (hits.length === 0) return ["## Retrieved Hits", "- 없음", ""];
  return [
    "## Retrieved Hits",
    ...projectRetrievalHits(hits, view).flatMap((hit, index) => [
      `${index + 1}. \`${hit.path}\` · ${hit.sectionTitle} · score=${hit.scoreFinal.toFixed(4)}`,
      `   - ${hit.text ?? hit.excerpt ?? ""}`,
    ]),
    "",
  ];
};

const projectDecision = (item: MemoryDecision, view: CliView): MemoryDecision => {
  if (view === "full") return item;
  return {
    ...item,
    summary: compactText(item.summary, view === "minimal" ? 120 : 240),
    rationale: view === "minimal" ? undefined : item.rationale,
    alternatives: view === "minimal" ? undefined : item.alternatives,
    consequences: view === "minimal" ? undefined : item.consequences,
  };
};

export const projectRecallPacket = (packet: RecallPacket, view: CliView): Omit<RecallPacket, "retrievedHits" | "relatedDecisions"> & {
  retrievedHits: ReturnType<typeof projectRetrievalHits>;
  relatedDecisions: MemoryDecision[];
} => ({
  ...packet,
  retrievedHits: projectRetrievalHits(packet.retrievedHits, view),
  relatedDecisions: packet.relatedDecisions.map((item) => projectDecision(item, view)),
});

export const formatRecallPacket = (packet: RecallPacket, view: CliView = "default"): { markdown: string; json: string } => {
  const projected = projectRecallPacket(packet, view);
  const markdown = [
    "# ragit memory recall",
    `- goal: ${projected.goal}`,
    `- latest_session: ${projected.latestSessionId ?? "none"}`,
    `- snapshot: ${projected.snapshotSha ?? "none"}`,
    `- source_head: ${projected.sourceHeadSha ?? "none"}`,
    `- view: ${view}`,
    "",
    ...renderStringList("Constraints", projected.constraints),
    ...renderOpenLoops(projected.openLoops),
    ...renderDecisions(projected.relatedDecisions),
    ...renderRetrievedHits(packet.retrievedHits, view),
    ...renderStringList("Next Actions", projected.nextActions),
    ...renderStringList("Warnings", projected.warnings),
  ].join("\n");
  return {
    markdown,
    json: JSON.stringify(projected, null, 2),
  };
};

const toWorkingState = (record: SessionWrapRecord): WorkingMemoryState => ({
  goal: record.goal,
  summary: record.summary,
  constraints: record.constraints,
  decisions: record.decisions,
  openLoops: activeOpenLoops(record.openLoops).map((item) => ({
    ...item,
    sourceSessionId: item.sourceSessionId ?? record.sessionId,
  })),
  nextActions: record.nextActions,
  latestSessionId: record.sessionId,
  sourceHeadSha: record.sourceHeadSha,
  updatedAt: record.createdAt,
});

export const loadWorkingMemoryState = async (cwd: string): Promise<WorkingMemoryState | null> => {
  await ensureRagitStructure(cwd);
  const config = await loadConfig(cwd);
  const paths = resolveMemoryPaths(cwd, config);
  await ensureMemoryLayout(paths, { includeCorpus: false });
  return readJsonIfExists<WorkingMemoryState>(paths.currentPath);
};

export const loadOpenLoopRegistry = async (cwd: string): Promise<OpenLoopRegistry | null> => {
  await ensureRagitStructure(cwd);
  const config = await loadConfig(cwd);
  const paths = resolveMemoryPaths(cwd, config);
  await ensureMemoryLayout(paths, { includeCorpus: false });
  return readJsonIfExists<OpenLoopRegistry>(paths.openLoopsPath);
};

export const loadLatestSessionWrap = async (cwd: string): Promise<SessionWrapRecord | null> => {
  await ensureRagitStructure(cwd);
  const config = await loadConfig(cwd);
  const paths = resolveMemoryPaths(cwd, config);
  await ensureMemoryLayout(paths, { includeCorpus: false });
  const files = (await readdir(paths.sessionDir))
    .filter((name) => name.endsWith(".json"))
    .sort((left, right) => right.localeCompare(left));
  const latest = files[0];
  if (!latest) return null;
  return readJsonIfExists<SessionWrapRecord>(path.join(paths.sessionDir, latest));
};

export const runMemoryWrap = async (cwd: string, payload: SessionWrapInput, dryRun = false): Promise<MemoryWrapResult> => {
  await ensureRagitStructure(cwd);
  const config = await loadConfig(cwd);
  const paths = resolveMemoryPaths(cwd, config);
  await ensureMemoryLayout(paths, { includeCorpus: false });

  const createdAt = payload.createdAt ?? new Date().toISOString();
  const currentHeadSha = await safeHeadSha(cwd);
  const sourceHeadSha = payload.sourceHeadSha ?? currentHeadSha;
  const sessionId = createSessionId(createdAt, payload.goal);
  const sessionPath = path.join(paths.sessionDir, `${sessionId}.json`);

  const record: SessionWrapRecord = {
    sessionId,
    goal: payload.goal,
    summary: payload.summary,
    constraints: payload.constraints,
    decisions: payload.decisions,
    openLoops: payload.openLoops,
    nextActions: payload.nextActions,
    promotionCandidates: payload.promotionCandidates,
    sourceHeadSha,
    createdAt,
  };

  const working = toWorkingState(record);
  const registry: OpenLoopRegistry = {
    latestSessionId: sessionId,
    updatedAt: createdAt,
    items: working.openLoops,
  };

  if (!dryRun) {
    await writeJson(sessionPath, record);
    await writeJson(paths.currentPath, working);
    await writeJson(paths.openLoopsPath, registry);
  }

  const warnings = currentHeadSha ? [] : ["HEAD commit이 없어 sourceHeadSha를 null로 저장했습니다."];
  return {
    sessionId,
    sessionPath: toRepoPath(cwd, sessionPath),
    currentPath: toRepoPath(cwd, paths.currentPath),
    openLoopsPath: toRepoPath(cwd, paths.openLoopsPath),
    sourceHeadSha,
    dryRun,
    warnings,
  };
};

const runRecallSearch = async (
  cwd: string,
  query: string,
  topK: number,
): Promise<{ result: QueryResult | null; warnings: string[] }> => {
  try {
    return {
      result: await searchKnowledge(cwd, query, { topK }),
      warnings: [],
    };
  } catch (error) {
    if (!isRecoverableRecallError(error)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return {
      result: null,
      warnings: [`검색 snapshot이 없어 working memory만으로 복원했습니다: ${message}`],
    };
  }
};

export const recallMemory = async (cwd: string, goal: string): Promise<{ packet: RecallPacket; markdown: string; json: string }> => {
  await ensureRagitStructure(cwd);
  const config = await loadConfig(cwd);
  const paths = resolveMemoryPaths(cwd, config);
  await ensureMemoryLayout(paths, { includeCorpus: false });

  const working = await readJsonIfExists<WorkingMemoryState>(paths.currentPath);
  const latestSession = await loadLatestSessionWrap(cwd);
  const searchGoal = working?.goal && working.goal !== goal ? `${goal}\n${working.goal}` : goal;
  const search = await runRecallSearch(cwd, searchGoal, config.memory.recall_top_k);
  const retrievedHits = search.result?.hits ?? [];
  const decisionHits = retrievedHits
    .filter((hit) => hit.path.startsWith(`${config.memory.corpus_dir.replace(/\\/g, "/")}/decisions/`))
    .map(hitToDecision);

  const openLoops = working?.openLoops ?? activeOpenLoops(latestSession?.openLoops ?? []);
  const relatedDecisions = uniqueBy(
    [...(working?.decisions ?? []), ...(latestSession?.decisions ?? []), ...decisionHits],
    (item) => item.id,
  );
  const packet: RecallPacket = {
    goal,
    constraints: uniqueBy([...(working?.constraints ?? []), ...(latestSession?.constraints ?? [])], (item) => item),
    openLoops,
    relatedDecisions,
    retrievedHits,
    nextActions: uniqueBy([...(working?.nextActions ?? []), ...(latestSession?.nextActions ?? [])], (item) => item),
    latestSessionId: working?.latestSessionId ?? latestSession?.sessionId ?? null,
    sourceHeadSha: working?.sourceHeadSha ?? latestSession?.sourceHeadSha ?? null,
    snapshotSha: search.result?.snapshotSha ?? null,
    createdAt: new Date().toISOString(),
    warnings: search.warnings,
  };
  const formatted = formatRecallPacket(packet);
  return {
    packet,
    markdown: formatted.markdown,
    json: formatted.json,
  };
};

const slugify = (value: string): string => {
  const normalized = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, " ")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || "memory-artifact";
};

const uniqueTargetPath = async (dir: string, baseName: string): Promise<string> => {
  let candidate = path.join(dir, `${baseName}.md`);
  let suffix = 2;
  while (await fileExists(candidate)) {
    candidate = path.join(dir, `${baseName}-${suffix}.md`);
    suffix += 1;
  }
  return candidate;
};

const quoteFrontmatter = (value: string): string => value.replaceAll('"', '\\"');

const renderDecisionDoc = (candidate: Extract<PromotionCandidate, { kind: "decision" }>, promotedAt: string, sourceSessionId?: string | null): string => {
  const consequences = uniqueBy(
    [...(candidate.consequences ?? []), ...(candidate.alternatives ?? []).map((item) => `Alternative considered: ${item}`)],
    (item) => item,
  );
  const consequenceLines = consequences.length > 0 ? consequences.map((item) => `- ${item}`).join("\n") : "- No recorded consequences yet.";
  return `---
type: adr
source_session: "${quoteFrontmatter(sourceSessionId ?? "")}"
promoted_at: "${promotedAt}"
---
# ADR: ${candidate.title}

## Context
${candidate.context ?? candidate.summary}

## Decision
${candidate.decision ?? candidate.summary}

## Consequences
${consequenceLines}
`;
};

const renderGlossaryDoc = (candidate: Extract<PromotionCandidate, { kind: "glossary" }>, promotedAt: string, sourceSessionId?: string | null): string => {
  const term = candidate.term ?? candidate.title;
  const aliases = candidate.aliases ?? [];
  const aliasLines = aliases.length > 0 ? `\n- **Aliases**: ${aliases.join(", ")}` : "";
  return `---
type: glossary
source_session: "${quoteFrontmatter(sourceSessionId ?? "")}"
promoted_at: "${promotedAt}"
---
# Glossary: ${candidate.title}

## Terms
- **${term}**: ${candidate.definition ?? candidate.summary}${aliasLines}
`;
};

const renderPlanDoc = (candidate: PlanPromotionCandidate, promotedAt: string, sourceSessionId?: string | null): string => {
  const milestones = candidate.milestones && candidate.milestones.length > 0 ? candidate.milestones : [candidate.summary];
  const tasks = candidate.workBreakdown && candidate.workBreakdown.length > 0 ? candidate.workBreakdown : [candidate.summary];
  return `---
type: plan
source_session: "${quoteFrontmatter(sourceSessionId ?? "")}"
promoted_at: "${promotedAt}"
---
# Plan: ${candidate.title}

## Milestones
${milestones.map((item) => `- ${item}`).join("\n")}

## Work Breakdown
${tasks.map((item) => `- ${item}`).join("\n")}
`;
};

const renderPromotionDocument = (candidate: PromotionCandidate, promotedAt: string, sourceSessionId?: string | null): string => {
  if (candidate.kind === "decision") return renderDecisionDoc(candidate, promotedAt, sourceSessionId);
  if (candidate.kind === "glossary") return renderGlossaryDoc(candidate, promotedAt, sourceSessionId);
  return renderPlanDoc(candidate, promotedAt, sourceSessionId);
};

const targetDirectoryForCandidate = (paths: ResolvedMemoryPaths, candidate: PromotionCandidate): string => {
  if (candidate.kind === "decision") return paths.decisionsDir;
  if (candidate.kind === "glossary") return paths.glossaryDir;
  return paths.plansDir;
};

export const promoteMemory = async (cwd: string, input: PromotionBatchInput, dryRun = false): Promise<MemoryPromoteResult> => {
  await ensureRagitStructure(cwd);
  const config = await loadConfig(cwd);
  const paths = resolveMemoryPaths(cwd, config);
  await ensureMemoryLayout(paths, { includeCorpus: !dryRun });

  const promotedAt = new Date().toISOString();
  const plannedFiles: string[] = [];
  const createdFiles: string[] = [];
  for (const candidate of input.promotionCandidates) {
    const baseName = slugify(candidate.id ?? candidate.title);
    const target = await uniqueTargetPath(targetDirectoryForCandidate(paths, candidate), baseName);
    const content = renderPromotionDocument(candidate, promotedAt, input.sourceSessionId);
    const repoPath = toRepoPath(cwd, target);
    plannedFiles.push(repoPath);
    if (dryRun) continue;
    await writeFile(target, content, "utf8");
    createdFiles.push(repoPath);
  }

  const currentHeadSha = await safeHeadSha(cwd);
  const sourceHeadSha = input.sourceHeadSha ?? currentHeadSha;
  const warnings: string[] = [];

  if (plannedFiles.length === 0) {
    warnings.push("promotionCandidates가 비어 있어 생성된 문서가 없습니다.");
  }

  let ingested = false;
  if (!dryRun && createdFiles.length > 0 && config.memory.auto_ingest_promotions) {
    if (currentHeadSha) {
      await runIngest(cwd, { files: createdFiles.join(",") });
      ingested = true;
    } else {
      warnings.push("HEAD commit이 없어 promotion 문서 인덱싱을 건너뛰었습니다.");
    }
  }
  if (dryRun && plannedFiles.length > 0 && config.memory.auto_ingest_promotions && !currentHeadSha) {
    warnings.push("HEAD commit이 없어 dry-run 이후 실제 promote 시 인덱싱이 건너뛰어집니다.");
  }

  return {
    createdFiles,
    plannedFiles,
    sourceHeadSha,
    ingested,
    dryRun,
    warnings,
  };
};
