# Retrieval Quality Evaluation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an offline, versioned retrieval benchmark that evaluates 108 bilingual/noisy queries across three fixture repositories and reports reproducible ranking, robustness, and latency metrics.

**Architecture:** A pure core module validates the benchmark schema, expands cases, computes metrics, builds stable reports, and evaluates thresholds. A standalone script materializes fixture repositories and calls the existing init, ingest, and retrieval APIs without duplicating production ranking logic. The fixture profile remains the current placeholder and every report labels it development-only.

**Tech Stack:** TypeScript 5.9, Node.js 20.19+, Vitest 4, Git CLI, existing RAGit init/ingest/retrieval APIs, zvec, JSON fixtures.

## Global Constraints

- B1 must not modify production ranking, score weights, query output, Context Pack selection, embedding providers, or MCP behavior.
- The dataset must expand to exactly 108 cases: 3 repositories × 12 topics × 3 variants.
- Variants are exactly `en`, `ko`, and `mixed-noisy`; every topic has all three.
- Relevance gains are integers 1, 2, or 3 and every judged path exists in the same repository.
- Benchmark stdout is one JSON object on success; progress goes to stderr.
- Placeholder reports set `developmentOnly: true` and cannot be described as production evidence.
- No external network or provider is required by tests or the benchmark default.
- Temporary repositories are removed on success and failure.
- Manifest selection remains exact and query latency excludes repository setup and ingest.

---

## File Map

- Create `src/core/retrieval-evaluation.ts`: dataset types and validation, case expansion, pure metrics, report aggregation, threshold validation.
- Create `test/retrieval-evaluation.test.ts`: hand-calculated unit tests and complete dataset integrity tests.
- Create `benchmarks/retrieval/v1/dataset.json`: three fixture repositories, 36 topics, 108 expanded cases.
- Create `benchmarks/retrieval/v1/thresholds.json`: explicit placeholder regression floors and ceilings derived from two successful runs.
- Create `scripts/benchmark-retrieval.ts`: temporary Git repository lifecycle and end-to-end benchmark orchestration.
- Modify `package.json`: add `benchmark:retrieval` and `benchmark:retrieval:verify` scripts.
- Modify `README.md`: document how to run and interpret the development-only benchmark.

### Task 1: Pure dataset and metric contracts

**Files:**
- Create: `src/core/retrieval-evaluation.ts`
- Create: `test/retrieval-evaluation.test.ts`

**Interfaces:**
- Produces: `parseRetrievalBenchmarkDataset(value: unknown): RetrievalBenchmarkDataset`
- Produces: `expandRetrievalBenchmarkCases(dataset: RetrievalBenchmarkDataset): ExpandedRetrievalBenchmarkCase[]`
- Produces: `evaluateRetrievalRanking(judgments: RetrievalBenchmarkJudgment[], rankedPaths: string[], k: number): RetrievalRankingMetrics`
- Produces: `nearestRankPercentile(values: number[], percentile: number): number`
- Produces: `buildRetrievalBenchmarkReport(input: RetrievalBenchmarkReportInput): RetrievalBenchmarkReport`
- Produces: `parseRetrievalBenchmarkThresholds(value: unknown): RetrievalBenchmarkThresholds`
- Produces: `findRetrievalBenchmarkThresholdViolations(report, thresholds): string[]`

- [ ] **Step 1: Write failing validation and expansion tests**

Add fixtures in `test/retrieval-evaluation.test.ts` that assert a minimal valid three-repository dataset expands in stable repository/topic/variant order. Add separate failures for duplicate repository IDs, duplicate document paths, missing variants, invalid gains, missing judged paths, fewer than three repositories, and fewer than 100 expanded cases.

Use these exact public variants and case ID format:

```ts
export type RetrievalBenchmarkVariant = "en" | "ko" | "mixed-noisy";

const variantOrder: RetrievalBenchmarkVariant[] = ["en", "ko", "mixed-noisy"];

const caseId = `${repository.id}/${topic.id}/${variant}`;
```

- [ ] **Step 2: Run validation tests and confirm failure**

Run:

```bash
pnpm exec vitest run test/retrieval-evaluation.test.ts
```

Expected: FAIL because `src/core/retrieval-evaluation.ts` does not exist.

- [ ] **Step 3: Implement strict schema validation and stable expansion**

Define these data shapes and validate unknown JSON without adding a schema dependency:

```ts
export interface RetrievalBenchmarkDocument {
  path: string;
  content: string;
}

export interface RetrievalBenchmarkJudgment {
  path: string;
  gain: 1 | 2 | 3;
}

export interface RetrievalBenchmarkTopic {
  id: string;
  queries: Record<RetrievalBenchmarkVariant, string>;
  judgments: RetrievalBenchmarkJudgment[];
}

export interface RetrievalBenchmarkRepository {
  id: string;
  description: string;
  documents: RetrievalBenchmarkDocument[];
  topics: RetrievalBenchmarkTopic[];
}

export interface RetrievalBenchmarkDataset {
  schemaVersion: 1;
  datasetId: string;
  repositories: RetrievalBenchmarkRepository[];
}

export interface ExpandedRetrievalBenchmarkCase {
  caseId: string;
  repositoryId: string;
  topicId: string;
  variant: RetrievalBenchmarkVariant;
  query: string;
  judgments: RetrievalBenchmarkJudgment[];
}
```

Reject non-record roots, unknown schema versions, blank strings, duplicate IDs/paths, duplicate judgments, invalid gains, missing variants, nonexistent judged paths, fewer than 3 repositories, and fewer than 100 expanded cases. Sort only the expanded output; preserve the validated dataset order itself.

- [ ] **Step 4: Write failing metric tests with hand-calculated expectations**

Cover the following exact ranking:

```ts
const judgments = [
  { path: "docs/a.md", gain: 3 as const },
  { path: "docs/b.md", gain: 1 as const },
];
const ranked = ["docs/noise.md", "docs/a.md", "docs/a.md", "docs/b.md"];
```

After path deduplication, at `k = 3` expect recall `1`, MRR `0.5`, and nDCG equal to DCG gains at ranks 2 and 3 divided by ideal gains at ranks 1 and 2. Also test no hits, only one relevant hit, empty latency input rejection, and nearest-rank p50/p95 for `[1, 2, 3, 4, 100]` as `3` and `100`.

- [ ] **Step 5: Implement metrics, slices, noise pairing, and thresholds**

Use unique ranked paths in first-seen order. Implement DCG with `((2 ** gain) - 1) / Math.log2(rank + 1)`. The per-K helper returns:

```ts
export interface RetrievalRankingMetrics {
  recall: number;
  mrr: number;
  ndcg: number;
}
```

Build fixed report case metrics by calling it at K 1, 5, and 10:

```ts
export interface RetrievalCaseMetrics {
  recallAt1: number;
  recallAt5: number;
  recallAt10: number;
  mrrAt10: number;
  ndcgAt10: number;
}
```

Define observations and report inputs as:

```ts
export interface RetrievalBenchmarkObservation {
  case: ExpandedRetrievalBenchmarkCase;
  rankedPaths: string[];
  latencyMs: number;
}

export interface RetrievalBenchmarkReportInput {
  dataset: RetrievalBenchmarkDataset;
  observations: RetrievalBenchmarkObservation[];
  profile: {
    provider: string;
    model: string;
    dimensions: number;
    version: string;
    developmentOnly: boolean;
  };
  generatedAt: string;
}
```

The report must contain counts, aggregate metrics, `byRepository`, `byVariant`, paired noise summary, nearest-rank latency, and ordered per-case results. Require exactly one observation for every expanded case and reject duplicate or unknown case IDs. Macro-average cases. Pair noise by repository/topic; clean nDCG is the mean of `en` and `ko`, then compare it with `mixed-noisy`. Define relative noise drop as `cleanMean === 0 ? 0 : Math.max(0, (cleanMean - noisyMean) / cleanMean)`.

Threshold JSON uses:

```ts
export interface RetrievalBenchmarkThresholds {
  schemaVersion: 1;
  datasetId: string;
  profile: string;
  minimum: {
    recallAt5: number;
    mrrAt10: number;
    ndcgAt10: number;
  };
  maximum: {
    relativeNoiseDrop: number;
    p95LatencyMs: number;
  };
}
```

Return one stable violation string per failed key and reject thresholds outside `[0, 1]`, except positive latency.

- [ ] **Step 6: Run unit tests and commit Task 1**

Run:

```bash
pnpm exec vitest run test/retrieval-evaluation.test.ts
pnpm build
git diff --check
```

Expected: all pass.

Commit:

```bash
git add src/core/retrieval-evaluation.ts test/retrieval-evaluation.test.ts
git commit -m "feat(retrieval): add evaluation metrics"
```

### Task 2: Versioned three-repository corpus

**Files:**
- Create: `benchmarks/retrieval/v1/dataset.json`
- Modify: `test/retrieval-evaluation.test.ts`

**Interfaces:**
- Consumes: `parseRetrievalBenchmarkDataset` and `expandRetrievalBenchmarkCases` from Task 1.
- Produces: dataset ID `ragit-retrieval-v1` with exactly 108 expanded cases.

- [ ] **Step 1: Add the complete dataset and integrity test**

Create three repositories with the exact IDs and twelve primary topic paths below. Every document starts with `---\ntype: spec\n---`, contains an H1, and includes a concise English explanation, a concise Korean explanation, one operational constraint, and one deliberately overlapping term from another document so retrieval is not solved by a unique keyword alone. The valid frontmatter is mandatory because production ingest skips unknown document types.

`agent-cli` topics:

| Topic ID | Primary path | English intent | Korean intent | Mixed-noisy query cue |
| --- | --- | --- | --- | --- |
| snapshot-selection | `docs/snapshot-selection.md` | exact commit snapshot lookup | 정확한 커밋 스냅샷 선택 | `HEAD exact 스냅샷 pls unrelated branch 말고` |
| writer-lock | `docs/writer-lock.md` | exclusive store writer lock | 저장소 단일 writer 잠금 | `동시 ingest race writer lock 어떻게` |
| ingest-journal | `docs/ingest-journal.md` | crash-safe ingest journal | 장애 복구 ingest 저널 | `crash 뒤 ingest journal resume?` |
| store-rebuild | `docs/store-rebuild.md` | rebuild exact manifest union | manifest 합집합 저장소 재구축 | `orphan 제거 rebuild manifest union` |
| embedding-cache | `docs/embedding-cache.md` | provider-aware embedding cache | provider별 임베딩 캐시 | `embedding cache provider 바뀌면 key?` |
| query-ranking | `docs/query-ranking.md` | hybrid vector keyword score | 벡터 키워드 혼합 점수 | `vector + keyword alpha ranking 설명` |
| context-budget | `docs/context-budget.md` | token budget context selection | 토큰 예산 컨텍스트 선택 | `context pack budget 넘치지 않게` |
| secret-masking | `docs/secret-masking.md` | sanitize secrets before persistence | 저장 전 비밀 마스킹 | `API key 저장 전에 mask plz` |
| artifact-binding | `docs/artifact-binding.md` | bind reviewed artifact to commit | 검토 artifact 커밋 바인딩 | `reviewed artifact HEAD bind 언제` |
| repair-action | `docs/repair-action.md` | explicit safe repair action | 명시적 안전 repair 액션 | `repair apply safe action only` |
| package-release | `docs/package-release.md` | pack and publish verification | 패키지 배포 검증 | `npm publish 전에 pack smoke` |
| mcp-readonly | `docs/mcp-readonly.md` | read-only MCP projection | 읽기 전용 MCP 투영 | `MCP tool cache write 하면 안됨` |

`commerce-service` topics:

| Topic ID | Primary path | English intent | Korean intent | Mixed-noisy query cue |
| --- | --- | --- | --- | --- |
| order-state | `docs/order-state.md` | order state transition rules | 주문 상태 전이 규칙 | `order paid shipped 상태 jump 금지` |
| payment-idempotency | `docs/payment-idempotency.md` | idempotent payment requests | 결제 멱등 요청 | `payment retry double charge 방지` |
| inventory-reservation | `docs/inventory-reservation.md` | inventory reservation expiry | 재고 예약 만료 | `stock reserve TTL release 언제` |
| refund-policy | `docs/refund-policy.md` | partial refund eligibility | 부분 환불 자격 | `partial refund 조건 한국어` |
| fraud-review | `docs/fraud-review.md` | manual fraud review threshold | 사기 수동 검토 임계값 | `fraud score 높으면 manual queue` |
| outbox-events | `docs/outbox-events.md` | transactional outbox delivery | 트랜잭션 outbox 전달 | `DB commit event publish atomic?` |
| shipping-sla | `docs/shipping-sla.md` | shipping service-level deadline | 배송 SLA 기한 | `same day 배송 cutoff 몇시` |
| tax-rounding | `docs/tax-rounding.md` | tax rounding order | 세금 반올림 순서 | `tax line vs total rounding` |
| promotion-stack | `docs/promotion-stack.md` | coupon stacking precedence | 쿠폰 중첩 우선순위 | `promo coupon stack conflict` |
| customer-consent | `docs/customer-consent.md` | marketing consent retention | 마케팅 동의 보존 | `consent revoke data keep 기간` |
| incident-replay | `docs/incident-replay.md` | replay failed commerce events | 실패 이벤트 재처리 | `dead letter replay duplicate no` |
| service-observability | `docs/service-observability.md` | checkout traces and SLOs | 체크아웃 추적과 SLO | `checkout latency trace p95 alert` |

`team-operations` topics:

| Topic ID | Primary path | English intent | Korean intent | Mixed-noisy query cue |
| --- | --- | --- | --- | --- |
| quarterly-okr | `docs/quarterly-okr.md` | measurable quarterly outcomes | 측정 가능한 분기 OKR | `Q3 objective key result measurable` |
| incident-severity | `docs/incident-severity.md` | incident severity classification | 장애 심각도 분류 | `SEV1 기준 customer impact` |
| oncall-handoff | `docs/oncall-handoff.md` | on-call shift handoff | 온콜 교대 인수인계 | `oncall handoff open alerts context` |
| release-freeze | `docs/release-freeze.md` | release freeze exceptions | 배포 동결 예외 | `freeze 기간 hotfix 승인 누가` |
| new-hire-onboarding | `docs/new-hire-onboarding.md` | first-week onboarding checklist | 신규 입사 첫 주 체크리스트 | `new hire week1 access mentor` |
| accessibility-review | `docs/accessibility-review.md` | keyboard and screen-reader review | 키보드 스크린리더 검토 | `a11y keyboard focus screen reader` |
| localization-policy | `docs/localization-policy.md` | English source Korean parity | 영문 원본 한글 동기화 | `i18n en source ko parity check` |
| decision-record | `docs/decision-record.md` | architecture decision ownership | 아키텍처 결정 소유권 | `ADR owner rationale consequence` |
| experiment-guardrail | `docs/experiment-guardrail.md` | experiment safety guardrails | 실험 안전 가드레일 | `A/B test stop metric harm` |
| support-escalation | `docs/support-escalation.md` | customer support escalation | 고객 지원 에스컬레이션 | `support ticket engineering escalate` |
| data-retention | `docs/data-retention.md` | operational data retention | 운영 데이터 보존 | `logs retention delete schedule` |
| postmortem-action | `docs/postmortem-action.md` | postmortem action ownership | 회고 액션 소유권 | `postmortem action due owner verify` |

For every row, write distinct `en` and `ko` queries that express the stated intent without copying the title exactly, and use the exact mixed-noisy cue shown. Assign gain 3 to the primary path. Add gain 1 secondary judgments for these pairs only: `writer-lock` → `docs/ingest-journal.md`, `store-rebuild` → `docs/repair-action.md`, `payment-idempotency` → `docs/incident-replay.md`, `outbox-events` → `docs/service-observability.md`, `incident-severity` → `docs/oncall-handoff.md`, and `localization-policy` → `docs/accessibility-review.md`.

The integrity test loads JSON through `readFile`, parses it, and asserts:

```ts
expect(dataset.repositories).toHaveLength(3);
expect(dataset.repositories.every((repository) => repository.documents.length === 12)).toBe(true);
expect(dataset.repositories.every((repository) => repository.topics.length === 12)).toBe(true);
expect(cases).toHaveLength(108);
expect(countByVariant(cases)).toEqual({ en: 36, ko: 36, "mixed-noisy": 36 });
```

- [ ] **Step 2: Run the integrity test and inspect the corpus**

Run:

```bash
pnpm exec vitest run test/retrieval-evaluation.test.ts
git diff --check
```

Expected: PASS, exactly 108 cases, no missing judgment paths.

- [ ] **Step 3: Commit Task 2**

```bash
git add benchmarks/retrieval/v1/dataset.json test/retrieval-evaluation.test.ts
git commit -m "test(retrieval): add bilingual benchmark corpus"
```

### Task 3: End-to-end runner and regression gate

**Files:**
- Create: `scripts/benchmark-retrieval.ts`
- Create: `benchmarks/retrieval/v1/thresholds.json`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `test/retrieval-evaluation.test.ts`

**Interfaces:**
- Consumes: Task 1 dataset, report, and threshold APIs.
- Consumes: `runInit`, `runIngest`, `searchKnowledge`, `loadConfig`, and `resolveEmbeddingProfile` from existing production modules.
- Produces: `pnpm benchmark:retrieval` and `pnpm benchmark:retrieval:verify`.

- [ ] **Step 1: Write runner argument and threshold tests**

Keep argument parsing in exported pure function `parseRetrievalBenchmarkArgs(argv: string[])` from the script. Accept only:

```text
--dataset <path>
--thresholds <path>
--output <path>
--verify
```

Defaults are the committed v1 dataset and thresholds. Reject missing values and unknown flags. Test threshold dataset/profile mismatch and stable ordered violation strings.

Guard script execution so importing the parser in Vitest has no side effects:

```ts
const isEntrypoint = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  await main(process.argv.slice(2));
}
```

- [ ] **Step 2: Implement the runner with production APIs**

For each fixture repository:

```ts
const cwd = await mkdtemp(path.join(os.tmpdir(), `ragit-retrieval-${repository.id}-`));
git(cwd, ["init", "-b", "main"]);
git(cwd, ["config", "user.email", "ragit@example.com"]);
git(cwd, ["config", "user.name", "ragit-retrieval-benchmark"]);
// write validated documents under cwd
git(cwd, ["add", "--", ...documentPaths]);
git(cwd, ["commit", "-m", "seed retrieval benchmark"]);
await runInit(cwd, { nonInteractive: true, quiet: true });
git(cwd, ["add", "-A"]);
git(cwd, ["commit", "-m", "initialize ragit"]);
await runIngest(cwd, { all: true, scope: "durable" });
```

Load the exact HEAD manifest after ingest and assert that all twelve fixture document paths appear in `manifest.docs`. Treat any skipped fixture path as a runner failure before executing queries.

Measure only this call:

```ts
const startedAt = performance.now();
const result = await searchKnowledge(cwd, benchmarkCase.query, { topK: 10 });
const latencyMs = performance.now() - startedAt;
```

Map hits to normalized repository-relative paths. Verify `result.snapshotSha === git(cwd, ["rev-parse", "HEAD"])`. Remove each temporary repository in `finally`.

Load the effective config and profile once per fixture repository. All three profiles must match. Build the report with ISO `generatedAt`; serialize with `JSON.stringify(report)` followed by one newline. Write progress only with `process.stderr.write`. When `--output` is present, create its parent directory and write the exact same serialized bytes.

When `--verify` is present, load thresholds, require matching dataset ID and profile string `${provider}/${model}/${version}`, print the success report, then set a failing exit code and print violations to stderr if any threshold is violated.

- [ ] **Step 3: Add package scripts and README guidance**

Add:

```json
"benchmark:retrieval": "tsx scripts/benchmark-retrieval.ts",
"benchmark:retrieval:verify": "tsx scripts/benchmark-retrieval.ts --verify"
```

README guidance must state that the bundled profile is offline and deterministic, `developmentOnly` means it is regression evidence rather than a production-quality claim, and Ollama/OpenAI evidence follows in B4.

- [ ] **Step 4: Run two baselines and derive explicit thresholds**

Run twice and save reports outside the repository:

```bash
pnpm benchmark:retrieval --output /tmp/ragit-retrieval-run-1.json
pnpm benchmark:retrieval --output /tmp/ragit-retrieval-run-2.json
```

Expected: both reports have 3 repositories, 108 cases, 36 cases per variant, identical ordered `rankedPaths` and quality metrics, and `profile.developmentOnly = true`.

Create `thresholds.json` from the design rule: quality floors no lower than 90% of the lower run, noise ceiling no more than the higher relative drop plus 0.05, and latency ceiling equal to the greater of 250 ms or 1.5 times the higher p95. Round quality/noise values down/up respectively to six decimals and latency up to the next integer.

- [ ] **Step 5: Run the regression gate and all project gates**

Run:

```bash
pnpm benchmark:retrieval:verify
pnpm exec vitest run test/retrieval-evaluation.test.ts test/query.integration.test.ts test/retrieval.test.ts
pnpm test
pnpm build
pnpm build:verify
git diff --check origin/main...HEAD
```

Expected: benchmark gate passes; focused and full tests pass; build contracts pass; no whitespace errors.

- [ ] **Step 6: Confirm B1 scope and commit Task 3**

Run:

```bash
git diff --name-only origin/main...HEAD
git diff -- src/core/retrieval.ts src/core/context.ts src/core/output.ts src/core/embedding.ts
```

Expected: the first command lists only the design/plan, evaluation module/test, benchmark data, runner, package scripts, and README. The second command has no output.

Commit:

```bash
git add scripts/benchmark-retrieval.ts benchmarks/retrieval/v1/thresholds.json package.json README.md test/retrieval-evaluation.test.ts
git commit -m "chore(retrieval): add benchmark regression gate"
```

## Final Review Checklist

- [ ] Dataset parses to exactly 3 repositories, 36 topics, and 108 cases.
- [ ] English, Korean, and mixed-noisy slices each contain exactly 36 cases.
- [ ] Every judgment path exists and gains are 1–3.
- [ ] Metric unit tests match hand calculations and deduplicate ranked paths.
- [ ] Noise pairs are complete and deterministic.
- [ ] Report profile is explicit and placeholder is development-only.
- [ ] Two baseline rankings and quality metrics are identical.
- [ ] Regression thresholds follow the documented margin rule.
- [ ] stdout is one JSON object; progress/errors use stderr.
- [ ] Temporary repositories are always removed.
- [ ] Production ranking and query/context output files are unchanged.
- [ ] Benchmark verify, focused tests, full tests, build, build verify, and diff check pass.
