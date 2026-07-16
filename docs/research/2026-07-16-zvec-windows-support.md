# zvec 최신 안정판의 Windows x64 및 RAGit store 호환성 조사

- 조사일: 2026-07-16 (Asia/Seoul)
- Wayfinder 티켓: [zvec 최신 안정판은 Windows x64와 기존 RAGit store를 실제로 지원하는가](https://github.com/rhiokim/ragit/issues/33)
- 범위: `@zvec/zvec` 0.2.1부터 npm의 최신 안정판까지의 공식 배포물, zvec 공식 저장소·릴리스·이슈, 기존 RAGit 호출 계약과 store
- 제외: manifest/lockfile/source/workflow 변경, Windows 지원 선언, 실제 업그레이드 구현

## 결론

2026-07-16 기준 **Node.js용 최신 안정판은 `@zvec/zvec@0.5.0`**이다. zvec core의 최신 GitHub 릴리스는 `v0.5.1`이지만 `@zvec/zvec` 및 native binding `0.5.1`은 npm에 배포되지 않았다. 따라서 지금 실제로 검증할 수 있는 업그레이드 후보는 `0.5.0` 하나이며, core `v0.5.1`은 Node 패키지가 배포되기 전까지 후보가 아니다.

`0.5.0`은 Windows x64용 native tarball을 실제로 배포하며, 공식 published-package CI가 2026-07-16에 Windows x64 / Node 22.23.1에서 clean install, CommonJS·ESM import, 53개 테스트를 통과했다. 따라서 **upstream Node binding의 Windows x64 지원은 확인됨**으로 판정한다.

그러나 **RAGit의 Windows x64 정식 지원은 아직 조건부 No-Go**다. upstream CI는 RAGit packed artifact, Node 22.14/24, 기존 `0.2.x` store, Windows 경로·잠금, canonical store 바이트 불변성을 검증하지 않는다. 특히 공식 tarball로 만든 로컬 호환성 실험에서 `0.5.0`은 `0.2.1` store를 열고 질의했지만, `readOnly: true`로 열었음에도 legacy FLAT index 파일의 바이트를 변경했다. 기존 copy-on-write 격리를 제거할 근거가 없고, store 전환은 명시적 백업·검증·롤백 경계를 가져야 한다.

권고는 다음과 같다.

1. 목표 후보는 `@zvec/zvec@0.5.0`을 정확 버전으로 고정한다.
2. `0.3.0`/`0.3.1`은 알려진 Windows cross-drive path 결함 때문에 후보로 삼지 않는다. 그 수정이 포함된 최초 Node 패키지는 `0.3.2`이지만, 최신 안정판 목표에는 참고 기준일 뿐이다.
3. 아래 RAGit 전용 gate를 모두 통과하기 전에는 `win32/x64` 또는 `linux/x64`를 정식 매트릭스에 추가하지 않는다.
4. 기존 MCP/query의 copy-on-write store clone은 legacy store read-only 바이트 불변성이 별도로 입증되기 전까지 유지한다.

## 증거 수준

- **확인됨 — 공식**: npm registry/package tarball, zvec 공식 source/release/issue/CI가 직접 보여 주는 사실
- **확인됨 — 재현 실험**: 공식 npm tarball만 사용해 이 조사에서 직접 재현한 결과. 실험 환경과 한계를 함께 기록한다.
- **추론**: 확인 사실에서 합리적으로 도출되지만 upstream이 지원 계약으로 명시하지 않은 내용
- **미확인**: 정식 지원 결정 전에 RAGit CI 또는 별도 fixture로 검증해야 하는 내용

## 1. 배포 버전과 core/Node 버전의 차이

[npm registry packument](https://registry.npmjs.org/@zvec%2Fzvec)의 `latest` dist-tag는 `0.5.0`이며, 0.2.1 이후의 안정판은 다음과 같다.

| Node 패키지 | npm 배포 시각 (UTC) | native target | 주요 변화/주의점 |
| --- | --- | --- | --- |
| 0.2.1 | 2026-02-26 | Darwin ARM64, Linux ARM64/x64 | Windows 없음. native dependency는 `^0.2.0` |
| 0.2.2 | 2026-03-10 | 동일 | native dependency는 `^0.2.2` |
| 0.2.3 | 2026-03-12 | 동일 | native dependency를 `0.2.3` exact로 전환 |
| 0.3.0 | 2026-04-03 | 위 3개 + Windows x64 | 최초 Windows tarball. 알려진 cross-drive path 결함 존재 |
| 0.3.1 | 2026-04-10 | 동일 | Node submodule은 여전히 core 0.3.0 |
| 0.3.2 | 2026-04-17 | 동일 | core 0.3.1 path fix를 포함한 최초 Node 패키지 |
| 0.4.0 | 2026-05-09 | 동일 | ESM entry/types와 export map 추가 |
| 0.4.1 | 2026-05-25 | 동일 | async API와 여러 binding 보강 |
| 0.5.0 | 2026-06-12 | 동일 | npm 최신. FTS, DiskANN, multi-query 및 API 확장 |

확인된 중요한 version skew는 다음과 같다.

- RAGit이 고정한 wrapper `@zvec/zvec@0.2.1`의 source commit은 core submodule을 `v0.2.0`에 두고 있다. 뒤에 발표된 [core `v0.2.1` 릴리스](https://github.com/alibaba/zvec/releases/tag/v0.2.1)와 동일한 배포물이 아니다.
- Node `0.3.1`은 core `0.3.0`을, Node `0.3.2`는 core `0.3.1`을 포함한다. core와 Node의 patch 번호를 서로 대체해서 읽으면 안 된다. 각 npm tarball의 `gitHead`와 [zvec-node tag](https://github.com/zvec-ai/zvec-node/tags)를 기준으로 판단해야 한다.
- core의 최신 릴리스는 [v0.5.1](https://github.com/alibaba/zvec/releases/tag/v0.5.1)이지만, registry에는 wrapper/native 모두 `0.5.0`까지만 있다. `v0.5.1`의 storage·index fix를 Node 사용자가 받았다고 간주할 수 없다.

RAGit의 기존 store 기준선도 하나가 아니다. 현재 `pnpm-lock.yaml`은 wrapper `0.2.1`과 native `0.2.0`을 잠그지만, wrapper의 `^0.2.0` 선언 때문에 lockfile 없는 registry 설치는 native `0.2.2` 또는 `0.2.3`을 선택할 수 있다. 호환성 fixture는 최소한 다음 세 조합을 모두 포함해야 한다.

- wrapper `0.2.1` + native `0.2.0`
- wrapper `0.2.1` + native `0.2.2`
- wrapper `0.2.1` + native `0.2.3`

## 2. `0.5.0` 실제 native artifact

[0.5.0 package manifest](https://github.com/zvec-ai/zvec-node/blob/v0.5.0/package.json)은 다음 네 optional native package를 exact `0.5.0`으로 선언한다.

- `@zvec/bindings-darwin-arm64`
- `@zvec/bindings-linux-arm64`
- `@zvec/bindings-linux-x64`
- `@zvec/bindings-win32-x64`

확인된 artifact 식별자는 다음과 같다.

| 패키지 | registry integrity | tarball 내용/제약 |
| --- | --- | --- |
| `@zvec/zvec@0.5.0` | `sha512-00moPv7j7YByeoEdLbitGfd7GO9+dZrPex91S6htmB4ZYbmvdyxz3VWXYuIPnjiE7YPZoY6rdAEFk7MEfMnzxQ==` | JS/CJS·ESM entry, types, installer. [tarball](https://registry.npmjs.org/@zvec/zvec/-/zvec-0.5.0.tgz) |
| `@zvec/bindings-win32-x64@0.5.0` | `sha512-EkpcCO4IEDhXYejrQPIgXO49vdicQl3vCsFn3AV/oRPjLsR4lgRCncveq4ejWRdnIIIzZX6nX0rZQ1V0KPJ62A==` | `os: win32`, `cpu: x64`, PE native addon과 Jieba 사전. [tarball](https://registry.npmjs.org/@zvec/bindings-win32-x64/-/bindings-win32-x64-0.5.0.tgz) |

Windows x64 package는 `0.3.0`부터 `0.5.0`까지 매 버전에 실제로 존재한다. 반면 Darwin x64, Windows ARM64, Linux 이외 Unix target은 Node optional dependency에 없다. [Darwin x64 prebuilt 요청](https://github.com/alibaba/zvec/issues/572)도 2026-07-16 현재 열려 있다. core 릴리스가 언급하는 Android/iOS/RISC-V는 Node npm target이 아니므로 RAGit 지원 매트릭스에 포함해서는 안 된다.

## 3. Windows x64 지원 증거

### 확인됨 — 공식

- [core v0.3.0 release](https://github.com/alibaba/zvec/releases/tag/v0.3.0)는 Windows native 지원, MSVC 2022/Visual Studio 17+, Windows용 Python/Node package와 Windows CI를 명시한다.
- `@zvec/bindings-win32-x64`는 `0.3.0`부터 실제 npm tarball로 배포됐다.
- [2026-07-16 published-package run](https://github.com/zvec-ai/zvec-node/actions/runs/29468720813)의 [Windows job](https://github.com/zvec-ai/zvec-node/actions/runs/29468720813/job/87527358725)은 clean temp project에서 `@zvec/zvec@latest`를 설치했고 실제 설치 버전 `0.5.0`, `win32/x64`, Node `22.23.1`을 기록했다.
- 같은 Windows job은 CommonJS `require`, ESM `import`, schema/create/open, insert/upsert/update/delete/fetch/query, close/destroy를 포함한 4 suite를 실행해 **53 passed, 2 skipped**로 끝났다. 사용한 workflow는 [공식 source](https://github.com/zvec-ai/zvec-node/blob/54a34cd9487e67cd8367ff8533f4e225097e807f/.github/workflows/test-published.yml)에 고정돼 있다.
- [lifecycle test](https://github.com/zvec-ai/zvec-node/blob/v0.5.0/tests/collection/lifecycle.test.ts)는 `closeSync()` 후 사용 거부와 `destroySync()` 뒤 directory 제거를 검증한다. 이 suite가 Windows에서 통과했으므로 기본 handle release와 test directory cleanup은 확인됐다.
- Windows package의 `zvec_node_binding.node` PE import table은 `KERNEL32.dll`, `SHELL32.dll`, `SHLWAPI.dll`, `RPCRT4.dll`, `ole32.dll`, `dbghelp.dll`만 참조하고 별도 MSVC runtime DLL은 참조하지 않았다. 공식 published-package Windows job도 추가 system package를 설치하지 않는다. 따라서 **prebuilt 사용에는 별도 Visual C++ Redistributable이 필요하지 않은 것으로 확인**되며, MSVC/CMake 요구사항은 source build용이다.

### Windows에서 이미 발견되고 수정된 결함

`0.3.0`에는 process CWD와 collection이 서로 다른 drive에 있을 때 bare drive root를 directory로 만들려다 실패하는 결함이 있었다. [공식 issue](https://github.com/alibaba/zvec/issues/333)와 [core v0.3.1 release](https://github.com/alibaba/zvec/releases/tag/v0.3.1)는 cross-drive path 처리 및 Windows error message 수정을 기록한다. 이 core fix는 Node `0.3.2`부터 포함되며 `0.5.0`에도 존재한다.

### 미확인 — RAGit 정식 지원을 막는 항목

upstream Windows 통과만으로 아래를 알 수 없다.

- RAGit packed CLI/MCP의 install → init → ingest → query/context/status 전체 흐름
- RAGit 최소 Node 22.14.0과 호환 lane Node 24
- wrapper `0.2.1`/native `0.2.x`가 만든 기존 store의 Windows reopen 및 query
- macOS/Linux에서 만든 store를 Windows로 옮겨 여는 cross-platform portability
- `C:`/`D:` cross-drive, 공백·한글·긴 경로, read-only clone이 system temp와 다른 drive에 놓이는 경우
- CLI/MCP 동시 read, writer 배제, close 후 rename/delete와 프로세스 비정상 종료 뒤 lock recovery
- read-only open 전후 canonical store 전체 file tree의 바이트 불변성

따라서 upstream Windows 지원은 RAGit Windows 검증을 시작할 충분한 근거이지, RAGit 지원 선언의 대체 증거가 아니다.

## 4. Node engine과 native ABI

### 확인됨 — 공식

- `0.2.1`부터 `0.5.0`까지 wrapper/native package manifest에는 `engines.node`가 없다. npm 설치 자체가 Node 최소/최대 버전을 제한하지 않는다.
- binding source는 [`NODE_API_MODULE`](https://github.com/zvec-ai/zvec-node/blob/v0.5.0/src/binding/addon.cc#L42)과 `node-addon-api`를 사용한다. 공식 native binary도 `napi_register_module_v1`을 export한다.
- `0.5.0` build/published-package workflow는 Node 22.x만 사용한다. 현재 Windows 통과 버전은 Node 22.23.1이다. upstream은 Node 22.14 또는 Node 24 runtime matrix를 제공하지 않는다.

### 추론

Node-API entry 사용은 binary가 V8의 `NODE_MODULE_VERSION`마다 다시 빌드되는 전통적 addon보다 ABI 호환성이 넓다는 근거다. 그러나 package가 N-API/Node 최소 버전을 계약으로 선언하지 않고 upstream runtime CI도 Node 22 하나뿐이므로, 이것을 RAGit의 Node 22.14/24 지원 보증으로 간주할 수는 없다.

### 확인됨 — 재현 실험

macOS ARM64에서 공식 `0.5.0` tarball을 Node `22.14.0`과 `24.18.0`으로 각각 load하고 기존 store를 열어 FLAT query를 실행했다. 두 버전 모두 같은 hit를 반환했다. CommonJS와 ESM entry도 양쪽에서 load됐다. 이는 후보의 ABI 가능성을 높이지만 Windows/Linux 각 target CI를 대신하지 않는다.

## 5. native prerequisite와 target별 주의점

### Linux

- [0.5.0 publish workflow](https://github.com/zvec-ai/zvec-node/blob/v0.5.0/.github/workflows/publish.yml)는 x64/ARM64를 `manylinux_2_28` image에서 빌드하고 `libaio-devel`을 설치한다.
- 현재 [published-package workflow](https://github.com/zvec-ai/zvec-node/blob/54a34cd9487e67cd8367ff8533f4e225097e807f/.github/workflows/test-published.yml)는 Linux lane에 `libaio-dev`를 설치한다.
- Linux x64 addon은 `GLIBC_2.28` symbol을 요구한다. `libaio.so.1`은 base addon이 아니라 x64 tarball에만 포함된 `libzvec_diskann_plugin.so`의 direct dependency다. RAGit은 FLAT index만 쓰지만, upstream 검증 계약이 설치하는 동안에는 `libaio` prerequisite를 유지하는 편이 안전하다.
- 2026-06-13의 [Ubuntu 24 x64 run](https://github.com/zvec-ai/zvec-node/actions/runs/27466406787)은 import와 54개 test를 통과했지만 DiskANN plugin 초기화 test 하나가 실패했다. upstream은 이어서 x64 runner를 [Ubuntu 22.04로 변경](https://github.com/zvec-ai/zvec-node/commit/54a34cd9487e67cd8367ff8533f4e225097e807f)했다. RAGit이 Ubuntu 24 x64를 지원하려면 FLAT-only packed flow를 자체 CI에서 다시 증명해야 한다.

### macOS

- Node prebuilt는 ARM64만 있다.
- `0.5.0` Darwin addon의 Mach-O deployment target은 macOS `15.0`이고 시스템 `libc++`/`libSystem`만 링크한다.
- 조사한 기존 native `0.2.0`/`0.2.2`/`0.2.3` artifact는 deployment target `26.0`으로 빌드돼 있었다. `0.5.0`은 이 artifact-level floor를 낮춘다. 다만 package manifest가 macOS version을 계약으로 선언하지 않으므로 RAGit은 문서화할 최소 OS를 CI runner 증거로 별도 결정해야 한다.

### Windows

- prebuilt runtime은 Windows x64만 있다. 32-bit와 ARM64는 없다.
- source build에는 upstream이 명시한 MSVC 2022/Visual Studio 17+와 CMake가 필요하지만, prebuilt install에는 공식 CI상 별도 system dependency가 없다.
- [초기 Windows 지원 issue](https://github.com/alibaba/zvec/issues/23)는 Win10, Server 2022/2025에서의 테스트를 언급하지만, 지원 가능한 최소 Windows version을 package metadata로 계약하지 않는다.

### CPU instruction set

표준 hosted runner 통과는 모든 x64 CPU를 보장하지 않는다. 오래된 x64 CPU에서 Node SDK가 crash했다는 [공식 issue](https://github.com/alibaba/zvec/issues/512)는 instruction trace가 제출되지 않아 2026-07-15 수정 없이 닫혔다. 과거 Broadwell AVX-512 SIGILL [issue](https://github.com/alibaba/zvec/issues/92)도 존재한다. RAGit은 최소 CPU를 선언하지 않는다면 최소한 hosted runner profile만 보장한다고 명시하거나 별도 old-CPU probe를 둬야 한다.

## 6. RAGit 사용 API와 type delta

RAGit은 다음 sync API만 사용한다.

- `ZVecInitialize`
- `ZVecCollectionSchema`, `schema.fields()`, `schema.vectors()`
- `ZVecCreateAndOpen`, `ZVecOpen`
- `upsertSync`, `fetchSync`, `querySync`, `closeSync`
- `ZVecDataType`, `ZVecIndexType.FLAT/INVERT`, `ZVecMetricType.COSINE`

0.2.1 → 0.5.0에서 RAGit에 직접 관련된 변화는 다음과 같다.

- `0.3.0`에서 `ZVecIndexType.IVF`는 `3 → 2`, `FLAT`은 `4 → 3`으로 numeric value가 바뀌고 `HNSW_RABITQ=4`가 추가됐다.
- `0.4.0`부터 CJS와 별도의 ESM entry, `.d.mts`, conditional exports가 제공된다.
- `0.4.1`은 async collection method를 추가하지만 기존 sync method를 유지한다.
- `0.5.0`은 DiskANN/FTS/multi-query 및 fetch output selection을 추가하고 `ZVecCollection` type 선언을 class에서 interface로 바꾸지만, RAGit이 쓰는 sync signature는 유지한다.
- `0.5.0`이 반환하는 FLAT/INVERT schema에는 `quantizeType`, `enableRangeOptimization`, `enableExtendedWildcard` 같은 property가 추가된다. RAGit schema normalizer는 자신이 비교하는 name/dataType/dimension/indexType/metricType만 사용하므로 이 추가 property에는 영향받지 않는다.

### 확인됨 — 재현 실험

- TypeScript 5.9.3에서 현재 `src/core/zvec.ts`를 `0.5.0` declaration에 매핑해 type-check한 결과 diagnostic은 0개였다.
- RAGit이 사용하는 schema/create/open/upsert/fetch/query/close 계약을 별도 in-memory TypeScript contract로 검사한 결과도 diagnostic 0개였다.
- macOS ARM64에서 동일 호출을 `0.5.0` runtime으로 실행해 정상 동작을 확인했다.

따라서 현재 source 호출부에는 명백한 compile-time API blocker가 없다. 다만 enum numeric 변경과 native storage 내부 해석은 type-check로 검증할 수 없으므로 store gate가 별도로 필요하다.

## 7. on-disk store 호환성 및 read-only 동작

upstream README/release/test에는 `0.2.x` store를 `0.5.0`이 열 수 있다는 명시적 compatibility contract나 fixture가 없다. 아래 결과는 공식 npm artifact를 사용한 직접 실험이다.

### 실험 환경과 방법

- macOS 26 ARM64, Node 22.22.3
- baseline wrapper `@zvec/zvec@0.2.1`
- baseline native `@zvec/bindings-darwin-arm64@0.2.0`, `0.2.2`, `0.2.3` 각각
- candidate wrapper/native `0.5.0`
- RAGit과 같은 FLAT/COSINE vector schema와 INVERT scalar fields를 가진 `documents`, `chunks` collection 생성
- record upsert → query → close 후 store 복사
- 모든 file path/content SHA-256 기록
- `0.5.0`의 `ZVecOpen(..., { readOnly: true, enableMMAP: true })` → schema 확인 → query → close
- 전후 file tree 비교, 이후 writable upsert와 old runtime rollback reopen도 확인

### 확인됨 — 재현 실험

1. `0.5.0`은 baseline native `0.2.0`, `0.2.2`, `0.2.3`이 각각 만든 store를 모두 열었고 기존 record를 query했다.
2. `0.2.0` store의 old schema에서 FLAT은 numeric `4`였지만, `0.5.0` reopen 후 `schema.vectors()`는 FLAT `3`으로 정상 노출됐고 RAGit의 현재 schema 비교 shape와 일치했다.
3. `0.5.0`으로 기존 store에 새 record를 writable upsert한 뒤 `0.2.1`/native `0.2.0`으로 되돌려 기존·신규 record를 fetch/query할 수 있었다.
4. 그러나 `0.5.0`의 **read-only legacy reopen은 canonical byte invariant를 지키지 않았다**. 두 collection의 `0/embedding.index.2.proxima` content hash가 바뀌었다. 같은 copy를 `0.5.0`으로 다시 read-only open했을 때도 두 파일이 다시 바뀌었다.
5. `0.5.0` read-only legacy reopen에서는 이 실험상 RocksDB `CURRENT`/`MANIFEST`/`OPTIONS` rotation은 없었다. 반면 baseline `0.2.1`/native `0.2.0` read-only reopen은 Proxima 파일과 여러 RocksDB metadata/log를 모두 변경했다.
6. `0.5.0`으로 새로 만든 단순 store를 `0.5.0`으로 read-only reopen한 대조군에서는 file content 변화가 없었다. 관찰된 Proxima 변화는 적어도 legacy store 경로에 집중된다.

한 예에서 `chunks/0/embedding.index.2.proxima`는 `8e2b… → 4cd1…`, `documents/0/embedding.index.2.proxima`는 `5045… → 4def…`로 바뀌었다. 변경은 store metadata JSON이 아니라 native index 파일 내부에 있었다.

### 해석과 한계

- **확인 사실**: 작은 macOS fixture에서는 forward reopen/query와 제한된 rollback reopen이 성공했다.
- **추론**: format이 적어도 이 FLAT/INVERT shape에는 상호 이해 가능한 부분을 유지한다.
- **미확인**: 이것은 on-disk 호환성 보증이 아니다. 대형/multi-segment store, optimize/crash recovery, 모든 baseline OS/native 조합, cross-OS 이동, Windows lock semantics, concurrent reader/writer는 검증하지 않았다.
- **확인 사실**: `readOnly: true`는 legacy store의 전체 바이트 불변성을 뜻하지 않는다. 기존 RAGit copy-on-write clone을 제거하면 안 된다.
- **계획 영향**: 첫 read가 암묵적으로 canonical store를 바꾸게 하지 말고, upgrade 시 백업된 copy에서 reopen/query/tree hash/rollback을 검증한 뒤 명시적으로 전환하거나 재생성하는 절차를 결정해야 한다.

## 8. 알려진 이슈와 현재 범위에 대한 영향

| 이슈 | 상태 | RAGit 영향 |
| --- | --- | --- |
| Windows cross-drive path | core 0.3.1에서 수정 | 최신 0.5.0에는 포함. C:/D: 실제 RAGit temp/store 조합 재검증 필요 |
| legacy read-only file mutation | 이 조사에서 재현, upstream contract 없음 | copy-on-write 유지, 전체 store tree hash gate 필요 |
| Node engine 미선언 | 현재도 미선언 | Node 22.14/24를 RAGit CI가 소유해야 함 |
| Ubuntu 24 x64 DiskANN test | upstream 실패 후 x64 lane을 22.04로 변경 | RAGit은 FLAT만 쓰지만 Ubuntu 24 packed gate가 필요 |
| old x64 CPU crash | issue가 정보 부족으로 닫힘 | 지원 CPU 경계 또는 probe 필요 |
| Darwin x64 artifact 부재 | open issue | 계속 미지원 |
| core 0.5.1만 배포됨 | Node 0.5.1 없음 | core release note만 보고 candidate를 0.5.1로 표기하면 안 됨 |
| 0.5.x FTS/DiskANN 관련 open issue | 일부 존재 | 현재 FLAT/INVERT RAGit 경로에는 직접 해당하지 않지만, 사용하지 않는 기능을 지원 근거로 삼지 않음 |

## 9. 실제 검증 후보와 합격 기준

### 후보 선정

**Primary candidate: `@zvec/zvec@0.5.0` exact**

- 최신 npm stable이며 네 target artifact가 version-aligned exact dependency다.
- Windows path fix와 ESM support가 포함돼 있다.
- 공식 published-package Windows CI 증거가 있다.
- 목표가 최신 호환 안정판이므로 `0.4.1`을 먼저 채택할 이유는 현재 없다.

**Diagnostic fallback: `0.4.1`**

- `0.5.0`만의 FTS/DiskANN packaging 또는 regression을 분리할 때만 비교한다.
- fallback을 release target으로 선택하려면 별도 결정 티켓에서 최신 안정판 원칙을 예외 처리해야 한다.

**검증 제외**

- `0.3.0`/`0.3.1`: 알려진 Windows path fix가 Node package에 안전하게 포함되지 않았다.
- core `v0.5.1`: Node npm artifact가 없다.
- floating `latest`/caret: 조사와 구현 사이 registry drift 및 native mismatch를 허용한다.

### 필수 CI/packed gate

모든 lane은 workspace source가 아니라 실제 RAGit tarball과 npm native tarball을 설치해야 한다.

1. **Runtime/target**
   - `darwin/arm64`, `linux/arm64`, `linux/x64`, `win32/x64`
   - 각 target에서 Node `22.14.0`과 Node `24`
   - `process.platform/arch`, wrapper/native exact version, CJS/ESM import 확인
   - Linux는 `libaio`를 선언·설치하고 glibc floor를 기록
2. **Packed RAGit flow**
   - install → runtime guard → init → commit → ingest → query → context pack → status/doctor → MCP read tools
   - build/pack contract와 executable entry 모두 native binding을 올바른 순서로 load
3. **Legacy store matrix**
   - wrapper `0.2.1` + native `0.2.0`/`0.2.2`/`0.2.3` fixture
   - 기존 `ragit@1.1.2` registry baseline smoke와 실제 multi-segment fixture
   - schema, document/chunk count, exact IDs/fields, top-k order/score, snapshot binding 확인
   - `meta.json`/manifest뿐 아니라 `.ragit/store/**` 전체 path/content hash 전후 비교
4. **Store transition/rollback**
   - read-only command는 canonical store tree를 바꾸지 않음. clone 내부 변화만 허용
   - 첫 writable transition 전에 backup 생성 및 검증
   - candidate write 후 재open, process crash recovery, old runtime rollback 가능성 또는 명시적 No-Rollback 경계 검증
   - 실패 시 backup restore 또는 source/manifests에서 deterministic rebuild
5. **Windows-specific**
   - C:와 D: 각각에 repo/store/temp를 배치한 same-drive/cross-drive 조합
   - 공백, 한글, 긴 경로
   - close 후 rename/delete, CLI+MCP concurrent readers, writer exclusion, killed process 뒤 reopen
   - macOS/Linux baseline fixture를 Windows에서 복사해 reopen/query하는 cross-platform case
6. **Linux x64-specific**
   - Ubuntu 22.04와 현재 표준 Ubuntu 24.04에서 FLAT-only RAGit packed flow
   - import-only가 아니라 create/open/upsert/query/legacy reopen까지 실행

### Go / No-Go

`win32/x64` 정식 지원은 아래가 모두 참일 때만 Go다.

- Node 22.14와 24에서 packed CLI/MCP E2E 통과
- 네 target에서 동일 RAGit retrieval/store contract 통과
- 세 baseline native 변형의 기존 store가 데이터 손실·schema mismatch 없이 열림
- read-only 명령이 canonical store 전체 바이트를 바꾸지 않음
- Windows path/lock/cleanup/crash recovery 통과
- 명시적 migration/backup/rollback 또는 rebuild runbook 확정

다음 중 하나라도 발생하면 No-Go로 유지한다.

- native import crash/SIGILL 또는 target package 누락
- Windows Node 24 실패
- legacy store reopen/query 결과 불일치
- 명시적 migration 없이 canonical store가 read path에서 변경됨
- close 후 file handle이 남아 rename/delete/cleanup 실패
- C:/D:/Unicode 경로 중 하나라도 실패
- rollback 또는 deterministic rebuild가 증명되지 않음

## 최종 판정

- **zvec 0.5.0 Windows x64 upstream 지원**: 확인됨
- **현재 RAGit API의 0.5.0 compile/runtime 가능성**: 확인됨 (macOS 직접 실험 포함)
- **기존 RAGit store의 제한적 forward/backward reopen**: 확인됨 (작은 macOS fixture)
- **기존 store의 read-only 바이트 불변성**: 성립하지 않음
- **RAGit Windows x64 정식 지원**: RAGit-specific gate 전까지 No-Go
- **실제 검증 후보**: `@zvec/zvec@0.5.0` exact
- **store 전략 결정에 필요한 새 사실**: legacy store read-only open도 Proxima index를 변경하므로 copy-on-write 유지와 명시적 전환/백업/rollback 결정이 필수

## 1차 자료

- [npm `@zvec/zvec` packument](https://registry.npmjs.org/@zvec%2Fzvec)
- [npm Windows binding packument](https://registry.npmjs.org/@zvec%2Fbindings-win32-x64)
- [zvec-node v0.5.0 package manifest](https://github.com/zvec-ai/zvec-node/blob/v0.5.0/package.json)
- [zvec-node v0.5.0 binding source](https://github.com/zvec-ai/zvec-node/tree/v0.5.0/src/binding)
- [zvec v0.3.0 release](https://github.com/alibaba/zvec/releases/tag/v0.3.0)
- [zvec v0.3.1 release](https://github.com/alibaba/zvec/releases/tag/v0.3.1)
- [zvec v0.4.0 release](https://github.com/alibaba/zvec/releases/tag/v0.4.0)
- [zvec v0.5.0 release](https://github.com/alibaba/zvec/releases/tag/v0.5.0)
- [zvec v0.5.1 release](https://github.com/alibaba/zvec/releases/tag/v0.5.1)
- [latest official published-package CI](https://github.com/zvec-ai/zvec-node/actions/runs/29468720813)
- [Windows path issue](https://github.com/alibaba/zvec/issues/333)
- [old-CPU Node SDK issue](https://github.com/alibaba/zvec/issues/512)
- [Darwin x64 artifact request](https://github.com/alibaba/zvec/issues/572)
