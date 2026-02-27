import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

export const BOUNDARY_REGEX_SOURCE = "^#{2,6}\\s*(\\[[A-Z][0-9]+(?:\\.[a-z0-9]+)*\\])\\s+([^\\n]+)$";
export const GRF_REGEX_SOURCE =
  "^#{2,6}\\s*\\[?(Ground|Rule|Failure Trajectory|Flow)\\s+([0-9]+)([A-Za-z]+)?\\]?\\s+(.*)$";

const BOUNDARY_REGEX = new RegExp(BOUNDARY_REGEX_SOURCE);
const GRF_REGEX = new RegExp(GRF_REGEX_SOURCE);

export interface GuideBoundary {
  id: string;
  title: string;
  level: number;
  startLine: number;
  endLine: number;
  parentId: string | null;
}

export interface GuideSection {
  rootId: string;
  blockStartLine: number;
  blockEndLine: number;
  childIds: string[];
}

export interface GuideIndex {
  version: string;
  generatedAt: string;
  source: {
    path: string;
    mode: "created" | "loaded";
    sha256: string;
  };
  parser: {
    boundaryRegex: string;
    grfRegex: string;
  };
  boundaries: GuideBoundary[];
  sections: GuideSection[];
  templateMap: Record<string, string>;
  defaults: {
    language: "ko";
    profile: "topological";
    docTypes: string[];
  };
}

export interface AgentsInstructionResult {
  path: string;
  mode: "created" | "loaded";
  content: string;
  sha256: string;
}

export interface GuideStructureResult {
  guideDir: string;
  indexPath: string;
  createdFiles: string[];
  skippedFiles: string[];
}

const computeSha256 = (source: string): string => createHash("sha256").update(source).digest("hex");

const templateMapRelative: Record<string, string> = {
  adr: ".ragit/guide/templates/adr.template.md",
  prd: ".ragit/guide/templates/prd.template.md",
  srs: ".ragit/guide/templates/srs.template.md",
  plan: ".ragit/guide/templates/plan.template.md",
  ddd: ".ragit/guide/templates/ddd.template.md",
  glossary: ".ragit/guide/templates/glossary.template.md",
};

const commonTemplateRelativePath = ".ragit/guide/templates/_common.template.md";

const templateSeed: Record<string, string> = {
  "adr.template.md": `---
type: adr
---
# ADR-{N}: Decision Title

## Context
- 문제 배경

## Decision
- 선택한 결정

## Consequences
- 기대 효과
- 리스크
`,
  "prd.template.md": `---
type: prd
---
# PRD: Product Requirement

## Goal
- 제품 목표

## User Stories
- As a ...

## Acceptance Criteria
- [ ] 조건 1
`,
  "srs.template.md": `---
type: srs
---
# SRS: Software Requirements

## Functional Requirements
- FR-001

## Non-Functional Requirements
- NFR-001
`,
  "plan.template.md": `---
type: plan
---
# Plan

## Milestones
- M1

## Work Breakdown
- Task 1
`,
  "ddd.template.md": `---
type: ddd
---
# DDD

## Bounded Context
- Context name

## Aggregate
- Aggregate Root
`,
  "glossary.template.md": `---
type: glossary
---
# Glossary

## Terms
- **용어**: 정의
`,
  "_common.template.md": `# Common Guide

## Naming
- 일관된 용어를 사용합니다.

## Evidence
- 모든 결정은 출처를 남깁니다.
`,
};

export const createTopologicalAgentsSeed = (): string => `당신의 이름은 [G선생] 이다.
사용자의 이름은 'Rhio'이며, G선생은 모든 대답을 경어체 한국어로 대답한다.

## [B1] 지침문 정의
본 문서는 ragit 표준 에이전트 지침문입니다.

## [B2] 식별자 인식과 구조 규칙
### [B2.a] 식별자 탐색용 정규식
\`/^#{2,6}\\s*(\\[[A-Z][0-9]+(?:\\.[a-z0-9]+)*\\])\\s+([^\\n]+)/gm\`

## [B3] Attention 공명
상위 식별자는 하위 식별자의 의미 흐름을 안정화합니다.

## [B4] GRF (Ground/Rule/Flow)
동일한 번호를 공유하는 Ground/Rule/Flow는 하나의 의미 집합입니다.

## [Rule 1] System-Wide Rule Document Structural Protocol
헤더 깊이와 인덱스 깊이는 정합되어야 합니다.
`;

const findParentId = (id: string, parentCandidates: Set<string>): string | null => {
  if (/^\[[A-Z][0-9]+(?:\.[a-z0-9]+)*\]$/.test(id)) {
    const value = id.slice(1, -1);
    const segments = value.split(".");
    if (segments.length <= 1) return null;
    const parent = `[${segments.slice(0, -1).join(".")}]`;
    return parentCandidates.has(parent) ? parent : null;
  }
  const grfSub = id.match(/^(Ground|Rule|Failure Trajectory|Flow)\s+([0-9]+)([A-Za-z]+)$/);
  if (grfSub) {
    const parent = `${grfSub[1]} ${grfSub[2]}`;
    return parentCandidates.has(parent) ? parent : null;
  }
  return null;
};

export const parseGuideBoundaries = (content: string): { boundaries: GuideBoundary[]; sections: GuideSection[] } => {
  const lines = content.split(/\r?\n/);
  const provisional: Array<Omit<GuideBoundary, "endLine" | "parentId">> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const bracketMatch = line.match(BOUNDARY_REGEX);
    if (bracketMatch) {
      const level = (line.match(/^#+/)?.[0].length ?? 2);
      provisional.push({
        id: bracketMatch[1],
        title: bracketMatch[2].trim(),
        level,
        startLine: index + 1,
      });
      continue;
    }
    const grfMatch = line.match(GRF_REGEX);
    if (grfMatch) {
      const level = (line.match(/^#+/)?.[0].length ?? 2);
      const kind = grfMatch[1];
      const number = grfMatch[2];
      const suffix = grfMatch[3] ?? "";
      provisional.push({
        id: `${kind} ${number}${suffix}`,
        title: grfMatch[4].trim(),
        level,
        startLine: index + 1,
      });
    }
  }

  const idSet = new Set(provisional.map((entry) => entry.id));
  const boundaries: GuideBoundary[] = provisional.map((entry, index) => {
    const next = provisional[index + 1];
    const endLine = next ? next.startLine - 1 : lines.length;
    const parentId = findParentId(entry.id, idSet);
    return {
      ...entry,
      endLine,
      parentId,
    };
  });

  const byId = new Map<string, GuideBoundary>();
  for (const boundary of boundaries) byId.set(boundary.id, boundary);

  const resolveRoot = (id: string): string => {
    let cursor = byId.get(id);
    while (cursor?.parentId) {
      const parent = byId.get(cursor.parentId);
      if (!parent) break;
      cursor = parent;
    }
    return cursor?.id ?? id;
  };

  const roots = boundaries.filter((boundary) => !boundary.parentId);
  const sections: GuideSection[] = roots.map((root, index) => {
    const nextRoot = roots[index + 1];
    const blockEndLine = nextRoot ? nextRoot.startLine - 1 : lines.length;
    const childIds = boundaries
      .filter((boundary) => boundary.id !== root.id && resolveRoot(boundary.id) === root.id)
      .map((boundary) => boundary.id);
    return {
      rootId: root.id,
      blockStartLine: root.startLine,
      blockEndLine,
      childIds,
    };
  });

  return { boundaries, sections };
};

export const ensureAgentsInstruction = async (cwd: string): Promise<AgentsInstructionResult> => {
  const target = path.join(cwd, "AGENTS.md");
  try {
    const content = await readFile(target, "utf8");
    return {
      path: target,
      mode: "loaded",
      content,
      sha256: computeSha256(content),
    };
  } catch {
    const seed = createTopologicalAgentsSeed();
    await writeFile(target, seed, "utf8");
    return {
      path: target,
      mode: "created",
      content: seed,
      sha256: computeSha256(seed),
    };
  }
};

const ensureFile = async (filePath: string, content: string): Promise<"created" | "skipped"> => {
  try {
    await access(filePath, constants.F_OK);
    return "skipped";
  } catch {
    await writeFile(filePath, content, "utf8");
    return "created";
  }
};

export const ensureGuideStructure = async (cwd: string): Promise<GuideStructureResult> => {
  const guideDir = path.join(cwd, ".ragit", "guide");
  const templatesDir = path.join(guideDir, "templates");
  const indexPath = path.join(guideDir, "guide-index.json");
  await mkdir(templatesDir, { recursive: true });
  const createdFiles: string[] = [];
  const skippedFiles: string[] = [];
  for (const [fileName, content] of Object.entries(templateSeed)) {
    const absolutePath = path.join(templatesDir, fileName);
    const result = await ensureFile(absolutePath, content);
    const relativePath = path.relative(cwd, absolutePath).replaceAll(path.sep, "/");
    if (result === "created") createdFiles.push(relativePath);
    if (result === "skipped") skippedFiles.push(relativePath);
  }
  return {
    guideDir,
    indexPath,
    createdFiles,
    skippedFiles,
  };
};

export const buildGuideIndex = (agents: AgentsInstructionResult, parsed: ReturnType<typeof parseGuideBoundaries>): GuideIndex => ({
  version: "0.1.0",
  generatedAt: new Date().toISOString(),
  source: {
    path: agents.path,
    mode: agents.mode,
    sha256: agents.sha256,
  },
  parser: {
    boundaryRegex: BOUNDARY_REGEX_SOURCE,
    grfRegex: GRF_REGEX_SOURCE,
  },
  boundaries: parsed.boundaries,
  sections: parsed.sections,
  templateMap: templateMapRelative,
  defaults: {
    language: "ko",
    profile: "topological",
    docTypes: ["adr", "prd", "srs", "plan", "ddd", "glossary"],
  },
});

export const writeGuideIndex = async (cwd: string, index: GuideIndex): Promise<string> => {
  const target = path.join(cwd, ".ragit", "guide", "guide-index.json");
  await writeFile(target, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  return target;
};

export const templatePathsForSummary = (): string[] => [...Object.values(templateMapRelative), commonTemplateRelativePath];
