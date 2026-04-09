import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { assertAllowedKeys } from "./cliInput.js";
import {
  ArtifactRecord,
  HarnessArtifactKind,
  SearchPolicy,
} from "./types.js";
import { ensureRagitStructure } from "./project.js";
import { getHeadSha } from "./git.js";
import { loadArtifactRecord, persistArtifactRecord } from "./artifacts.js";
import { RAGIT_VERSION } from "./version.js";
import { createDoc, reconcileDocs } from "./doc-authority.js";
import { runIngest } from "./ingest.js";

export interface HarnessCaptureResourceInput {
  kind: HarnessArtifactKind;
  title: string;
  summary?: string;
  input?: Record<string, unknown>;
  expected?: Record<string, unknown>;
  oracleRefs?: string[];
  evidenceRefs?: string[];
  resourceRefs?: string[];
}

export interface HarnessCaptureInput {
  goal: string;
  episodeId?: string;
  sourceSessionId?: string | null;
  artifactRefs?: string[];
  resources: HarnessCaptureResourceInput[];
}

export interface HarnessCaptureResult {
  artifactIds: string[];
  suiteId: string;
  dryRun: boolean;
  warnings: string[];
}

export interface HarnessPromoteInput {
  artifactRefs: string[];
}

export interface HarnessPromoteResult {
  createdFiles: string[];
  plannedFiles: string[];
  ingested: boolean;
  dryRun: boolean;
  warnings: string[];
}

export interface HarnessPackResult {
  suiteId: string;
  goal: string | null;
  resources: Array<Pick<ArtifactRecord, "artifactId" | "kind" | "title" | "summary" | "status">>;
}

export interface HarnessVerifyResult {
  suiteId: string;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
  hasFailure: boolean;
}

const sha1 = (...parts: string[]): string => createHash("sha1").update(parts.join(":")).digest("hex");
const normalizeWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim();
const compactText = (text: string, max = 220): string => {
  const normalized = normalizeWhitespace(text);
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max)}...`;
};
const createGoalId = (goal: string): string => `goal_${sha1(goal).slice(0, 12)}`;
const createArtifactId = (kind: HarnessArtifactKind, goal: string, title: string): string =>
  `art_harness_${kind}_${sha1(kind, goal, title).slice(0, 16)}`;
const asString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} 값은 비어 있지 않은 문자열이어야 합니다.`);
  return value.trim();
};
const asOptionalString = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
};
const asStringArray = (value: unknown, label: string): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} 값은 string[] 이어야 합니다.`);
  return value.map((entry, index) => asString(entry, `${label}[${index}]`));
};

export const normalizeHarnessCaptureInput = (value: unknown): HarnessCaptureInput => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("harness capture 입력은 JSON 객체여야 합니다.");
  }
  const raw = value as Record<string, unknown>;
  assertAllowedKeys(raw, ["goal", "episodeId", "sourceSessionId", "artifactRefs", "resources"], "harness capture");
  if (!Array.isArray(raw.resources)) {
    throw new Error("harness capture.resources 값은 배열이어야 합니다.");
  }
  return {
    goal: asString(raw.goal, "harness capture.goal"),
    episodeId: asOptionalString(raw.episodeId),
    sourceSessionId: raw.sourceSessionId === null ? null : asOptionalString(raw.sourceSessionId),
    artifactRefs: raw.artifactRefs === undefined ? [] : asStringArray(raw.artifactRefs, "harness capture.artifactRefs"),
    resources: raw.resources.map((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`harness capture.resources[${index}] 값은 객체여야 합니다.`);
      }
      const record = entry as Record<string, unknown>;
      assertAllowedKeys(record, ["kind", "title", "summary", "input", "expected", "oracleRefs", "evidenceRefs", "resourceRefs"], `harness capture.resources[${index}]`);
      const kind = asString(record.kind, `harness capture.resources[${index}].kind`) as HarnessArtifactKind;
      if (!["case", "oracle", "failure", "fixture", "golden", "checker", "rubric", "promptTemplate", "trace", "envAssumption", "suite"].includes(kind)) {
        throw new Error(`지원하지 않는 harness resource kind 입니다: ${kind}`);
      }
      return {
        kind,
        title: asString(record.title, `harness capture.resources[${index}].title`),
        summary: asOptionalString(record.summary),
        input: record.input && typeof record.input === "object" && !Array.isArray(record.input) ? (record.input as Record<string, unknown>) : undefined,
        expected: record.expected && typeof record.expected === "object" && !Array.isArray(record.expected) ? (record.expected as Record<string, unknown>) : undefined,
        oracleRefs: asStringArray(record.oracleRefs, `harness capture.resources[${index}].oracleRefs`),
        evidenceRefs: asStringArray(record.evidenceRefs, `harness capture.resources[${index}].evidenceRefs`),
        resourceRefs: asStringArray(record.resourceRefs, `harness capture.resources[${index}].resourceRefs`),
      };
    }),
  };
};

export const normalizeHarnessPromoteInput = (value: unknown): HarnessPromoteInput => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("harness promote 입력은 JSON 객체여야 합니다.");
  }
  const raw = value as Record<string, unknown>;
  assertAllowedKeys(raw, ["artifactRefs"], "harness promote");
  return {
    artifactRefs: asStringArray(raw.artifactRefs, "harness promote.artifactRefs"),
  };
};

const safeHeadSha = async (cwd: string): Promise<string | null> => {
  try {
    return await getHeadSha(cwd);
  } catch {
    return null;
  }
};

const searchPolicyForKind = (kind: HarnessArtifactKind): SearchPolicy =>
  kind === "trace" || kind === "failure" || kind === "fixture" || kind === "golden" ? "evidence" : "harness";

const renderHarnessText = (resource: HarnessCaptureResourceInput): string => {
  const fragments = [
    `# ${resource.title}`,
    "",
    resource.summary ?? `${resource.kind} resource`,
  ];
  if (resource.input) {
    fragments.push("", "## Input", "```json", JSON.stringify(resource.input, null, 2), "```");
  }
  if (resource.expected) {
    fragments.push("", "## Expected", "```json", JSON.stringify(resource.expected, null, 2), "```");
  }
  return fragments.join("\n");
};

const docTargetForKind = (artifact: ArtifactRecord): { docType: "spec" | "plan" | "glossary" | "pbd"; path: string } => {
  const titleSlug = artifact.title
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || artifact.artifactId;
  if (artifact.kind === "suite" || artifact.kind === "envAssumption") {
    return { docType: "plan", path: `docs/harness/plans/${titleSlug}.md` };
  }
  if (artifact.kind === "checker" || artifact.kind === "rubric" || artifact.kind === "case" || artifact.kind === "oracle" || artifact.kind === "trace") {
    return { docType: "spec", path: `docs/harness/specs/${titleSlug}.md` };
  }
  if (artifact.kind === "promptTemplate") {
    return { docType: "pbd", path: `docs/harness/pbds/${titleSlug}.md` };
  }
  if (artifact.kind === "fixture" || artifact.kind === "golden" || artifact.kind === "failure") {
    return { docType: "pbd", path: `docs/harness/pbds/${titleSlug}.md` };
  }
  return { docType: "glossary", path: `docs/harness/glossary/${titleSlug}.md` };
};

const renderHarnessDoc = (artifact: ArtifactRecord): string => {
  const target = docTargetForKind(artifact);
  if (target.docType === "plan") {
    return `---
type: plan
source_artifact: "${artifact.artifactId}"
---
# Plan: ${artifact.title}

## Milestones
- ${artifact.summary}

## Work Breakdown
- Review linked harness resources
- Use suite references as canonical handoff
`;
  }
  if (target.docType === "glossary") {
    return `---
type: glossary
source_artifact: "${artifact.artifactId}"
---
# Glossary: ${artifact.title}

## Terms
- **${artifact.title}**: ${artifact.summary}
`;
  }
  if (target.docType === "spec") {
    return `---
type: spec
source_artifact: "${artifact.artifactId}"
---
# SPEC: ${artifact.title}

## Scope
${artifact.summary}

## Functional Requirements
- Keep the harness resource stable and reviewable.

## Interfaces and Contracts
- Source artifact: ${artifact.artifactId}

## State and Flow
- Status: ${artifact.status}

## Acceptance Criteria
- This harness resource can be loaded by harness pack/verify.
`;
  }
  return `---
type: pbd
source_artifact: "${artifact.artifactId}"
---
# PBD: ${artifact.title}

## Implementation Scope
${artifact.summary}

## Phase Topology
## [B1] Capture
- Source artifact: ${artifact.artifactId}

## Binding Map
- Harness resource is promoted into durable docs/harness.

## Interaction Paths
- Used by harness pack and harness verify.

## Failure and Drift Points
- Resource drift from original session evidence.

## Observability Notes
- Review promotion events and ingest output.
`;
};

export const captureHarness = async (cwd: string, input: HarnessCaptureInput, dryRun = false): Promise<HarnessCaptureResult> => {
  await ensureRagitStructure(cwd);
  const createdAt = new Date().toISOString();
  const goalId = createGoalId(input.goal);
  const headSha = await safeHeadSha(cwd);
  const artifactIds: string[] = [];
  const createdResources: ArtifactRecord[] = [];
  for (const resource of input.resources) {
    const artifactId = createArtifactId(resource.kind, input.goal, resource.title);
    const record: ArtifactRecord = {
      artifactId,
      artifactScope: "harness",
      kind: resource.kind,
      tier: "candidate",
      status: "captured",
      title: resource.title,
      summary: resource.summary ?? compactText(renderHarnessText(resource), 180),
      text: renderHarnessText(resource),
      goalId,
      episodeId: input.episodeId ?? null,
      sourceSessionId: input.sourceSessionId ?? null,
      sourceHeadSha: headSha,
      captureHeadSha: headSha,
      boundHeadSha: headSha,
      bindingStatus: headSha ? "bound" : "pending",
      authority: "assistant_inferred",
      confidence: 0.8,
      searchPolicy: searchPolicyForKind(resource.kind),
      relatedPaths: [],
      tags: [resource.kind, "harness"],
      supersedes: [],
      evidenceRefs: [],
      provenance: {
        actor: "assistant",
        producer: "ragit",
        producerVersion: RAGIT_VERSION,
        operation: "harness.capture",
        inputRefs: [...(input.artifactRefs ?? [])],
        outputRefs: [artifactId],
        evidenceRefs: resource.evidenceRefs ?? [],
        contentHash: sha1(artifactId, createdAt),
      },
      createdAt,
      updatedAt: createdAt,
      payload: {
        goal: input.goal,
        input: resource.input,
        expected: resource.expected,
        oracleRefs: resource.oracleRefs ?? [],
        evidenceRefs: resource.evidenceRefs ?? [],
        resourceRefs: resource.resourceRefs ?? [],
      },
    };
    if (!dryRun) {
      await persistArtifactRecord(cwd, record, false);
    }
    createdResources.push(record);
    artifactIds.push(artifactId);
  }

  let suite = createdResources.find((resource) => resource.kind === "suite");
  if (!suite) {
    const suiteId = createArtifactId("suite", input.goal, `${input.goal} suite`);
    suite = {
      artifactId: suiteId,
      artifactScope: "harness",
      kind: "suite",
      tier: "candidate",
      status: "captured",
      title: `${input.goal} suite`,
      summary: `Harness suite for ${input.goal}`,
      text: `# ${input.goal} suite\n\n${createdResources.map((resource) => `- ${resource.kind}: ${resource.title}`).join("\n")}`,
      goalId,
      episodeId: input.episodeId ?? null,
      sourceSessionId: input.sourceSessionId ?? null,
      sourceHeadSha: headSha,
      captureHeadSha: headSha,
      boundHeadSha: headSha,
      bindingStatus: headSha ? "bound" : "pending",
      authority: "assistant_inferred",
      confidence: 0.82,
      searchPolicy: "harness",
      relatedPaths: [],
      tags: ["suite", "harness"],
      supersedes: [],
      evidenceRefs: [],
      provenance: {
        actor: "assistant",
        producer: "ragit",
        producerVersion: RAGIT_VERSION,
        operation: "harness.capture",
        inputRefs: [...(input.artifactRefs ?? [])],
        outputRefs: [suiteId],
        evidenceRefs: [],
        contentHash: sha1(suiteId, createdAt),
      },
      createdAt,
      updatedAt: createdAt,
      payload: {
        goal: input.goal,
        resourceRefs: createdResources.map((resource) => resource.artifactId),
      },
    };
    if (!dryRun) {
      await persistArtifactRecord(cwd, suite, false);
    }
    artifactIds.push(suite.artifactId);
  }

  return {
    artifactIds,
    suiteId: suite.artifactId,
    dryRun,
    warnings: createdResources.length === 0 ? ["생성된 harness resource가 없습니다."] : [],
  };
};

export const promoteHarness = async (cwd: string, input: HarnessPromoteInput, dryRun = false): Promise<HarnessPromoteResult> => {
  await ensureRagitStructure(cwd);
  const plannedFiles: string[] = [];
  const createdFiles: string[] = [];
  const warnings: string[] = [];
  for (const artifactId of input.artifactRefs) {
    const artifact = await loadArtifactRecord(cwd, artifactId);
    if (!artifact) {
      warnings.push(`artifact를 찾을 수 없습니다: ${artifactId}`);
      continue;
    }
    if (artifact.artifactScope !== "harness") {
      warnings.push(`harness artifact가 아닙니다: ${artifactId}`);
      continue;
    }
    if (artifact.status !== "reviewed") {
      warnings.push(`reviewed 상태만 promote할 수 있습니다: ${artifactId}`);
      continue;
    }
    const target = docTargetForKind(artifact);
    const doc = await createDoc(
      cwd,
      {
        docType: target.docType,
        title: artifact.title,
        path: target.path,
        content: renderHarnessDoc(artifact),
      },
      dryRun,
    );
    plannedFiles.push(doc.path);
    if (!dryRun) {
      createdFiles.push(doc.path);
      await persistArtifactRecord(
        cwd,
        {
          ...artifact,
          status: "promoted",
          tier: "durable",
          authority: "promoted_durable",
          updatedAt: new Date().toISOString(),
        },
        false,
      );
    }
  }

  if (!dryRun && createdFiles.length > 0) {
    await reconcileDocs(cwd, { dryRun: false, ensureStructure: false });
  }
  let ingested = false;
  if (!dryRun && createdFiles.length > 0) {
    const headSha = await safeHeadSha(cwd);
    if (headSha) {
      await runIngest(cwd, { paths: createdFiles, scope: "durable" });
      ingested = true;
    } else {
      warnings.push("HEAD commit이 없어 harness promotion 문서 인덱싱을 건너뛰었습니다.");
    }
  }
  return {
    createdFiles,
    plannedFiles,
    ingested,
    dryRun,
    warnings,
  };
};

const loadSuiteArtifact = async (cwd: string, suiteRef: string): Promise<ArtifactRecord> => {
  if (suiteRef.endsWith(".json") || suiteRef.includes("/")) {
    const content = await readFile(path.resolve(cwd, suiteRef), "utf8");
    return JSON.parse(content) as ArtifactRecord;
  }
  const artifact = await loadArtifactRecord(cwd, suiteRef);
  if (!artifact) {
    throw new Error(`suite를 찾을 수 없습니다: ${suiteRef}`);
  }
  return artifact;
};

export const packHarness = async (cwd: string, suiteRef: string): Promise<HarnessPackResult> => {
  await ensureRagitStructure(cwd);
  const suite = await loadSuiteArtifact(cwd, suiteRef);
  const resourceRefs = Array.isArray(suite.payload?.resourceRefs) ? (suite.payload?.resourceRefs as string[]) : [];
  const resources: Array<Pick<ArtifactRecord, "artifactId" | "kind" | "title" | "summary" | "status">> = [];
  for (const resourceRef of resourceRefs) {
    const artifact = await loadArtifactRecord(cwd, resourceRef);
    if (!artifact) continue;
    resources.push({
      artifactId: artifact.artifactId,
      kind: artifact.kind,
      title: artifact.title,
      summary: artifact.summary,
      status: artifact.status,
    });
  }
  return {
    suiteId: suite.artifactId,
    goal: typeof suite.payload?.goal === "string" ? (suite.payload.goal as string) : suite.goalId,
    resources,
  };
};

export const verifyHarness = async (cwd: string, suiteRef: string): Promise<HarnessVerifyResult> => {
  await ensureRagitStructure(cwd);
  const suite = await loadSuiteArtifact(cwd, suiteRef);
  const checks: HarnessVerifyResult["checks"] = [];
  const resourceRefs = Array.isArray(suite.payload?.resourceRefs) ? (suite.payload?.resourceRefs as string[]) : [];
  checks.push({
    name: "suite.resources",
    ok: resourceRefs.length > 0,
    detail: `resourceRefs=${resourceRefs.length}`,
  });
  for (const resourceRef of resourceRefs) {
    const artifact = await loadArtifactRecord(cwd, resourceRef);
    checks.push({
      name: `suite.resource.${resourceRef}`,
      ok: Boolean(artifact),
      detail: artifact ? artifact.kind : "missing",
    });
    if (!artifact || artifact.kind !== "case") continue;
    const oracleRefs = Array.isArray(artifact.payload?.oracleRefs) ? (artifact.payload?.oracleRefs as string[]) : [];
    const evidenceRefs = Array.isArray(artifact.payload?.evidenceRefs) ? (artifact.payload?.evidenceRefs as string[]) : [];
    checks.push({
      name: `case.oracle.${artifact.artifactId}`,
      ok: oracleRefs.length > 0,
      detail: `oracleRefs=${oracleRefs.length}`,
    });
    checks.push({
      name: `case.evidence.${artifact.artifactId}`,
      ok: evidenceRefs.length > 0,
      detail: `evidenceRefs=${evidenceRefs.length}`,
    });
  }
  return {
    suiteId: suite.artifactId,
    checks,
    hasFailure: checks.some((check) => !check.ok),
  };
};
