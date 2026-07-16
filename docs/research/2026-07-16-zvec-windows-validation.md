# zvec 0.5.0 Windows x64 및 RAGit 2.0.0 store 실제 검증

- Wayfinder task: [zvec 후보를 Windows x64와 기존 store fixture에서 실제 검증한다](https://github.com/rhiokim/ragit/issues/36)
- 날짜: 2026-07-16 (Asia/Seoul)
- 후보: `@zvec/zvec@0.5.0` exact
- 기준 fixture: npm `ragit@2.0.0` + 정확히 resolve된 `@zvec/zvec@0.2.1`
- 상태: Actions 실행 전. 아래 표의 PASS/FAIL은 authoritative workflow artifact가 생긴 뒤에만 기입한다.

## 범위와 harness 경계

이 브랜치는 product source, `package.json`, lockfile, release code를 바꾸지 않는다. `scripts/zvec-windows-validation.mjs`는 다음의 일회용 candidate tarball을 만든다.

1. 현재 branch에서 이미 build된 package file을 staging directory로 복사한다.
2. staging `package.json`의 optional dependency만 `@zvec/zvec@0.5.0` exact로 바꾼다.
3. staging runtime target list에만 `win32/x64`를 더한다. 현재 released RAGit 2.0.0은 Windows를 의도적으로 guard하므로, 이 한시적 patch 없이는 native candidate로 init/ingest/read path를 실행할 수 없다.

따라서 이 결과는 zvec candidate와 packed RAGit code path의 compatibility evidence이며, RAGit Windows support 선언 또는 제품 변경이 아니다. staging package에서 dependency resolution path와 package version을 artifact JSON에 기록하고 `0.5.0`이 아니면 실패한다. nested `0.2.1`은 합격으로 취급하지 않는다.

## 재현 명령

```sh
pnpm install --frozen-lockfile
pnpm build
VALIDATION_ARTIFACT_DIR="$PWD/validation-artifacts" \
  node scripts/zvec-windows-validation.mjs create-legacy
```

Windows hosted runner에서는 workflow가 위 fixture artifact를 내려받아 다음을 실행한다.

```sh
node scripts/zvec-windows-validation.mjs validate-windows
```

Workflow: `.github/workflows/zvec-windows-validation.yml` (`workflow_dispatch` only).

## 필수 matrix와 판정

| Evidence | Node 22.14 Windows x64 | Node 24 Windows x64 | 판정 규칙 |
| --- | --- | --- | --- |
| clean install, CJS/ESM native import, resolved package | PENDING | PENDING | `@zvec/zvec` resolved version이 exact `0.5.0`이어야 함 |
| packed candidate CLI + MCP: init, ingest, query, context, status | PENDING | PENDING | temporary candidate가 native candidate를 실제 resolve하고 flow가 성공해야 함 |
| published RAGit 2.0.0 / zvec 0.2.1 store reopen | PENDING | PENDING | schema meta, query/context hit, status를 기록 |
| canonical store tree hash, CLI/MCP read paths | PENDING | PENDING | `.ragit/store/**` path/content SHA-256가 동일해야 함 |
| Windows spaces/Korean/long path | PENDING | PENDING | fresh와 legacy repo 모두에서 사용 |
| close 후 rename/delete | PENDING | PENDING | closed CLI process 뒤 disposable store copy를 rename/delete |
| active writer exclusion + reader availability | PENDING | PENDING | live lock에서 writer는 `STORE_WRITE_BUSY`, reader는 성공 |
| deterministic rebuild | PENDING | PENDING | disposable legacy copy에서 store 삭제 후 `repair --apply --action store-rebuild` 및 query |
| C:/D: cross-drive | PENDING | PENDING | runner가 두 번째 filesystem drive를 노출할 때만 실행; 아니면 NOT TESTED |

## Artifact contract

각 Windows matrix job은 `zvec-windows-validation-node-<node>` artifact를 올린다.

- `windows-validation-report.json`: platform/arch/Node, exact resolved paths/version, temporary candidate patch, PASS/FAIL check, error stack, tree hashes, query citation IDs, MCP tool result, NOT TESTED.
- `ragit-2.0.0-zvec-0.2.1-store-fixture`: macOS ARM64 / Node 22.14에서 published package로 만든 committed legacy repo와 `legacy-fixture-report.json`. Hidden `.git` 및 `.ragit` directory도 포함한다.

read-only checks는 hash mismatch를 test failure로 남긴다. clone 내부 또는 disposable rebuild copy의 mutation은 canonical fixture mutation으로 바꾸어 보고하지 않는다.

## Decision inputs

PASS는 Windows package의 native import 또는 candidate compatibility 일부만 뜻한다. Windows x64 support Go에는 두 Node lane의 모든 support-critical check와 cross-drive evidence(또는 명시적 hosted-runner limitation의 별도 resolution), store transition/rollback policy가 필요하다. 다음은 즉시 No-Go input이다.

- native import failure, wrong resolved zvec version, or Node 24 failure;
- legacy data/schema/query failure;
- canonical legacy store mutation during CLI/MCP read path;
- path, handle cleanup, writer exclusion, or deterministic rebuild failure;
- any support-critical check that has no authoritative artifact.

## Authoritative runs

실행 후 다음을 채운다.

- Commit/blob: PENDING
- Actions run: PENDING
- Artifact URLs: PENDING
- Observed mutation files: PENDING
- PASS / FAIL / NOT TESTED summary and Go/No-Go: PENDING
