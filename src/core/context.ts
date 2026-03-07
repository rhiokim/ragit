import { CliView } from "./cliContract.js";
import { formatQueryResultText, projectRetrievalHits } from "./output.js";
import { RetrievalHit } from "./types.js";
import { searchKnowledge } from "./retrieval.js";

export interface ContextPackOptions {
  budget?: number;
  at?: string;
}

export interface ContextPackResult {
  goal: string;
  snapshotSha: string;
  budget: number;
  usedTokens: number;
  selectedHits: number;
  hits: RetrievalHit[];
}

const countTokens = (text: string): number => text.split(/\s+/).filter(Boolean).length;

export const packContext = async (
  cwd: string,
  goal: string,
  options: ContextPackOptions,
): Promise<ContextPackResult> => {
  const budget = options.budget ?? 1200;
  const result = await searchKnowledge(cwd, goal, { at: options.at, topK: 30 });
  const selected = [];
  let usedTokens = 0;
  for (const hit of result.hits) {
    const tokens = countTokens(hit.text);
    if (selected.length > 0 && usedTokens + tokens > budget) continue;
    selected.push(hit);
    usedTokens += tokens;
    if (usedTokens >= budget) break;
  }
  return {
    goal,
    snapshotSha: result.snapshotSha,
    budget,
    usedTokens,
    selectedHits: selected.length,
    hits: selected,
  };
};

export const formatContextPackText = (packet: ContextPackResult, view: CliView): string => {
  const queryText = formatQueryResultText(packet.goal, { snapshotSha: packet.snapshotSha, hits: packet.hits }, view);
  return [
    "# ragit context pack",
    `- goal: ${packet.goal}`,
    `- snapshot: ${packet.snapshotSha}`,
    `- budget: ${packet.budget}`,
    `- used_tokens: ${packet.usedTokens}`,
    `- selected_hits: ${packet.selectedHits}`,
    `- view: ${view}`,
    "",
    queryText,
  ].join("\n");
};

export const projectContextPack = (packet: ContextPackResult, view: CliView): Omit<ContextPackResult, "hits"> & {
  hits: ReturnType<typeof projectRetrievalHits>;
} => ({
  goal: packet.goal,
  snapshotSha: packet.snapshotSha,
  budget: packet.budget,
  usedTokens: packet.usedTokens,
  selectedHits: packet.selectedHits,
  hits: projectRetrievalHits(packet.hits, view),
});

