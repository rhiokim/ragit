---
type: plan
---
# Artifact-Aware Unified Retrieval Layer Implementation Plan

> 대상: `query`, `context pack`, `memory recall`이 서로 다른 조합 로직을 쓰지 않고, 하나의 planner/executor를 통해 동일한 retrieval semantics를 사용하도록 정리한다.

## Summary / Why This Is Next

지금 `ragit`의 retrieval은 이미 여러 곳에서 핵심 경로로 쓰이고 있습니다. 그런데 `query`, `context pack`, `memory recall`이 같은 검색 인프라 위에 있으면서도 실제 의미 조합은 각자 다릅니다. 이 상태에서는 새로운 artifact 종류나 scope가 추가될 때마다 behavior drift가 생기기 쉽고, prompt-facing 결과와 memory-facing 결과가 서로 다른 규칙으로 선별되는 문제가 계속 남습니다.

이 작업이 다음 우선순위인 이유는 세 가지입니다.

1. retrieval은 `query`, `context pack`, `memory recall`의 공통 기반입니다.
2. session/harness/evidence artifact가 이미 존재하지만, 이를 소비하는 방식이 분산되어 있습니다.
3. planner/executor를 한 번 정리하면 이후의 memory, harness, docs work가 같은 semantics를 재사용할 수 있습니다.

## Current-State Findings

- `src/core/retrieval.ts:77-171`의 `searchKnowledge`가 현재 사실상 공통 검색 엔진입니다. snapshot manifest의 `chunkScopes`와 `artifactEntries`를 읽고, scope filtering, authority weighting, recency weighting, vector/keyword hybrid scoring을 한 함수 안에서 처리합니다.
- `src/core/context.ts:23-61`의 `packContext`는 `searchKnowledge`를 호출한 뒤, 별도의 로컬 `countTokens()`와 `budget` 루프로 hit를 다시 선별합니다. 즉, retrieval selection이 executor 밖에서 한 번 더 조합됩니다.
- `src/core/memory.ts:552-635`의 `recallMemory`는 `searchKnowledge`를 감싼 `runRecallSearch`를 쓰고, 그 결과에 더해 `loadRecallArtifacts()`와 `working memory`를 수동으로 합칩니다. 이 파일은 retrieval semantics를 가장 많이 ad hoc으로 조합하는 지점입니다.
- `src/core/artifacts.ts:763-879`는 snapshot ingest 시 artifact chunks와 evidence chunks를 manifest에 넣는 경로이고, `src/core/artifacts.ts:902-1002`에는 별도의 `searchArtifacts()`와 `loadRecallArtifacts()`가 있습니다. 다만 이 두 함수는 현재 `query`/`context pack`/`memory recall`의 공통 경로로 연결되어 있지 않습니다.
- `src/core/output.ts:29-83`는 hit projection과 text formatting만 담당합니다. selection, source prioritization, scope policy는 여기로 내려오지 않습니다.
- `src/core/types.ts:5-317`에는 `RetrievalScope`, `SearchPolicy`, `ArtifactManifestEntry`, `SnapshotChunkScopes`, `RetrievalHit`가 있지만, planner/executor를 표현하는 별도 request/plan/result 타입은 없습니다.
- `src/core/commandInputs.ts:1-100`는 `query`와 `context pack` 입력을 따로 정규화합니다. `memory recall`은 positional-only라서, retrieval 공통 입력 모델이 아직 없습니다.
- `src/cli.ts:449-537`와 `src/cli.ts:551-583`는 `query`, `context pack`, `memory recall`을 서로 다른 helper로 실행합니다. CLI layer 자체가 이미 retrieval semantics의 분기점입니다.
- `test/cli.contract.test.ts:41-166`, `test/artifacts.integration.test.ts:106-124`, `test/memory.integration.test.ts:54-56`, `test/query.integration.test.ts:61-68`는 현재 분기된 behavior를 contract로 고정하고 있습니다.
- `apps/docs/content/docs/en/commands/query.mdx:7-23`, `apps/docs/content/docs/en/commands/context/pack.mdx:7-23`, `apps/docs/content/docs/en/commands/memory/recall.mdx:7-21`와 대응하는 ko 문서는 세 명령의 경계가 다르다는 점을 명시합니다. 즉, 구현과 문서 둘 다 unified semantics를 아직 전제하지 않습니다.

## Public Interface Decisions

- CLI command names, flags, and JSON envelope shapes는 유지합니다. 이 작업은 public surface 재설계가 아니라 semantics 통합입니다.
- `searchKnowledge()`는 즉시 제거하지 않고 compatibility wrapper로 유지합니다. 다만 내부적으로는 새 planner/executor를 호출하도록 바꿉니다.
- `packContext()`와 `recallMemory()`도 같은 shared retrieval layer를 호출하는 thin wrapper가 됩니다. 호출자는 계속 `query`, `context pack`, `memory recall`을 쓰되, 내부 조합만 통일합니다.
- JSON hit projection에는 `scope`, `originType`, `artifactId`, `artifactKind`, `authority`, `confidence` 같은 artifact-aware metadata를 노출하는 방향을 권장합니다. 기존 `path`, `sectionTitle`, `score*`, `text/excerpt`는 유지합니다.
- `query`는 여전히 snapshot-scoped general retrieval로 남습니다. working memory나 recall overlay를 끼워 넣지 않습니다.
- `context pack`은 prompt-sized packet builder로 남되, hit 선택과 budget trimming은 shared executor 쪽으로 이동합니다.
- `memory recall`은 working memory를 덧붙이는 역할을 유지하되, retrieval hit selection 자체는 shared executor가 담당합니다.
- 새 top-level CLI 명령은 추가하지 않습니다. 이번 범위는 기존 commands의 semantics 정렬에 한정합니다.

## Internal Architecture Decisions

- `src/core/retrieval.ts`에 planner/executor 경계를 도입합니다. 이름은 예를 들어 `RetrievalPlan`, `RetrievalRequest`, `RetrievalSource`, `RetrievalPacket` 계열이 적합합니다.
- planner는 어떤 source를 읽을지 결정합니다. 최소한 다음 source class를 구분해야 합니다.
  - durable document chunks
  - session artifact chunks
  - harness artifact chunks
  - evidence chunks
  - recall overlay / working-memory adjacency
- executor는 source들을 공통 hit shape로 바꾸고, 같은 scoring/finalization 규칙으로 정렬합니다.
- 현재 `searchKnowledge()` 안에 있는 scope filtering, artifact metadata lookup, authority weighting, recency weighting은 planner/executor 경계로 이동합니다.
- `src/core/artifacts.ts`의 `searchArtifacts()`와 `loadRecallArtifacts()`는 별도 특수 경로가 아니라 source adapter로 흡수하는 쪽이 맞습니다. 최소한 recall용 artifact lookup은 더 이상 `memory.ts`에서 직접 조합하지 않도록 해야 합니다.
- `src/core/context.ts`의 budget trimming은 유지하되, raw hit selection과 budget-aware selection이 같은 packet 결과에서 나오도록 바꿉니다. 지금처럼 `searchKnowledge()` 이후에 별도 로컬 필터를 추가하는 방식은 제거합니다.
- `src/core/output.ts`는 계속 projection/rendering 전용으로 둡니다. planner/executor 로직은 여기로 내려오지 않게 유지합니다.
- `src/core/types.ts`에는 shared retrieval request/result 타입이 추가되어야 합니다. `RetrievalHit`만으로는 planner-level intent와 source policy를 표현하기 어렵습니다.
- `src/core/commandInputs.ts`는 existing CLI validation boundary로 유지하되, query/context pack/memory recall가 공통 request로 변환될 수 있게 입력 모델을 정리합니다.
- scoring은 v1에서 기존 hybrid formula를 크게 흔들지 않는 것이 좋습니다. 우선은 semantics 통합이 목표이고, ranking 재튜닝은 별도 리스크입니다.

## Options Considered

1. **현재 구조 유지 + helper만 추가**
   - 장점: 구현이 가장 쉽습니다.
   - 단점: retrieval semantics 분기는 그대로 남고, query/context/memory가 다시 diverge할 가능성이 큽니다.

2. **일반화된 graph/pipeline engine으로 전면 재설계**
   - 장점: 확장성은 가장 좋습니다.
   - 단점: 현재 repo 크기와 요구 대비 과합니다. planning 비용이 커지고, 기존 contract와의 차이를 설명하기 어려워집니다.

3. **단일 planner/executor + thin wrappers**
   - 장점: 현재 command surface를 유지하면서 semantics를 한 곳에 모읍니다. artifact-aware source selection도 자연스럽게 흡수됩니다.
   - 단점: source adapter 설계와 result 타입 정리가 필요합니다.

**권장안:** 3번입니다. 현재 repo reality와 risk balance를 가장 잘 맞춥니다.

## Risks / Non-Goals / Backwards Compatibility

- Non-goal: snapshot manifest format을 바꾸는 것. `test/manifest.compat.test.ts`가 보존해야 하는 v2->v3 backfill behavior는 유지되어야 합니다.
- Non-goal: `memory wrap`, `memory promote`, `harness capture`, `harness promote`의 생성/승격 semantics를 바꾸는 것. 이번 작업은 retrieval layer에 한정합니다.
- Non-goal: ranking constant를 대폭 재튜닝하는 것. semantics 통합이 먼저이고, ranking 개선은 다음 단계입니다.
- Backwards compatibility: CLI command names, flags, and JSON envelope keys는 유지합니다. 필요한 경우 새로운 metadata 필드를 추가만 합니다.
- Backwards compatibility: `query`는 계속 snapshot-only behavior를 유지해야 합니다. working memory를 몰래 섞지 않는 것이 중요합니다.
- Risk: `context pack`과 `memory recall`의 결과가 지금보다 덜/더 풍부해질 수 있습니다. 특히 artifact-aware source를 planner에 넣으면 hit ordering이 바뀔 가능성이 있습니다.
- Risk: `searchArtifacts()`와 `loadRecallArtifacts()`를 어떻게 흡수할지에 따라 코드 삭제 범위가 달라집니다. 이 부분은 초기 구현에서 명확히 결정해야 합니다.
- Risk: evidence scope가 manifest chunkScopes에만 의존할지, direct artifact-file source를 추가로 볼지에 따라 query/recall의 coverage가 달라집니다.

## Implementation Steps

1. `src/core/types.ts`에 shared retrieval request/plan/result 타입을 추가하고, source kind와 packet-level metadata를 정의합니다.
2. `src/core/retrieval.ts`에서 planner/executor 경계를 만들고, 기존 `searchKnowledge()`를 compatibility wrapper로 전환합니다.
3. artifact-aware source adapters를 정리합니다. snapshot manifest 기반 chunks와 artifact-file 기반 recall sources를 같은 normalized hit shape로 반환하게 만듭니다.
4. `src/core/output.ts`를 새로운 result shape에 맞춰 확장합니다. projection은 유지하되, artifact-aware metadata를 숨기지 않게 합니다.
5. `src/core/context.ts`를 unified packet builder로 바꾸고, budget trimming을 executor 결과에 맞춰 수행합니다.
6. `src/core/memory.ts`의 `recallMemory()`를 재작성해서 `searchKnowledge()` + `loadRecallArtifacts()` 수동 조합을 제거합니다. working memory overlay만 별도 layer로 남깁니다.
7. `src/core/commandInputs.ts`와 `src/cli.ts`를 새 request model에 맞춰 정리합니다. CLI 플래그와 raw JSON 입력 계약은 유지합니다.
8. docs를 업데이트합니다. `query`, `context pack`, `memory recall`, 그리고 family overview 문서가 unified retrieval semantics를 설명하도록 맞춥니다.
9. tests를 추가/수정합니다. 새 planner/executor unit test와 command contract test를 함께 통과시켜야 합니다.

## Test Plan

- Unit tests
  - planner가 scope/source policy를 올바르게 분해하는지 검증합니다.
  - artifact-aware source가 동일한 hit shape와 scoring을 공유하는지 검증합니다.
  - budget selection이 `context pack`에서 일관되게 동작하는지 검증합니다.
  - recall overlay가 hit de-duplication을 깨지 않는지 검증합니다.
- Integration tests
  - `test/query.integration.test.ts`는 snapshot-scoped search가 유지되는지 확인합니다.
  - `test/artifacts.integration.test.ts`는 session artifact가 unified retrieval 경로로도 보이는지 확인합니다.
  - `test/memory.integration.test.ts`는 recall packet이 working memory와 retrieval을 같은 semantics로 조합하는지 확인합니다.
  - 필요하면 `test/harness.integration.test.ts`에 harness/evidence scope 관련 assertion을 추가합니다.
- CLI contract tests
  - `test/cli.contract.test.ts`에서 query/context/memory recall의 JSON output이 여전히 유효한지 확인합니다.
  - `test/cli-hardening.test.ts`에서 input validation regression이 생기지 않았는지 확인합니다.
- Compatibility tests
  - `test/manifest.compat.test.ts`는 그대로 통과해야 합니다.

## Suggested Commit Split

1. `feat: add unified retrieval plan and executor types`
   - shared request/result/type scaffolding
   - planner/executor boundary

2. `feat: route query and context pack through unified retrieval`
   - `searchKnowledge()` wrapper 유지
   - `packContext()` selection 정리
   - output projection 확장

3. `feat: route memory recall through unified artifact-aware retrieval`
   - `recallMemory()`에서 ad hoc composition 제거
   - recall artifact source adapter 통합

4. `test/docs: cover unified retrieval semantics`
   - integration/contract tests 업데이트
   - command docs와 overview docs 정리

## Open Questions / Ambiguities

- `searchArtifacts()`는 이번에 완전히 제거할지, 아니면 planner 내부의 source adapter로 살릴지 결정이 필요합니다.
- `evidence` scope가 snapshot manifest에 들어간 evidence chunks만 볼지, 아니면 recall artifact file의 evidence refs까지 볼지 정해야 합니다.
- `context pack`의 budget selection이 지금처럼 간단한 word-count approximation이면 충분한지, 아니면 token estimator를 별도로 도입할지 결정이 필요합니다.
- `memory recall`에서 `latestSession`과 `working memory`의 precedence를 planner-level policy로 옮길지, 아니면 wrapper-level overlay로 남길지 정해야 합니다.
- hit JSON에 얼마나 많은 artifact-aware metadata를 노출할지 결정이 필요합니다. 최소 공개 필드는 `scope`, `originType`, `artifactId`, `artifactKind`, `authority`, `confidence`입니다.

