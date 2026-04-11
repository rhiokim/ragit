import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveRagitPaths } from "./project.js";
import {
  buildNarrativeViewModel,
  NarrativeEventItem,
  NarrativeIntentItem,
  NarrativeOptions,
  NarrativeResult,
  NarrativeViewModel,
} from "./narrative-model.js";

export type {
  NarrativeBuildResult,
  NarrativeChangeType,
  NarrativeDecisionNode,
  NarrativeDecisionThread,
  NarrativeEventItem,
  NarrativeIntentItem,
  NarrativeOptions,
  NarrativeRelationKind,
  NarrativeResult,
  NarrativeSummary,
  NarrativeViewModel,
  NarrativeWindowSummary,
} from "./narrative-model.js";
export { buildNarrativeViewModel } from "./narrative-model.js";

const shortSha = (value: string): string => value.slice(0, 7);

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const serializeForScript = (value: unknown): string =>
  JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");

const renderDecisionSection = (viewModel: NarrativeViewModel): string => {
  if (viewModel.empty || viewModel.threads.length === 0 || viewModel.snapshots.length === 0) {
    return `
      <div class="empty-state">
        <p>Selected window에 indexed snapshot 또는 decision doc가 없습니다.</p>
        <p>먼저 <code>ragit ingest</code>로 snapshot을 만들고, 필요하면 reviewed/promoted memory를 쌓으십시오.</p>
      </div>
    `;
  }

  const headerCells = viewModel.snapshots
    .map(
      (snapshot) => `
        <div class="snapshot-header-cell">
          <div class="snapshot-sha">${escapeHtml(snapshot.shortSha)}</div>
          <div class="snapshot-date">${escapeHtml(snapshot.authoredAt.slice(0, 10))}</div>
          <div class="snapshot-subject">${escapeHtml(snapshot.subject)}</div>
        </div>
      `,
    )
    .join("");

  const rows = viewModel.threads
    .map((thread) => {
      const cells = viewModel.snapshots
        .map((snapshot) => {
          const nodes = viewModel.nodes.filter((node) => node.threadId === thread.threadId && node.commitSha === snapshot.commitSha);
          return `
            <div class="thread-cell">
              ${nodes
                .map(
                  (node) => `
                    <button
                      type="button"
                      class="node-chip node-${escapeHtml(node.changeType)}"
                      data-thread-focus="${escapeHtml(thread.threadId)}"
                      data-thread-ref="${escapeHtml(thread.threadId)}"
                      data-detail='${escapeHtml(
                        JSON.stringify({
                          type: "decision",
                          title: node.title,
                          summary: node.summary,
                          path: node.path,
                          artifactId: node.sourceArtifactId,
                          snapshotSha: node.commitSha,
                          relationKind: node.relationKind,
                          confidence: node.confidence,
                          changeType: node.changeType,
                        }),
                      )}'
                    >
                      <span class="node-badge">${escapeHtml(node.changeType)}</span>
                      <span class="node-title">${escapeHtml(node.title)}</span>
                      <span class="node-meta">${escapeHtml(node.relationKind)}</span>
                    </button>
                  `,
                )
                .join("")}
            </div>
          `;
        })
        .join("");
      const labelDetail = escapeHtml(
        JSON.stringify({
          type: "thread",
          title: thread.title,
          summary: `${thread.docType} thread across ${thread.snapshotShas.length} snapshot(s)`,
          path: thread.docPaths.join(", "),
          artifactId: null,
          snapshotSha: thread.snapshotShas.at(-1) ?? null,
          relationKind: "thread",
          confidence: null,
          changeType: null,
        }),
      );
      return `
        <div class="thread-row" style="grid-template-columns: 220px repeat(${viewModel.snapshots.length}, minmax(160px, 1fr));">
          <button
            type="button"
            class="thread-label"
            data-thread-focus="${escapeHtml(thread.threadId)}"
            data-thread-ref="${escapeHtml(thread.threadId)}"
            data-detail='${labelDetail}'
          >
            <span class="thread-title">${escapeHtml(thread.title)}</span>
            <span class="thread-meta">${escapeHtml(thread.docType)} · ${thread.nodeIds.length} node(s)</span>
          </button>
          ${cells}
        </div>
      `;
    })
    .join("");

  return `
    <div class="decision-grid" style="grid-template-columns: 220px repeat(${viewModel.snapshots.length}, minmax(160px, 1fr));">
      <div class="snapshot-header-spacer"></div>
      ${headerCells}
    </div>
    <div class="decision-rows">
      ${rows}
    </div>
  `;
};

const renderIntentSection = (items: NarrativeIntentItem[], title: string): string => {
  if (items.length === 0) {
    return `<div class="empty-state"><p>No ${escapeHtml(title.toLowerCase())} in the selected window.</p></div>`;
  }
  return items
    .map((item) => {
      const detail = escapeHtml(
        JSON.stringify({
          type: "intent",
          title: item.title,
          summary: item.summary,
          path: item.relatedPaths.join(", "),
          artifactId: item.artifactId,
          snapshotSha: item.anchorSha,
          relationKind: item.kind,
          confidence: null,
          changeType: item.status,
        }),
      );
      return `
        <article
          class="intent-item"
          data-thread-refs="${escapeHtml(item.threadIds.join(" "))}"
        >
          <button
            type="button"
            class="intent-button"
            data-thread-focus="${escapeHtml(item.threadIds[0] ?? "")}"
            data-detail='${detail}'
          >
            <span class="intent-kind">${escapeHtml(item.kind)}</span>
            <span class="intent-title">${escapeHtml(item.title)}</span>
            <span class="intent-summary">${escapeHtml(item.summary)}</span>
          </button>
        </article>
      `;
    })
    .join("");
};

const renderTimelineSection = (events: NarrativeEventItem[]): string => {
  if (events.length === 0) {
    return `<div class="empty-state"><p>No operational events matched the selected snapshot window.</p></div>`;
  }
  return events
    .map((event) => {
      const detail = escapeHtml(
        JSON.stringify({
          type: "event",
          title: event.eventType,
          summary: event.summary,
          path: event.relatedPaths.join(", "),
          artifactId: null,
          snapshotSha: event.sourceHeadSha,
          relationKind: "event",
          confidence: null,
          changeType: null,
        }),
      );
      return `
        <article class="timeline-item" data-thread-refs="${escapeHtml(event.threadIds.join(" "))}">
          <button
            type="button"
            class="timeline-button"
            data-thread-focus="${escapeHtml(event.threadIds[0] ?? "")}"
            data-detail='${detail}'
          >
            <span class="timeline-date">${escapeHtml(event.recordedAt)}</span>
            <span class="timeline-type">${escapeHtml(event.eventType)}</span>
            <span class="timeline-summary">${escapeHtml(event.summary)}</span>
          </button>
        </article>
      `;
    })
    .join("");
};

export const renderNarrativeReport = (viewModel: NarrativeViewModel): string => `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(viewModel.repoName)} narrative report</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f5f1e8;
        --panel: #fffaf2;
        --ink: #1d1a16;
        --muted: #6b655c;
        --line: #d9d0c3;
        --accent: #0e6b50;
        --added: #d7f5e8;
        --modified: #fff2cc;
        --deleted: #f9d6d2;
        --related: #dfe9ff;
        --active: #143d59;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: linear-gradient(180deg, #f8f5ee 0%, var(--bg) 100%);
        color: var(--ink);
      }
      main {
        max-width: 1440px;
        margin: 0 auto;
        padding: 32px 24px 48px;
      }
      h1, h2, h3, p { margin: 0; }
      .report-header {
        display: flex;
        justify-content: space-between;
        gap: 24px;
        align-items: end;
        margin-bottom: 24px;
      }
      .report-subtitle {
        color: var(--muted);
        margin-top: 8px;
        line-height: 1.5;
      }
      .legend {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
        color: var(--muted);
        font-size: 13px;
      }
      .legend span::before {
        content: "";
        display: inline-block;
        width: 10px;
        height: 10px;
        border-radius: 999px;
        margin-right: 6px;
        vertical-align: middle;
      }
      .legend-added::before { background: #54b67d; }
      .legend-modified::before { background: #d3a628; }
      .legend-deleted::before { background: #c45d4a; }
      .legend-related::before { background: #4869d2; }
      section {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 20px;
        padding: 20px;
        box-shadow: 0 10px 30px rgba(29, 26, 22, 0.05);
      }
      .summary-grid, .content-grid {
        display: grid;
        gap: 18px;
      }
      .summary-grid {
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        margin-bottom: 18px;
      }
      .summary-card {
        padding: 16px;
        border-radius: 16px;
        background: rgba(255, 255, 255, 0.6);
        border: 1px solid var(--line);
      }
      .summary-label {
        color: var(--muted);
        font-size: 13px;
        margin-bottom: 8px;
      }
      .summary-value {
        font-size: 28px;
        font-weight: 700;
      }
      .content-grid {
        grid-template-columns: minmax(0, 2fr) minmax(320px, 1fr);
        align-items: start;
      }
      .stack {
        display: grid;
        gap: 18px;
      }
      .decision-grid, .thread-row {
        display: grid;
        gap: 12px;
      }
      .decision-grid {
        margin-top: 16px;
        margin-bottom: 12px;
      }
      .snapshot-header-cell, .thread-cell, .thread-label {
        border: 1px solid var(--line);
        border-radius: 14px;
        min-height: 88px;
        background: rgba(255,255,255,0.75);
      }
      .snapshot-header-cell {
        padding: 12px;
      }
      .snapshot-sha {
        font-weight: 700;
      }
      .snapshot-date, .snapshot-subject, .thread-meta, .intent-kind, .timeline-type, .detail-meta {
        color: var(--muted);
        font-size: 12px;
      }
      .snapshot-subject {
        margin-top: 8px;
        line-height: 1.45;
      }
      .decision-rows {
        display: grid;
        gap: 12px;
      }
      .thread-label, .node-chip, .intent-button, .timeline-button {
        width: 100%;
        appearance: none;
        border: 0;
        background: transparent;
        text-align: left;
        cursor: pointer;
        color: inherit;
      }
      .thread-label {
        padding: 14px;
        display: grid;
        gap: 8px;
      }
      .thread-title {
        font-weight: 700;
      }
      .thread-cell {
        padding: 10px;
        display: grid;
        gap: 8px;
        align-content: start;
      }
      .node-chip {
        padding: 10px 12px;
        border-radius: 12px;
        display: grid;
        gap: 6px;
        border: 1px solid rgba(20, 61, 89, 0.08);
      }
      .node-added { background: var(--added); }
      .node-modified { background: var(--modified); }
      .node-deleted { background: var(--deleted); }
      .node-related { background: var(--related); }
      .node-badge {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--muted);
      }
      .node-title, .intent-title {
        font-weight: 700;
      }
      .node-meta, .intent-summary, .timeline-summary {
        font-size: 13px;
        line-height: 1.45;
        color: #3f392f;
      }
      .intent-group + .intent-group {
        margin-top: 16px;
      }
      .intent-list, .timeline-list {
        display: grid;
        gap: 10px;
        margin-top: 12px;
      }
      .intent-item, .timeline-item {
        border: 1px solid var(--line);
        border-radius: 14px;
        background: rgba(255,255,255,0.72);
      }
      .intent-button, .timeline-button {
        padding: 14px;
        display: grid;
        gap: 6px;
      }
      .detail-card {
        margin-top: 16px;
        padding: 16px;
        border: 1px dashed var(--line);
        border-radius: 16px;
        background: rgba(255,255,255,0.66);
        display: grid;
        gap: 10px;
      }
      .detail-title {
        font-weight: 700;
      }
      .detail-summary {
        line-height: 1.55;
      }
      .detail-list {
        display: grid;
        gap: 6px;
        font-size: 13px;
      }
      .empty-state {
        border: 1px dashed var(--line);
        border-radius: 16px;
        padding: 18px;
        color: var(--muted);
        line-height: 1.6;
      }
      .is-active {
        outline: 2px solid var(--active);
        outline-offset: 2px;
      }
      .is-muted {
        opacity: 0.3;
      }
      @media (max-width: 1100px) {
        .content-grid {
          grid-template-columns: 1fr;
        }
      }
      @media (max-width: 760px) {
        main {
          padding: 20px 14px 32px;
        }
        .report-header {
          display: grid;
          align-items: start;
        }
        .decision-grid, .thread-row {
          overflow-x: auto;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <header class="report-header">
        <div>
          <h1>${escapeHtml(viewModel.repoName)} narrative report</h1>
          <p class="report-subtitle">
            프로젝트의 결정 변화사, 의도, 운영 시간축을 같은 창에서 읽도록 합성한 self-contained report입니다.
          </p>
        </div>
        <div class="legend">
          <span class="legend-added">added</span>
          <span class="legend-modified">modified</span>
          <span class="legend-deleted">deleted</span>
          <span class="legend-related">related</span>
        </div>
      </header>

      <section id="report-summary">
        <div class="summary-grid">
          <div class="summary-card"><div class="summary-label">Head</div><div class="summary-value">${escapeHtml(shortSha(viewModel.headSha))}</div></div>
          <div class="summary-card"><div class="summary-label">Selected Snapshots</div><div class="summary-value">${viewModel.window.selectedSnapshotShas.length}</div></div>
          <div class="summary-card"><div class="summary-label">Decision Threads</div><div class="summary-value">${viewModel.summary.decisionThreads}</div></div>
          <div class="summary-card"><div class="summary-label">Intent Items</div><div class="summary-value">${viewModel.summary.intentItems}</div></div>
          <div class="summary-card"><div class="summary-label">Timeline Events</div><div class="summary-value">${viewModel.summary.timelineEvents}</div></div>
          <div class="summary-card"><div class="summary-label">Missing Snapshot Commits</div><div class="summary-value">${viewModel.window.missingSnapshotCommits}</div></div>
        </div>
        <div class="detail-list">
          <div><strong>Window</strong>: ${escapeHtml(viewModel.window.revRange ?? "HEAD")} · max ${viewModel.window.maxCommits} selected snapshot commit(s)</div>
          <div><strong>Generated at</strong>: ${escapeHtml(viewModel.generatedAt)}</div>
          <div><strong>Warnings</strong>: ${viewModel.warnings.length === 0 ? "none" : escapeHtml(viewModel.warnings.join(" | "))}</div>
        </div>
      </section>

      <div class="content-grid" style="margin-top: 18px;">
        <section id="decision-evolution">
          <h2>Decision Evolution</h2>
          ${renderDecisionSection(viewModel)}
        </section>

        <div class="stack">
          <section id="intent-panel">
            <h2>Intent Panel</h2>
            <div class="intent-group">
              <h3>Assigned</h3>
              <div class="intent-list">${renderIntentSection(viewModel.intentItems, "Assigned intent items")}</div>
            </div>
            <div class="intent-group">
              <h3>Unassigned</h3>
              <div class="intent-list">${renderIntentSection(viewModel.unassignedIntentItems, "Unassigned intent items")}</div>
            </div>
            <div id="detail-card" class="detail-card">
              <div class="detail-title">Detail</div>
              <div class="detail-summary">노드, intent, timeline event를 클릭하면 결속 정보와 근거 메타데이터를 여기서 보여 줍니다.</div>
            </div>
          </section>

          <section id="operational-timeline">
            <h2>Operational Timeline</h2>
            <div class="timeline-list">${renderTimelineSection(viewModel.timelineEvents)}</div>
          </section>
        </div>
      </div>
    </main>
    <script id="narrative-data" type="application/json">${serializeForScript(viewModel)}</script>
    <script>
      const activeClass = "is-active";
      const mutedClass = "is-muted";
      const detailCard = document.getElementById("detail-card");
      const renderDetail = (payload) => {
        if (!detailCard) return;
        if (!payload) {
          detailCard.innerHTML = '<div class="detail-title">Detail</div><div class="detail-summary">선택된 항목이 없습니다.</div>';
          return;
        }
        const rows = [
          ["Path", payload.path || "none"],
          ["Artifact", payload.artifactId || "none"],
          ["Snapshot", payload.snapshotSha || "none"],
          ["Relation", payload.relationKind || "none"],
          ["Confidence", payload.confidence === null || payload.confidence === undefined ? "none" : String(payload.confidence)],
        ];
        detailCard.innerHTML = [
          '<div class="detail-title">' + (payload.title || 'Detail') + '</div>',
          '<div class="detail-summary">' + (payload.summary || '') + '</div>',
          '<div class="detail-list">' + rows.map(([label, value]) => '<div><span class="detail-meta">' + label + '</span>: ' + value + '</div>').join("") + '</div>',
        ].join("");
      };

      const syncThreadFocus = (threadId) => {
        const threadRefs = document.querySelectorAll("[data-thread-ref], [data-thread-refs]");
        if (!threadId) {
          threadRefs.forEach((element) => {
            element.classList.remove(activeClass);
            element.classList.remove(mutedClass);
          });
          return;
        }
        threadRefs.forEach((element) => {
          const refs = ((element.getAttribute("data-thread-ref") || "") + " " + (element.getAttribute("data-thread-refs") || "")).trim().split(/\\s+/).filter(Boolean);
          const matches = refs.includes(threadId);
          element.classList.toggle(activeClass, matches);
          element.classList.toggle(mutedClass, refs.length > 0 && !matches);
        });
      };

      document.querySelectorAll("[data-thread-focus]").forEach((element) => {
        element.addEventListener("click", () => {
          const threadId = element.getAttribute("data-thread-focus") || "";
          const detailRaw = element.getAttribute("data-detail");
          let detail = null;
          if (detailRaw) {
            try {
              detail = JSON.parse(detailRaw);
            } catch {}
          }
          syncThreadFocus(threadId || null);
          renderDetail(detail);
        });
      });
    </script>
  </body>
</html>`;

export const runNarrativeReport = async (cwd: string, options: NarrativeOptions = {}): Promise<NarrativeResult> => {
  const paths = resolveRagitPaths(cwd);
  const built = await buildNarrativeViewModel(cwd, options);
  if (!options.dryRun) {
    await mkdir(path.dirname(built.absoluteReportPath), { recursive: true });
    await writeFile(built.absoluteReportPath, renderNarrativeReport(built.viewModel), "utf8");
  }
  if (!options.output && built.result.reportPath.startsWith(".ragit/")) {
    await mkdir(paths.narrativeReportsDir, { recursive: true });
  }
  return built.result;
};

export const formatNarrativeText = (result: NarrativeResult): string =>
  [
    "# ragit narrative",
    `- dry_run: ${result.dryRun}`,
    `- report_path: ${result.reportPath}`,
    `- head: ${result.headSha}`,
    `- window_rev_range: ${result.window.revRange ?? "HEAD"}`,
    `- selected_snapshots: ${result.window.selectedSnapshotShas.length}`,
    `- missing_snapshot_commits: ${result.window.missingSnapshotCommits}`,
    `- decision_threads: ${result.summary.decisionThreads}`,
    `- decision_nodes: ${result.summary.decisionNodes}`,
    `- intent_items: ${result.summary.intentItems}`,
    `- timeline_events: ${result.summary.timelineEvents}`,
    `- heuristic_edges: ${result.summary.heuristicEdges}`,
    ...(result.warnings.length === 0 ? [] : ["", ...result.warnings.map((warning) => `- warning ${warning}`)]),
  ].join("\n");
