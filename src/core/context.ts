import { CliView } from "./cliContract.js";
import { formatQueryResultText, projectRetrievalHits } from "./output.js";
import { RedactionSummary, RetrievalHit } from "./types.js";
import { mergeRedactionSummaries, sanitizeKnowledgeText } from "./security.js";
import { runUnifiedRetrieval, selectHitsWithinBudget, UnifiedArtifactRetrievalOptions } from "./retrieval.js";
import type { SnapshotMetadata } from "./snapshot.js";

export interface ContextPackOptions {
  budget?: number;
  at?: string;
  scope?: "durable" | "session" | "harness" | "evidence" | "all";
}

export interface ContextPackResult {
  goal: string;
  snapshotSha: string;
  snapshot: SnapshotMetadata;
  budget: number;
  usedTokens: number;
  selectedHits: number;
  hits: RetrievalHit[];
  warnings: string[];
  redactionSummary: RedactionSummary;
}

const resolveArtifactOptionsForScope = (
  scope?: ContextPackOptions["scope"],
): UnifiedArtifactRetrievalOptions | undefined => {
  if (!scope || scope === "durable") return undefined;
  return {
    mode: "explicit-scope",
    scope: scope === "all" ? "all" : scope,
  };
};

export const packContext = async (
  cwd: string,
  goal: string,
  options: ContextPackOptions,
): Promise<ContextPackResult> => {
  const budget = options.budget ?? 1200;
  const result = await runUnifiedRetrieval(cwd, {
    query: goal,
    at: options.at,
    topK: 30,
    scope: options.scope,
    includeSnapshot: true,
    artifactOptions: resolveArtifactOptionsForScope(options.scope),
  });
  if (!result.snapshotSha) {
    throw new Error("사용 가능한 snapshot이 없습니다.");
  }
  const sanitizedGoal = sanitizeKnowledgeText(goal, "context.pack", "goal");
  const selected = selectHitsWithinBudget(result.hits, budget);
  return {
    goal: sanitizedGoal.text,
    snapshotSha: result.snapshotSha,
    snapshot: result.snapshot,
    budget,
    usedTokens: selected.usedTokens,
    selectedHits: selected.hits.length,
    hits: selected.hits,
    warnings: result.warnings,
    redactionSummary: mergeRedactionSummaries(result.redactionSummary, sanitizedGoal.summary),
  };
};

export const formatContextPackText = (packet: ContextPackResult, view: CliView): string => {
  const queryText = formatQueryResultText(
    packet.goal,
    {
      snapshotSha: packet.snapshotSha,
      snapshot: packet.snapshot,
      hits: packet.hits,
      warnings: packet.warnings,
      redactionSummary: packet.redactionSummary,
    },
    view,
  );
  return [
    "# ragit context pack",
    `- goal: ${packet.goal}`,
    `- snapshot: ${packet.snapshotSha}`,
    `- budget: ${packet.budget}`,
    `- used_tokens: ${packet.usedTokens}`,
    `- selected_hits: ${packet.selectedHits}`,
    `- warnings: ${packet.warnings.length}`,
    `- view: ${view}`,
    `- redaction_applied: ${packet.redactionSummary.applied}`,
    `- masked_count: ${packet.redactionSummary.maskedCount}`,
    "",
    queryText,
  ].join("\n");
};

export const projectContextPack = (packet: ContextPackResult, view: CliView): Omit<ContextPackResult, "hits"> & {
  hits: ReturnType<typeof projectRetrievalHits>;
} => ({
  goal: packet.goal,
  snapshotSha: packet.snapshotSha,
  snapshot: packet.snapshot,
  budget: packet.budget,
  usedTokens: packet.usedTokens,
  selectedHits: packet.selectedHits,
  warnings: packet.warnings,
  redactionSummary: packet.redactionSummary,
  hits: projectRetrievalHits(packet.hits, view),
});
