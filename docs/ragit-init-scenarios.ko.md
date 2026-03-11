# RAGit Init 시나리오

## 요약

이 문서는 현재 `ragit init`의 제품 경계를 고정합니다.
`ragit init`은 **discover-first bootstrap 명령**입니다. 즉, 저장소 상태를 먼저 판독하고, 기존 지식 소스를 우선 재사용하며, 부족한 기초 문서만 보강한 뒤 control plane과 canonical zvec store를 준비합니다.

현재 1단계 동작:

- Git 상태 확인 및 중첩 경로의 저장소 루트 정규화
- 저장소 코드/문서/빌드 파일 스캔
- `empty`, `existing`, `docs-heavy`, `monorepo` 모드 판정
- 문서 census, coverage 평가, maturity 평가, knowledge slot 매핑
- 누락된 기초 문서 계획 수립 및 기존 문서 우선 재사용
- 1단계에서만 다음 문서를 생성 가능:
  - `RAGIT.md`
  - `docs/workspace-map.md`
  - `docs/ragit/ingestion-policy.md`
  - `docs/known-gaps.md`
  - `docs/adr/README.md`
- `.ragit/config.toml`, `.ragit/guide/templates/*`, `.ragit/guide/guide-index.json` 기록
- 빈 zvec 컬렉션 bootstrap 및 `.ragit/store/meta.json` 기록

여전히 **하지 않는 일**:

- 저장소 문서를 query 가능한 레코드로 청킹
- snapshot manifest 생성
- zvec document/chunk 레코드 upsert
- 저장소를 search-ready 상태로 만들기
- 별도 `adopt`, `map`, `sync` 명령 도입

핵심 해석 규칙:

- `init`은 저장소 문서를 읽고 분류할 수 있음
- searchable knowledge 생성은 여전히 `ingest`가 담당함

## 사용자 시나리오

### U1. 비어 있는 저장소 부트스트랩

**전제 조건**
- 현재 디렉터리가 Git 저장소가 아니거나, 거의 비어 있는 신규 저장소임
- 루트 `AGENTS.md`가 없음
- 사용 가능한 `.ragit/` 구조도 없음

**사용자 목표**
- 거의 아무것도 없는 상태에서 기초 지식 운영 체계를 부팅

**기대 흐름**
1. 사용자가 `pnpm ragit init --yes --git-init` 실행
2. 필요하면 Git 초기화 수행
3. 저장소를 스캔하고 `empty`로 판정
4. 기초 초안 문서 계획 수립
5. 누락 문서와 `.ragit/**`, `AGENTS.md`, guide 자산, 빈 zvec store 생성
6. summary + next actions 반환

**기대 결과**
- 저장소가 control-plane ready 및 zvec-store ready 상태가 됨
- 기초 문서 초안이 생성됨
- searchable knowledge는 아직 없음

### U2. 기존 코드베이스 편입

**전제 조건**
- 현재 디렉터리가 Git 저장소이며, 코드와 일부 문서가 이미 존재함

**사용자 목표**
- 기존 저장소 의도를 최대한 재사용하면서 부족한 기초 문서만 보강

**기대 흐름**
1. 사용자가 `pnpm ragit init` 실행
2. 저장소 구조를 스캔하고 `existing`으로 판정
3. `README.md`, `CONTRIBUTING.md`, architecture 문서 등을 1차 소스로 재사용
4. 누락된 1단계 기초 문서만 생성
5. `.ragit/**`, guide index, zvec store bootstrap 수행

**기대 결과**
- 기존 문서는 덮어쓰지 않음
- 생성 문서는 inferred draft로 추가됨

### U3. 문서가 풍부한 저장소 편입

**전제 조건**
- `docs/`, `adr/`, architecture 문서, glossary 등이 이미 충분히 존재함

**사용자 목표**
- 중복 템플릿 남발 없이 machine-readable knowledge map 확보

**기대 흐름**
1. 사용자가 `pnpm ragit init` 실행
2. 저장소를 `docs-heavy`로 판정
3. 기존 문서로 coverage/maturity 계산
4. 정말 부족한 기초 문서만 생성
5. guide/bootstrap 단계는 동일하게 수행

**기대 결과**
- 기존 문서가 source of truth로 우선됨
- 생성 파일 수가 낮게 유지됨

### U4. 모노레포 편입

**전제 조건**
- `pnpm-workspace.yaml`, `turbo.json`, `apps/*`, `packages/*` 같은 workspace 표식이 존재함

**사용자 목표**
- 루트 레벨 bootstrap을 유지하면서 app/package 경계를 명시

**기대 흐름**
1. 사용자가 `pnpm ragit init` 실행
2. 저장소를 `monorepo`로 판정
3. apps/packages/workspace 파일을 workspace slot으로 매핑
4. 필요 시 `docs/workspace-map.md` 생성
5. control-plane과 zvec bootstrap 완료

**기대 결과**
- 루트 수준 bootstrap은 유지됨
- workspace 구조가 agent 관점에서 명시됨

### U5. Dry-run / CI 계획 계산

**전제 조건**
- 실제 쓰기 없이 init 계획만 보고 싶음

**사용자 목표**
- scan, mode, coverage, planned files를 먼저 검토

**기대 흐름**
1. 사용자가 `pnpm ragit init --dry-run --output json` 실행
2. 저장소 분석과 gap-fill planning 수행
3. 실제 파일 쓰기 없이 예상 bootstrap 결과까지 포함한 summary 반환

**기대 결과**
- 파일 시스템 변경 없음
- 전체 init 리포트는 그대로 확인 가능

## 시스템 시나리오

### 상태 모델

- `S0 Unprepared`
- `S1 Git Ready`
- `S2 Repository Diagnosed`
- `S3 Foundations Planned`
- `S4 Control Plane Ready`
- `S5 Init Complete (Control Plane + Zvec Store Ready)`

### 허용 전이

- `S0 -> S1`
  - 트리거: 기존 Git 저장소 감지 또는 `git init` 승인/실행
- `S1 -> S2`
  - 트리거: repository scan, mode select, documentation census, coverage, maturity, knowledge mapping 완료
- `S2 -> S3`
  - 트리거: gap-fill plan 계산 완료
- `S3 -> S4`
  - 트리거: 1단계 draft 문서, `.ragit/config.toml`, guide 자산, `AGENTS.md` 기록
- `S4 -> S5`
  - 트리거: 빈 zvec store 생성/오픈 및 summary 반환

### 금지 전이

- `S5 -> Index Ready`
- `S5 -> Search Ready`

위 상태는 여전히 `ragit ingest`의 책임입니다.

## 입력, 출력, Side Effect

### 입력

- 작업 디렉터리
- interactive 또는 non-interactive 모드
- 선택적 `--git-init`
- 선택적 `--mode auto|empty|existing|monorepo|docs-heavy`
- 선택적 `--strategy minimal|balanced|full`
- 선택적 `--dry-run`
- 선택적 `--merge-existing`
- 선택적 summary 출력 형식

### 출력

- summary table 또는 JSON summary
- JSON 키:
  - `executionMode`
  - `repositoryMode`
  - `strategy`
  - `scan`
  - `coverage`
  - `maturity`
  - `knowledgeMap`
  - `actions`
  - `bootstrap`
  - `nextActions`

### 허용되는 Side Effect

- `RAGIT.md` 생성 또는 갱신
- `docs/workspace-map.md` 생성 또는 갱신
- `docs/ragit/ingestion-policy.md` 생성 또는 갱신
- `docs/known-gaps.md` 생성 또는 갱신
- `docs/adr/README.md` 생성 또는 갱신
- `.ragit/config.toml` 생성 또는 갱신
- `.ragit/guide/templates/*` 생성 또는 갱신
- `.ragit/guide/guide-index.json` 생성 또는 갱신
- `.ragit/store/meta.json` 생성 또는 갱신
- `.ragit/store/documents/`, `.ragit/store/chunks/` 생성 또는 오픈
- 루트 `AGENTS.md` 생성 또는 로드
- `.gitignore`에 로컬 전용 `.ragit/store/`, `.ragit/cache/` 항목 반영

### 명시적 Non-Effect

- `.ragit/manifest/*` 생성 없음
- zvec document/chunk 레코드 생성 없음
- query-ready knowledge state 생성 없음
- 저장소 전체 임베딩 작업 없음
- 1단계에서 `map`, `sync`, `adopt` 명령 롤아웃 없음

## 실패 및 경계 흐름

- TTY 없는 interactive 실행
  - 결과: `--yes` 또는 `--non-interactive` 안내와 함께 즉시 실패
- 비Git + non-interactive + `--git-init` 없음
  - 결과: 즉시 실패
- interactive에서 `git init` 거부
  - 결과: 초기화 중단
- 기존 source docs 존재
  - 결과: 1차 입력으로 재사용하며 1단계에서는 덮어쓰지 않음
- `--dry-run`
  - 결과: 무변경, 그러나 전체 분석 결과와 planned actions는 반환

## `init`와 `ingest`의 경계

`init`은 저장소 운영 모델을 준비합니다.
`ingest`는 searchable knowledge를 준비합니다.

운영 순서:

1. `pnpm ragit init`
2. `pnpm ragit hooks install`
3. `pnpm ragit ingest --all`

해석 규칙:

- `init` 이후 상태는 **diagnosed + foundation-ready + zvec-store-ready**
- `ingest` 이후 상태는 **search-ready**
