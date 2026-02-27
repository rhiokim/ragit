# ragit

`ragit`은 프로젝트 저장소 내부에서 동작하는 **zvec + git 결속형 RAG CLI**입니다.  
AI Agent와의 구현/개발/유지보수/테스트 과정에서 발생하는 문서를 수집·분석·검색하고,
커밋 SHA에 결속된 스냅샷으로 버전 관리합니다.

## MVP 문서 타입 (v0.1)

- ADR
- PRD
- SRS
- Plan
- DDD
- Glossary(용어집)

## 설치

```bash
pnpm install
pnpm build
pnpm exec ragit --help
```

## 기본 명령

```bash
ragit init
ragit init --yes --output json
ragit init --yes --git-init
ragit config set retrieval.top_k 8
ragit hooks install
ragit ingest --all
ragit query "DDD 경계 컨텍스트 원칙" --format both
ragit context pack "이번 스프린트 구현 계획" --budget 1200
ragit migrate from-sqlitevss --dry-run
ragit status
ragit doctor
```

## 저장 구조

```text
.ragit/
  config.toml
  guide/guide-index.json
  guide/templates/
  manifest/<commit-sha>.json
  store/index.json
  cache/
  hooks/
```

- Git 추적 권장: `.ragit/config.toml`, `.ragit/manifest/**`
- 로컬 전용(기본 `.gitignore`): `.ragit/store/**`, `.ragit/cache/**`

## init 인터랙티브 가이드

`ragit init`은 기본적으로 6단계 대화형 위자드를 실행합니다.

1. Git 환경 검사 (비저장소면 `git init` 제안)
2. 초기화 모드 확인
3. 루트 `AGENTS.md` 로드/생성
4. 문서 템플릿 범위 확정 (ADR/PRD/SRS/Plan/DDD/Glossary)
5. `.ragit/guide` 증분 생성 + `guide-index.json` 갱신
6. 요약 테이블 + 다음 액션 출력

지원 옵션:

```bash
ragit init --yes                 # 비대화 기본값 실행
ragit init --non-interactive     # --yes 별칭
ragit init --git-init            # 비대화에서 git init 자동 허용
ragit init --output json         # 요약 JSON 출력
```

## Hook 전략

- `post-commit`: `HEAD~1..HEAD` 변경분 자동 인덱싱
- `post-merge`: `${ORIG_HEAD:-HEAD~1}..HEAD` 변경분 자동 인덱싱
- 실패 시 커밋/머지를 차단하지 않고 경고성으로 동작합니다.

## 검색 전략

- 1차: zvec 임베딩 유사도
- 2차: 키워드 점수
- 최종: `alpha * vector + (1-alpha) * keyword` (기본 `alpha=0.7`)

## 보안 기본값

- 수집 시 비밀정보 마스킹 기본 활성화 (`security.secret_masking=true`)
- OpenAI/GitHub/AWS 키 및 `api_key/token/secret` 패턴을 마스킹합니다.

## 테스트

```bash
pnpm test
```
