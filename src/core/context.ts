import { formatQueryResult } from "./output.js";
import { searchKnowledge } from "./retrieval.js";

export interface ContextPackOptions {
  budget?: number;
  at?: string;
}

const countTokens = (text: string): number => text.split(/\s+/).filter(Boolean).length;

export const packContext = async (
  cwd: string,
  goal: string,
  options: ContextPackOptions,
): Promise<{ markdown: string; json: string }> => {
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
  const limitedResult = {
    snapshotSha: result.snapshotSha,
    hits: selected,
  };
  const output = formatQueryResult(goal, limitedResult, "both");
  const summary = [
    `# ragit context pack`,
    `- goal: ${goal}`,
    `- snapshot: ${result.snapshotSha}`,
    `- budget: ${budget}`,
    `- used_tokens: ${usedTokens}`,
    `- selected_hits: ${selected.length}`,
    "",
    output.markdown ?? "",
  ].join("\n");
  const meta = JSON.stringify(
    {
      goal,
      snapshotSha: result.snapshotSha,
      budget,
      usedTokens,
      selectedHits: selected.length,
      hits: selected,
    },
    null,
    2,
  );
  return {
    markdown: summary,
    json: meta,
  };
};
