import { CliView } from "./cliContract.js";
import { runDrift, DriftQueryOptions } from "./drift.js";
import { runIngest } from "./ingest.js";
import { finalizeIngestTransaction } from "./ingest-finalization.js";
import { scanIngestTransactions } from "./ingest-recovery.js";
import { inspectStoreRebuild, rebuildStoreFromManifests } from "./store-rebuild.js";
import { verifyHarness } from "./harness.js";
import { withStoreWriteLock } from "./store-write-lock.js";
import {
  DriftItem,
  DriftReasonCode,
  DriftResult,
  RepairAction,
  RepairActionKind,
  RepairResult,
} from "./types.js";

export interface RepairOptions extends DriftQueryOptions {
  apply?: boolean;
  actions?: RepairActionKind[];
}

export interface RepairDependencies {
  beforeIngestRecoveryLock?: () => Promise<void> | void;
}

const ACTION_PRIORITY: Record<RepairActionKind, number> = {
  "store-rebuild": -2,
  "ingest-recover": -1,
  ingest: 0,
  "harness-verify": 1,
  "doc-refresh": 2,
  "artifact-review": 3,
  "memory-promote": 4,
  "harness-run": 5,
};

const normalizeActionId = (action: RepairActionKind, index: number): string =>
  `repair_${action.replaceAll("-", "_")}_${String(index + 1).padStart(3, "0")}`;

const unique = (values: string[]): string[] => Array.from(new Set(values.filter(Boolean)));

const containsAnyReason = (item: DriftItem, reasons: DriftReasonCode[]): boolean =>
  reasons.some((reason) => item.reasonCodes.includes(reason));

const splitActionArgs = (action: RepairAction): string[] => [...action.args];

const withIds = (actions: RepairAction[]): RepairAction[] =>
  actions.map((action, index) => ({
    ...action,
    actionId: normalizeActionId(action.action, index),
  }));

export const normalizeRepairActionKind = (value: string | undefined): RepairActionKind | null => {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "ingest" ||
    normalized === "ingest-recover" ||
    normalized === "store-rebuild" ||
    normalized === "doc-refresh" ||
    normalized === "artifact-review" ||
    normalized === "harness-verify" ||
    normalized === "harness-run" ||
    normalized === "memory-promote"
  ) {
    return normalized;
  }
  return null;
};

const sortActions = (actions: RepairAction[]): RepairAction[] =>
  [...actions].sort((left, right) => {
    const byPriority = ACTION_PRIORITY[left.action] - ACTION_PRIORITY[right.action];
    if (byPriority !== 0) return byPriority;
    const byScope = left.sourceScope.localeCompare(right.sourceScope);
    if (byScope !== 0) return byScope;
    return left.sourceItemId.localeCompare(right.sourceItemId);
  });

export const buildRepairPlan = (
  drift: DriftResult,
  actionFilters: RepairActionKind[] = [],
): RepairAction[] => {
  const filterSet = new Set(actionFilters);
  const shouldInclude = (action: RepairActionKind): boolean => filterSet.size === 0 || filterSet.has(action);
  const actions: RepairAction[] = [];

  const baselineItem = drift.items.find((item) => item.itemType === "baseline");
  const needsFullIngest =
    baselineItem !== undefined && containsAnyReason(baselineItem, ["no_baseline", "missing_manifest_anchor"]);

  if (needsFullIngest && shouldInclude("ingest")) {
    actions.push({
      actionId: "",
      action: "ingest",
      sourceItemId: baselineItem.id,
      sourceScope: baselineItem.scope,
      reasonCodes: baselineItem.reasonCodes.filter((reason) => reason === "no_baseline" || reason === "missing_manifest_anchor"),
      status: "planned",
      safeToApply: true,
      requiresInput: false,
      commandPath: "ingest",
      args: ["--all", "--scope", "durable"],
      notes: ["full durable ingest because no current searchable baseline is trusted"],
    });
  }

  if (!needsFullIngest && shouldInclude("ingest")) {
    const targetedItems = drift.items.filter(
      (item) => item.scope === "durable" && item.itemType === "document" && item.reasonCodes.includes("tracked_path_changed"),
    );
    const affectedPaths = unique(targetedItems.flatMap((item) => item.affectedPaths));
    if (affectedPaths.length > 0) {
      const args = affectedPaths.flatMap((entry) => ["--path", entry]);
      actions.push({
        actionId: "",
        action: "ingest",
        sourceItemId: targetedItems.map((item) => item.id).join(","),
        sourceScope: "durable",
        reasonCodes: ["tracked_path_changed"],
        status: "planned",
        safeToApply: true,
        requiresInput: false,
        commandPath: "ingest",
        args: [...args, "--scope", "durable"],
        notes: [`targeted reindex for ${affectedPaths.length} changed durable path${affectedPaths.length === 1 ? "" : "s"}`],
      });
    }
  }

  for (const item of drift.items) {
    if (item.scope === "memory") {
      if (
        shouldInclude("doc-refresh") &&
        containsAnyReason(item, ["related_path_changed", "related_path_missing", "source_head_behind", "bound_head_behind"])
      ) {
        const exactPathArg = item.affectedPaths.length === 1 ? ["--files", item.affectedPaths[0]!] : [];
        actions.push({
          actionId: "",
          action: "doc-refresh",
          sourceItemId: item.id,
          sourceScope: item.scope,
          reasonCodes: item.reasonCodes.filter((reason) =>
            ["related_path_changed", "related_path_missing", "source_head_behind", "bound_head_behind"].includes(reason),
          ),
          status: "blocked",
          safeToApply: false,
          requiresInput: true,
          commandPath: "doc refresh",
          args: exactPathArg,
          notes: [
            "manual file selection is required before doc refresh can run safely",
            ...(item.affectedPaths.length > 0 ? [`affected paths: ${item.affectedPaths.join(", ")}`] : []),
          ],
        });
      }

      if (shouldInclude("artifact-review") && containsAnyReason(item, ["missing_binding", "binding_local_only"])) {
        actions.push({
          actionId: "",
          action: "artifact-review",
          sourceItemId: item.id,
          sourceScope: item.scope,
          reasonCodes: item.reasonCodes.filter((reason) => reason === "missing_binding" || reason === "binding_local_only"),
          status: "blocked",
          safeToApply: false,
          requiresInput: true,
          commandPath: "artifact review",
          args: ["--input", "<artifact-review.json>"],
          notes: ["artifact review stays manual in v1 because it implies a quality approval"],
        });
      }

      if (shouldInclude("memory-promote") && item.status !== "fresh" && item.recommendedActions.includes("memory promote")) {
        actions.push({
          actionId: "",
          action: "memory-promote",
          sourceItemId: item.id,
          sourceScope: item.scope,
          reasonCodes: [...item.reasonCodes],
          status: "blocked",
          safeToApply: false,
          requiresInput: true,
          commandPath: "memory promote",
          args: ["--input", "<promotion-batch.json>"],
          notes: ["promotion candidate synthesis stays manual in v1"],
        });
      }
    }

    if (item.scope === "harness") {
      if (shouldInclude("harness-verify") && containsAnyReason(item, ["dependency_stale", "failure_evidence_present"])) {
        actions.push({
          actionId: "",
          action: "harness-verify",
          sourceItemId: item.id,
          sourceScope: item.scope,
          reasonCodes: item.reasonCodes.filter((reason) => reason === "dependency_stale" || reason === "failure_evidence_present"),
          status: "planned",
          safeToApply: true,
          requiresInput: false,
          commandPath: "harness verify",
          args: ["--suite", item.id],
          notes: ["re-check harness suite structure against the current dependency graph"],
        });
      }

      if (shouldInclude("harness-run") && item.reasonCodes.includes("failure_evidence_present")) {
        actions.push({
          actionId: "",
          action: "harness-run",
          sourceItemId: item.id,
          sourceScope: item.scope,
          reasonCodes: ["failure_evidence_present"],
          status: "blocked",
          safeToApply: false,
          requiresInput: true,
          commandPath: "harness run",
          args: ["--input", "<harness-run.json>"],
          notes: ["executor payload must be supplied explicitly before rerunning a harness suite"],
        });
      }
    }
  }

  const deduped = new Map<string, RepairAction>();
  for (const action of actions) {
    const key = `${action.action}:${action.commandPath}:${action.sourceItemId}:${action.args.join("\u0000")}`;
    if (!deduped.has(key)) {
      deduped.set(key, action);
    }
  }
  return withIds(sortActions(Array.from(deduped.values())));
};

const buildIngestRecoveryPlan = async (
  cwd: string,
  actionFilters: RepairActionKind[],
): Promise<RepairAction[]> => {
  if (actionFilters.length > 0 && !actionFilters.includes("ingest-recover")) return [];
  const diagnostics = await scanIngestTransactions(cwd);
  return diagnostics.pending.map((transaction) => ({
    actionId: "",
    action: "ingest-recover",
    sourceItemId: transaction.transactionId,
    sourceScope: "durable",
    reasonCodes: [],
    status: "planned",
    safeToApply: true,
    requiresInput: false,
    commandPath: "ingest recover",
    args: ["--transaction", transaction.transactionId],
    notes: ["finalize a manifest-visible ingest transaction"],
  }));
};

const buildStoreRebuildPlan = async (
  cwd: string,
  actionFilters: RepairActionKind[],
): Promise<RepairAction[]> => {
  if (!actionFilters.includes("store-rebuild")) return [];
  const inspection = await inspectStoreRebuild(cwd);
  return [{
    actionId: "",
    action: "store-rebuild",
    sourceItemId: "manifest-store",
    sourceScope: "durable",
    reasonCodes: [],
    status: "planned",
    safeToApply: true,
    requiresInput: false,
    commandPath: "store rebuild",
    args: [],
    notes: [
      `manifest union: ${inspection.manifests} manifests, ${inspection.documents} documents, ${inspection.chunks} chunks`,
      `legacy artifact chunks requiring source store: ${inspection.legacyChunks}`,
    ],
  }];
};

const summarizeActions = (actions: RepairAction[]) => ({
  planned: actions.filter((action) => action.status === "planned").length,
  executed: actions.filter((action) => action.status === "executed").length,
  blocked: actions.filter((action) => action.status === "blocked").length,
  failed: actions.filter((action) => action.status === "failed").length,
  skipped: actions.filter((action) => action.status === "skipped").length,
});

const executeAction = async (cwd: string, action: RepairAction): Promise<RepairAction> => {
  if (action.action === "ingest-recover") {
    const args = splitActionArgs(action);
    const transactionIndex = args.indexOf("--transaction");
    const transactionId = transactionIndex >= 0 ? args[transactionIndex + 1] : undefined;
    if (!transactionId) {
      return {
        ...action,
        status: "failed",
        notes: [...action.notes, "missing ingest transaction reference"],
      };
    }
    await finalizeIngestTransaction(cwd, transactionId);
    return {
      ...action,
      status: "executed",
    };
  }

  if (action.action === "ingest") {
    const args = splitActionArgs(action);
    const pathValues: string[] = [];
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === "--path") {
        pathValues.push(args[index + 1] ?? "");
        index += 1;
      }
    }
    const all = args.includes("--all");
    const scopeIndex = args.indexOf("--scope");
    const scope = scopeIndex >= 0 ? (args[scopeIndex + 1] as "durable" | "all" | undefined) : undefined;
    await runIngest(cwd, {
      all,
      paths: pathValues.length > 0 ? pathValues : undefined,
      scope: scope ?? "durable",
    });
    return {
      ...action,
      status: "executed",
    };
  }

  if (action.action === "harness-verify") {
    const args = splitActionArgs(action);
    const suiteIndex = args.indexOf("--suite");
    const suiteRef = suiteIndex >= 0 ? args[suiteIndex + 1] : undefined;
    if (!suiteRef) {
      return {
        ...action,
        status: "failed",
        notes: [...action.notes, "missing suite reference for harness verify"],
      };
    }
    const result = await verifyHarness(cwd, suiteRef);
    if (result.hasFailure) {
      return {
        ...action,
        status: "failed",
        notes: [...action.notes, `harness verify reported ${result.checks.filter((check) => !check.ok).length} failing checks`],
      };
    }
    return {
      ...action,
      status: "executed",
    };
  }

  return {
    ...action,
    status: "skipped",
  };
};

export const runRepair = async (
  cwd: string,
  options: RepairOptions = {},
  dependencies: RepairDependencies = {},
): Promise<RepairResult> => {
  const drift = await runDrift(cwd, {
    scope: options.scope,
    path: options.path,
    goalId: options.goalId,
    sessionId: options.sessionId,
    maxCount: options.maxCount,
  });

  const warnings: string[] = [];
  const actionFilters = options.actions ?? [];
  const plannedActions = withIds(sortActions([
    ...buildRepairPlan(drift, actionFilters).map(({ actionId: _actionId, ...action }) => action),
    ...await buildIngestRecoveryPlan(cwd, actionFilters),
    ...await buildStoreRebuildPlan(cwd, actionFilters),
  ]));
  const executedActions: RepairAction[] = [];
  const skippedActions: RepairAction[] = [];

  if (options.apply) {
    const storeRebuildActions = plannedActions.filter(
      (action) => action.action === "store-rebuild" && action.status === "planned" && action.safeToApply && !action.requiresInput,
    );
    if (storeRebuildActions.length > 0) {
      const rebuilt = await withStoreWriteLock(cwd, { command: "store-rebuild" }, async () => {
        const results: RepairAction[] = [];
        for (const action of storeRebuildActions) {
          await rebuildStoreFromManifests(cwd);
          results.push({ ...action, status: "executed" });
        }
        return results;
      });
      executedActions.push(...rebuilt);
    }
    const recoveryActions = plannedActions.filter(
      (action) => action.action === "ingest-recover" && action.status === "planned" && action.safeToApply && !action.requiresInput,
    );
    if (recoveryActions.length > 0) {
      await dependencies.beforeIngestRecoveryLock?.();
      const recovered = await withStoreWriteLock(cwd, { command: "ingest-recover" }, async () => {
        const results: RepairAction[] = [];
        for (const action of recoveryActions) {
          const current = await scanIngestTransactions(cwd);
          const transaction = current.transactions.find((entry) => entry.transactionId === action.sourceItemId);
          if (transaction?.classification !== "finalization-pending") {
            results.push({
              ...action,
              status: "skipped",
              notes: [...action.notes, `transaction is no longer recoverable (${transaction?.classification ?? "missing"})`],
            });
            continue;
          }
          try {
            const executed = await executeAction(cwd, action);
            if (executed.status === "failed") {
              warnings.push(`${executed.commandPath} 실행이 실패했습니다: ${executed.sourceItemId}`);
            }
            results.push(executed);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            warnings.push(`${action.commandPath} 실행이 실패했습니다: ${message}`);
            results.push({
              ...action,
              status: "failed",
              notes: [...action.notes, message],
            });
          }
        }
        return results;
      });
      executedActions.push(...recovered.filter((action) => action.status !== "skipped"));
      skippedActions.push(...recovered.filter((action) => action.status === "skipped"));
    }
    for (const action of plannedActions) {
      if (action.action === "ingest-recover" || action.action === "store-rebuild") continue;
      if (action.status !== "planned" || !action.safeToApply || action.requiresInput) {
        skippedActions.push(action);
        continue;
      }
      try {
        const executed = await executeAction(cwd, action);
        if (executed.status === "failed") {
          warnings.push(`${executed.commandPath} 실행이 실패했습니다: ${executed.sourceItemId}`);
        }
        executedActions.push(executed);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`${action.commandPath} 실행이 실패했습니다: ${message}`);
        executedActions.push({
          ...action,
          status: "failed",
          notes: [...action.notes, message],
        });
      }
    }
  } else {
    skippedActions.push(...plannedActions.filter((action) => action.status === "blocked" || action.status === "skipped"));
  }

  const actionsById = new Map<string, RepairAction>();
  for (const action of plannedActions) actionsById.set(action.actionId, action);
  for (const action of executedActions) actionsById.set(action.actionId, action);
  for (const action of skippedActions) actionsById.set(action.actionId, action);

  const finalPlan = plannedActions.map((action) => actionsById.get(action.actionId) ?? action);
  const summary = summarizeActions(finalPlan);

  return {
    mode: options.apply ? "apply" : "plan",
    summary,
    filters: {
      scope: options.scope ?? "all",
      path: options.path ?? null,
      goalId: options.goalId ?? null,
      sessionId: options.sessionId ?? null,
      maxCount: options.maxCount ?? null,
      actions: options.actions ?? [],
    },
    drift,
    plannedActions: finalPlan,
    executedActions,
    skippedActions: options.apply ? skippedActions : finalPlan.filter((action) => action.status === "blocked" || action.status === "skipped"),
    warnings,
  };
};

const formatActions = (actions: RepairAction[], view: CliView): string[] => {
  if (actions.length === 0) return ["- no repair actions"];
  if (view === "minimal") {
    return actions.map(
      (action) =>
        `- ${action.status} ${action.action} from ${action.sourceScope}/${action.sourceItemId} (reasons=${action.reasonCodes.join(",") || "none"})`,
    );
  }
  return actions.flatMap((action) => {
    const lines = [
      `- ${action.status.toUpperCase()} ${action.action}: ${action.commandPath} ${action.args.join(" ")}`.trimEnd(),
      `  source: ${action.sourceScope}/${action.sourceItemId}`,
      `  reasons: ${action.reasonCodes.join(", ") || "none"}`,
      `  safe_to_apply: ${action.safeToApply}`,
      `  requires_input: ${action.requiresInput}`,
    ];
    if (view === "full" && action.notes.length > 0) {
      lines.push(`  notes: ${action.notes.join(" | ")}`);
    }
    return lines;
  });
};

export const formatRepairText = (result: RepairResult, view: CliView): string =>
  [
    "# ragit repair",
    `- mode: ${result.mode}`,
    `- overall_drift: ${result.drift.overallStatus}`,
    `- planned: ${result.summary.planned}`,
    `- executed: ${result.summary.executed}`,
    `- blocked: ${result.summary.blocked}`,
    `- failed: ${result.summary.failed}`,
    `- skipped: ${result.summary.skipped}`,
    `- action_filters: ${result.filters.actions.length > 0 ? result.filters.actions.join(", ") : "all"}`,
    "",
    "## Actions",
    ...formatActions(result.plannedActions, view),
  ].join("\n");
