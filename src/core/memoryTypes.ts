import { RetrievalHit } from "./types.js";

export type MemoryOpenLoopStatus = "open" | "blocked" | "in_progress" | "closed";

export interface MemoryDecision {
  id: string;
  title: string;
  summary: string;
  rationale?: string;
  alternatives?: string[];
  consequences?: string[];
  relatedFiles?: string[];
}

export interface MemoryOpenLoop {
  id: string;
  title: string;
  status: MemoryOpenLoopStatus;
  nextAction: string;
  blockingConditions?: string[];
  relatedFiles?: string[];
  sourceSessionId?: string;
}

interface PromotionCandidateBase {
  id?: string;
  title: string;
  summary: string;
  tags?: string[];
}

export interface DecisionPromotionCandidate extends PromotionCandidateBase {
  kind: "decision";
  context?: string;
  decision?: string;
  consequences?: string[];
  alternatives?: string[];
}

export interface GlossaryPromotionCandidate extends PromotionCandidateBase {
  kind: "glossary";
  term?: string;
  definition?: string;
  aliases?: string[];
}

export interface PlanPromotionCandidate extends PromotionCandidateBase {
  kind: "plan";
  milestones?: string[];
  workBreakdown?: string[];
}

export type PromotionCandidate =
  | DecisionPromotionCandidate
  | GlossaryPromotionCandidate
  | PlanPromotionCandidate;

export interface SessionWrapInput {
  goal: string;
  summary: string;
  constraints: string[];
  decisions: MemoryDecision[];
  openLoops: MemoryOpenLoop[];
  nextActions: string[];
  promotionCandidates: PromotionCandidate[];
  sourceHeadSha?: string | null;
  createdAt?: string;
}

export interface SessionWrapRecord {
  sessionId: string;
  goal: string;
  summary: string;
  constraints: string[];
  decisions: MemoryDecision[];
  openLoops: MemoryOpenLoop[];
  nextActions: string[];
  promotionCandidates: PromotionCandidate[];
  sourceHeadSha: string | null;
  createdAt: string;
}

export interface WorkingMemoryState {
  goal: string;
  summary: string;
  constraints: string[];
  decisions: MemoryDecision[];
  openLoops: MemoryOpenLoop[];
  nextActions: string[];
  latestSessionId: string | null;
  sourceHeadSha: string | null;
  updatedAt: string;
}

export interface OpenLoopRegistry {
  latestSessionId: string | null;
  updatedAt: string;
  items: MemoryOpenLoop[];
}

export interface RecallPacket {
  goal: string;
  constraints: string[];
  openLoops: MemoryOpenLoop[];
  relatedDecisions: MemoryDecision[];
  retrievedHits: RetrievalHit[];
  nextActions: string[];
  latestSessionId: string | null;
  sourceHeadSha: string | null;
  snapshotSha: string | null;
  createdAt: string;
  warnings: string[];
}

export interface MemoryWrapResult {
  sessionId: string;
  sessionPath: string;
  currentPath: string;
  openLoopsPath: string;
  sourceHeadSha: string | null;
  dryRun: boolean;
  warnings: string[];
}

export interface PromotionBatchInput {
  promotionCandidates: PromotionCandidate[];
  sourceSessionId?: string | null;
  sourceHeadSha?: string | null;
}

export interface MemoryPromoteResult {
  createdFiles: string[];
  plannedFiles: string[];
  sourceHeadSha: string | null;
  ingested: boolean;
  dryRun: boolean;
  warnings: string[];
}
