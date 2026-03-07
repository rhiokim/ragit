# RAGit Init 시나리오

## 요약

이 문서는 `ragit init`의 사용자 시나리오와 시스템 시나리오를 고정합니다.
`ragit init`은 **guide/control-plane + zvec 저장소 bootstrap 명령**이며, 전체 RAG 구축 완료 명령이 아닙니다.

현재 동작 경계:

- Git 상태 확인
- 루트 `AGENTS.md` 로드 또는 생성
- `.ragit/config.toml` 생성
- `.ragit/guide/templates/*` 증분 생성
- `.ragit/guide/guide-index.json` 기록
- 빈 zvec 컬렉션 bootstrap 및 `.ragit/store/meta.json` 기록

현재 **하지 않는 일**:

- 저장소 문서 탐색
- markdown 청킹
- manifest 생성
- zvec chunk/document 레코드 upsert
- searchable knowledge 생성

`storage.backend = "zvec"`는 이제 canonical backend를 의미하며, `init`은 저장소 문서를 인덱싱하지 않은 빈 저장소만 준비합니다.

## 사용자 시나리오

### U1. 신규 로컬 부트스트랩

**전제 조건**
- 현재 디렉터리가 Git 저장소가 아님
- 루트 `AGENTS.md`가 없음
- 사용 가능한 `.ragit/` 구조도 없음

**사용자 목표**
- 저장소를 RAGit 기반 문서 작업 구조로 최초 준비

**기대 흐름**
1. 사용자가 `pnpm ragit init` 실행
2. RAGit이 Git 부재 감지
3. 대화형에서 `git init` 제안
4. `AGENTS.md` 생성
5. `.ragit/config.toml`, guide templates, `guide-index.json` 생성
6. `hooks install`, `ingest` 다음 액션 출력

**기대 결과**
- 저장소가 control-plane ready 및 zvec-store ready 상태가 됨
- searchable knowledge는 아직 없음

### U2. 기존 Git 저장소 + 기존 `AGENTS.md`

**전제 조건**
- 현재 디렉터리가 Git 저장소임
- 루트 `AGENTS.md`가 이미 존재함

**사용자 목표**
- 기존 지침문을 유지한 채 RAGit 표준 guide 구조를 접목

**기대 흐름**
1. 사용자가 `pnpm ragit init` 실행
2. RAGit이 `AGENTS.md`를 읽기 전용으로 로드
3. 누락된 `.ragit` 파일만 생성
4. `guide-index.json` 재생성

**기대 결과**
- 기존 지침문은 변경되지 않음
- 표준 guide 구조만 증분 추가됨

### U3. 부분 초기화된 저장소 재실행

**전제 조건**
- `.ragit/`은 존재함
- 일부 템플릿 또는 인덱스 파일만 누락됨

**사용자 목표**
- 파괴적 초기화 없이 guide 구조를 복구 또는 보강

**기대 흐름**
1. 사용자가 `pnpm ragit init` 실행
2. 기존 파일 유지
3. 누락 템플릿만 생성
4. `guide-index.json` 최신화

**기대 결과**
- `init`이 incremental/idempotent하게 동작함

### U4. 비대화형 또는 CI 초기화

**전제 조건**
- TTY가 없거나, 호출자가 `--yes`를 의도적으로 사용함

**사용자 목표**
- 자동화 환경에서 동일한 control-plane 구조 준비

**기대 흐름**
1. 사용자가 `pnpm ragit init --yes` 실행
2. Git 저장소면 그대로 진행
3. Git 저장소가 아니면 `--git-init`이 있어야 자동 초기화 진행
4. table 또는 JSON summary 반환

**기대 결과**
- CI에서도 guide/control-plane 준비 가능
- searchable knowledge는 이후 `ingest`가 담당

## 시스템 시나리오

### 상태 모델

- `S0 Unprepared`
- `S1 Git Ready`
- `S2 Instruction Ready`
- `S3 Guide Ready`
- `S4 Init Complete (Guide + Zvec Store Ready)`

### 허용 전이

- `S0 -> S1`
  - 트리거: 기존 Git 저장소 감지 또는 `git init` 승인/실행
- `S1 -> S2`
  - 트리거: 루트 `AGENTS.md` 로드 또는 생성
- `S2 -> S3`
  - 트리거: guide templates 증분 생성, boundary parse, `guide-index.json` 기록
- `S3 -> S4`
  - 트리거: zvec 초기화, 컬렉션 생성/오픈, 요약 및 next actions 반환

### 금지 전이

- `S4 -> Index Ready`
- `S4 -> Search Ready`

위 상태들은 `init` 범위 밖이며, 이후 `ragit ingest` 등의 명령에 속합니다.

## 입력, 출력, Side Effect

### 입력

- 작업 디렉터리
- interactive 또는 non-interactive 모드
- 선택적 `--git-init`
- 선택적 summary 출력 형식

### 출력

- summary table 또는 JSON summary
- next actions
  - `ragit migrate from-json-store` (legacy JSON store가 있을 때)
  - `ragit hooks install`
  - `ragit ingest --all`

### 허용되는 Side Effect

- `.ragit/config.toml` 생성 또는 갱신
- `.ragit/guide/templates/*` 생성 또는 갱신
- `.ragit/guide/guide-index.json` 생성 또는 갱신
- `.ragit/store/meta.json` 생성 또는 갱신
- `.ragit/store/documents/`, `.ragit/store/chunks/` 생성 또는 오픈
- 루트 `AGENTS.md` 생성 또는 로드
- `.gitignore`에 로컬 전용 `.ragit/store/`, `.ragit/cache/` 항목 반영

### 명시적 Non-Effect

- `.ragit/manifest/*` 생성 없음
- zvec chunk/document 레코드 생성 없음
- 문서 인덱스 레코드 생성 없음
- 저장소 전체 markdown 순회 없음
- 저장소 지식 임베딩 작업 없음

## 실패 및 경계 흐름

- TTY 없는 interactive 실행
  - 결과: `--yes` 또는 `--non-interactive` 안내와 함께 즉시 실패
- 비Git + non-interactive + `--git-init` 없음
  - 결과: 즉시 실패
- interactive에서 `git init` 거부
  - 결과: 초기화 중단
- 기존 `AGENTS.md` 존재
  - 결과: 로드만 수행하고 원본은 수정하지 않음

## `init`와 `ingest`의 경계

`init`은 control plane을 준비합니다.
`ingest`는 searchable knowledge를 준비합니다.

운영 순서:

1. `pnpm ragit init`
2. `pnpm ragit hooks install`
3. `pnpm ragit ingest --all`

해석 규칙:

- `init` 이후 상태는 **guide-ready + zvec-store-ready**
- `ingest` 이후 상태는 **search-ready**
