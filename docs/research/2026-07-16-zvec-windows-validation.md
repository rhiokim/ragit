# zvec 0.5.0 Windows x64 및 RAGit 2.0.0 store 실제 검증

- Wayfinder task: [zvec 후보를 Windows x64와 기존 store fixture에서 실제 검증한다](https://github.com/rhiokim/ragit/issues/36)
- 날짜: 2026-07-16 (Asia/Seoul)
- 후보: `@zvec/zvec@0.5.0` exact
- 기준 fixture: npm `ragit@2.0.0` + 정확히 resolve된 `@zvec/zvec@0.2.1`
- 상태: **No-Go**. 2026-07-16 completed Windows x64 run에서 native import는 두 Node lane 모두 통과했지만, 실제 packed RAGit candidate가 init/read path 전에 zvec 0.5.0 API incompatibility로 실패했다.

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

| Evidence | Node 22.14 Windows x64 | Node 24 Windows x64 | 판정 |
| --- | --- | --- | --- |
| clean install, CJS/ESM native import, resolved package | PASS | PASS | both reports resolve exact `0.5.0` and load CJS + ESM |
| packed candidate CLI + MCP: init, ingest, query, context, status | FAIL | FAIL | `init` fails: `Cannot assign to read only property 'querySync' of object '#<Collection>'` |
| published RAGit 2.0.0 / zvec 0.2.1 store reopen | FAIL | FAIL | candidate `status` reaches the same error before schema/data/query can be read |
| canonical store tree hash, CLI/MCP read paths | NOT TESTED | NOT TESTED | failed commands left the copied tree unchanged, but no successful candidate read occurred |
| Windows spaces/Korean/long path | FAIL | FAIL | candidate `init` in the space/Korean/long-path repository hits the same API error |
| close 후 rename/delete | NOT TESTED | NOT TESTED | blocked because `status` cannot open the disposable copy |
| active writer exclusion + reader availability | NOT TESTED | NOT TESTED | reader cannot reach the lock assertion because query has the same API error |
| deterministic rebuild | FAIL | FAIL | rebuild invocation fails with the same `querySync` property error |
| C:/D: cross-drive | FAIL | FAIL | hosted runner exposed `D:` and ran the case; candidate query fails with the same API error |

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

### Immutable pointers

- Harness commit: [`96df35dc2a5089a29f008c4acf2e861686aecfdd`](https://github.com/rhiokim/ragit/commit/96df35dc2a5089a29f008c4acf2e861686aecfdd)
- Evidence run: [29475743471](https://github.com/rhiokim/ragit/actions/runs/29475743471) — completed `failure`, intentionally because the support-critical assertions failed.
- Fixture job: [create-ragit-2.0.0-zvec-0.2.1-fixture](https://github.com/rhiokim/ragit/actions/runs/29475743471/job/87548212398)
- Windows jobs: [Node 22.14](https://github.com/rhiokim/ragit/actions/runs/29475743471/job/87548301633), [Node 24](https://github.com/rhiokim/ragit/actions/runs/29475743471/job/87548301597)
- Artifacts: [legacy fixture](https://github.com/rhiokim/ragit/actions/runs/29475743471/artifacts/8366474703), [Node 22.14 report](https://github.com/rhiokim/ragit/actions/runs/29475743471/artifacts/8366515355), [Node 24 report](https://github.com/rhiokim/ragit/actions/runs/29475743471/artifacts/8366500393).

### Observed result and decision input

The macOS fixture job created a committed published `ragit@2.0.0` store with resolved `@zvec/zvec@0.2.1`; the report includes its whole `.ragit/store/**` SHA-256 tree and query citation IDs. On both Windows x64 lanes, the temporary packed RAGit candidate resolved `@zvec/zvec@0.5.0` from its candidate install root (not nested `0.2.1`) and both CJS and ESM imports succeeded.

The first real RAGit operation failed in both lanes: `init` reported `Cannot assign to read only property 'querySync' of object '#<Collection>'`. Candidate `status`, query, rebuild, MCP startup/read, and the `D:` cross-drive query repeated the same incompatibility or closed as a consequence. The copied canonical legacy tree was unchanged after those failed CLI attempts; that is not evidence of successful read-only preservation and is recorded as NOT TESTED.

**Decision: No-Go for RAGit Windows x64 support and for a zvec 0.5.0 dependency upgrade as-is.** Before reconsidering, implementation must adapt RAGit's collection method instrumentation to the 0.5.0 collection object contract, then rerun the complete packed CLI/MCP, legacy-store preservation, cleanup/lock, rebuild, and C:/D: matrix. The candidate native package alone is viable on both tested Node versions; the RAGit integration is not.
