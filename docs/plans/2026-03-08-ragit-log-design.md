---
type: plan
---
# RAGit Log Design

## Background

`git log`는 사람을 위한 코드 변경 이력 도구입니다. 반면 `ragit log`는
인간과 AI Agent의 협업 기억을 읽는 도구여야 합니다. 따라서 `ragit log`의
기본 질문은 "무슨 커밋이 있었는가?"가 아니라 "Agent가 지금 무엇을
믿어야 하고, 무엇이 의미적으로 달라졌으며, 어디서 다시 시작해야 하는가?"
가 되어야 합니다.

이 설계는 새로 추가된 [Ground 2]와 [Rule 2]를 제품 수준의 기준축으로
삼습니다. 즉, `ragit log`는 Git의 UX를 일부 차용할 수는 있지만, Git의
파일 이력 모델을 그대로 복제해서는 안 됩니다.

## Problem

현재 저장소는 아래 두 종류의 기록을 이미 가지고 있습니다.

1. Git commit history
2. `.ragit/manifest/<sha>.json` 형태의 snapshot history

이 조합만으로도 "이 커밋에서 검색 가능한 knowledge state가 무엇이었는가"는
복원할 수 있습니다. 다만 현재 모델에는 아래 정보가 부족합니다.

1. 어떤 `memory wrap`이 어떤 목표를 위해 기록되었는지에 대한 시계열
2. 어떤 `memory promote`가 어떤 결정/용어/계획을 장기기억으로 승격했는지에
   대한 명시적 이벤트
3. 특정 snapshot이 어떤 사용자 목표나 episode에 속하는지에 대한 연결 정보

따라서 `ragit log`는 단일 단계로 완성되지 않습니다. 현재 데이터 모델로
실행 가능한 v1과, 북극성으로서의 v2를 분리해야 합니다.

## Approaches

### A. Git Mirror

`git log`와 거의 같은 출력을 보여주고 manifest 존재 여부만 덧붙입니다.
구현은 쉽지만, RAGit이 왜 별도 도구인지 설명하지 못합니다. Agent 관점에서
유의미한 복원 정보가 부족하므로 채택하지 않습니다.

### B. Snapshot-Centered Semantic Log

각 commit에 결속된 snapshot을 기준으로 문서 수, 청크 수, 문서 타입 분포,
추가/수정/삭제된 문서를 요약합니다. 현재 manifest 모델만으로 구현 가능하며,
"왜 retrieval 결과가 바뀌었는가?"를 설명할 수 있습니다. v1 권장안입니다.

### C. Episode/Goal-Centered Collaboration Log

snapshot뿐 아니라 `memory wrap`, `memory promote`, future event ledger를
엮어 "목표 단위"의 협업 기억 계보를 보여줍니다. 이는 제품의 북극성에 가장
가깝지만, 현재 저장 구조만으로는 완전한 구현이 어렵습니다. v2 방향으로
채택합니다.

## Recommendation

v1은 `B. Snapshot-Centered Semantic Log`로 구현합니다.

이 선택의 이유는 다음과 같습니다.

1. 현재 저장소에 이미 존재하는 데이터만으로 신뢰 가능한 출력을 만들 수
   있습니다.
2. Agent가 retrieval drift의 원인을 추적하는 데 즉시 도움이 됩니다.
3. 이후 event ledger가 추가되더라도, snapshot log는 episode log의 하위
   근거 계층으로 재사용할 수 있습니다.

동시에 UX와 설명은 v2의 철학을 미리 반영합니다. 즉 v1도 commit 나열이
아니라 "semantic change summary"를 기본 출력으로 삼습니다.

## North Star

장기적으로 `ragit log`는 아래 질문에 답해야 합니다.

1. 지금 살아 있는 목표는 무엇인가?
2. 최근에 어떤 제약과 결정이 안정화되었는가?
3. 어떤 열린 루프가 아직 닫히지 않았는가?
4. 다음 Agent가 어디서부터 다시 시작해야 하는가?
5. 그 판단은 어떤 snapshot, memory artifact, source 문서에 근거하는가?

즉, 최종적으로 `ragit log`는 "협업 기억 이력"이어야 하며, commit은 그
기억을 정렬하는 축 중 하나일 뿐 읽기 단위 그 자체는 아닙니다.

## V1 Scope

### Command Surface

```bash
ragit log [revRange]
```

권장 옵션:

1. `-n, --max-count <n>`: 출력 개수 제한
2. `--format <format>`: `text|json|both`
3. `--view <view>`: `minimal|default|full`
4. `--type <docType>`: `adr|prd|srs|spec|plan|ddd|glossary|pbd`
5. `--path <glob>`: 특정 경로 필터
6. `--show-missing`: manifest가 없는 commit도 함께 표시
7. `--cwd <path>`: 대상 저장소 경로

`git log`의 문법을 일부 닮게 두되, 기본 출력은 `git log`와 다르게 설계합니다.

### Read Unit

v1의 읽기 단위는 "snapshot이 존재하는 commit entry"입니다.

각 entry는 최소한 아래 정보를 포함합니다.

1. commit SHA, subject, author, authoredAt
2. snapshot 존재 여부와 `createdAt`
3. documents/chunks 총량
4. 이전 snapshot 대비 added/modified/deleted 문서 수
5. 변경된 문서 목록
6. docType 분포

### Diff Semantics

문서 차이 계산은 아래 규칙을 따릅니다.

1. added: 이전 snapshot에 없는 document
2. modified: 동일 document인데 `hash` 또는 `versionId`가 달라진 경우
3. deleted: 이전 snapshot에는 있고 현재 snapshot에는 없는 document

비교 기준은 "직전 commit"이 아니라 "가장 가까운 이전 snapshot"입니다.
이유는 모든 commit이 manifest를 갖지 않을 수 있기 때문입니다.

### Default Text Output

기본 출력은 사람이 읽을 수 있으면서도 Agent가 구조적으로 파싱하기 쉬운
block형을 사용합니다.

```text
commit <sha>
Subject: <subject>

Snapshot: indexed
Knowledge: docs=<n> chunks=<n>
Semantic delta: +<n> modified=<n> deleted=<n>
Changed:
  A <path>
  M <path>
  D <path>
Types:
  adr=<n> spec=<n> plan=<n> ...
```

### View Semantics

1. `minimal`: 한 줄 요약. Agent의 빠른 스캔과 터미널 목록 탐색용
2. `default`: semantic delta 중심 block 출력. 기본값
3. `full`: 각 문서의 section 수, chunks 증감, memory 경로 여부까지 포함

## V1 JSON Contract

`--format json`일 때 각 entry는 아래 구조를 권장합니다.

```json
{
  "commitSha": "string",
  "subject": "string",
  "authorName": "string",
  "authoredAt": "ISO-8601",
  "snapshot": {
    "status": "indexed|missing",
    "createdAt": "ISO-8601|null",
    "docs": 0,
    "chunks": 0,
    "delta": {
      "added": 0,
      "modified": 0,
      "deleted": 0
    },
    "types": {
      "adr": 0,
      "spec": 0
    },
    "changed": [
      {
        "path": "string",
        "status": "A|M|D",
        "docType": "string"
      }
    ]
  }
}
```

이 계약은 이후 episode log가 도입되더라도 `snapshot` 하위 필드로 유지할 수
있도록 설계합니다.

## V2 Direction

v2에서는 snapshot history 위에 별도 event ledger를 추가합니다. 예를 들면
아래와 같은 구조입니다.

```text
.ragit/log/events/YYYY-MM-DD.jsonl
```

이벤트 타입 예시:

1. `memory.wrap`
2. `memory.promote`
3. `ingest`
4. `recall`
5. `goal.set`

이벤트에는 최소한 아래 필드가 필요합니다.

1. `eventId`
2. `eventType`
3. `goal`
4. `sourceSessionId`
5. `sourceHeadSha`
6. `relatedPaths`
7. `openLoops`
8. `nextActions`
9. `recordedAt`

이 레이어가 추가되면 `ragit log`는 commit 중심 목록에서 episode 중심 목록으로
진화할 수 있습니다.

## Non-Goals

v1에서 하지 않을 일은 아래와 같습니다.

1. raw conversation transcript를 직접 재생하지 않습니다.
2. 모든 commit을 강제로 의미 단위로 해석하지 않습니다.
3. `memory wrap`의 자유 텍스트를 소급 추론해 episode를 꾸며내지 않습니다.
4. `git log`의 모든 옵션을 1:1 복제하지 않습니다.

## Implementation Notes

구현은 아래 순서가 적절합니다.

1. Git helper 추가: rev range 순회와 commit metadata 조회
2. history core 추가: manifest 로드, nearest previous snapshot 탐색, semantic diff 계산
3. CLI command 추가: `ragit log`
4. text/json formatter 추가
5. 테스트 추가

## Test Plan

필수 테스트는 아래와 같습니다.

1. snapshot이 있는 commit만 기본 출력에 포함되는지
2. `--show-missing`일 때 missing commit이 노출되는지
3. added/modified/deleted 판정이 정확한지
4. `--type`, `--path` 필터가 diff 결과와 totals에 일관되게 적용되는지
5. `--view minimal|default|full` 출력 차이가 안정적인지
6. `--format json` 계약이 고정되는지

## Decision

`ragit log`의 v1은 Git-like history command가 아니라, snapshot 기반의
semantic collaboration log로 설계합니다. commit은 정렬 축으로 사용하되,
기본 출력은 Agent가 재진입하기 좋은 협업 기억 요약을 제공해야 합니다.
