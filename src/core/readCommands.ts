import { runStatus } from "../commands/bootstrap.js";
import { normalizeCliView } from "./cliContract.js";
import {
  normalizeContextPackCommandInput,
  normalizeQueryCommandInput,
} from "./commandInputs.js";
import { packContext, projectContextPack } from "./context.js";
import { projectRetrievalHits } from "./output.js";
import {
  searchKnowledge,
  type RetrievalExecutionPolicy,
} from "./retrieval.js";
import { mergeRedactionSummaries, sanitizeKnowledgeText } from "./security.js";

export interface ReadCommandDependencies {
  runStatus: typeof runStatus;
  searchKnowledge: typeof searchKnowledge;
  packContext: typeof packContext;
}

export interface ReadCommandOptions {
  view?: string;
  executionPolicy?: RetrievalExecutionPolicy;
}

const defaultReadCommandDependencies: ReadCommandDependencies = {
  runStatus,
  searchKnowledge,
  packContext,
};

export const createReadCommandExecutor = (
  dependencies: ReadCommandDependencies = defaultReadCommandDependencies,
) => ({
  status: async (cwd: string) => ({
    data: await dependencies.runStatus(cwd),
    warnings: [] as string[],
  }),

  query: async (cwd: string, value: unknown, options: ReadCommandOptions = {}) => {
    const input = normalizeQueryCommandInput(value);
    const view = normalizeCliView(options.view, "default");
    const result = await dependencies.searchKnowledge(cwd, input.question, {
      topK: input.topK,
      at: input.at,
      scope: input.scope,
      executionPolicy: options.executionPolicy,
    });
    const sanitized = sanitizeKnowledgeText(input.question, "query.output", "query");
    const redactionSummary = mergeRedactionSummaries(sanitized.summary, result.redactionSummary);
    const normalizedResult = { ...result, redactionSummary };
    const data = {
      query: sanitized.text,
      snapshotSha: result.snapshotSha,
      snapshot: result.snapshot,
      scope: input.scope ?? "durable",
      explain: input.explain ?? false,
      hits: projectRetrievalHits(result.hits, view, input.explain ?? false),
      warnings: result.warnings,
      redactionSummary,
    };
    return {
      input,
      view,
      result: normalizedResult,
      data,
      warnings: result.warnings,
    };
  },

  contextPack: async (cwd: string, value: unknown, options: ReadCommandOptions = {}) => {
    const input = normalizeContextPackCommandInput(value);
    const view = normalizeCliView(options.view, "default");
    const packet = await dependencies.packContext(cwd, input.goal, {
      budget: input.budget,
      at: input.at,
      scope: input.scope,
      executionPolicy: options.executionPolicy,
    });
    return {
      input,
      view,
      packet,
      data: projectContextPack(packet, view),
      warnings: packet.warnings,
    };
  },
});

export const readCommandExecutor = createReadCommandExecutor();
