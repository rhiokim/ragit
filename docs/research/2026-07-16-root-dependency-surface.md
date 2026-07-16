# 루트 CLI/MCP 의존성 업그레이드 표면 조사

- 조사 기준일: 2026-07-16 (KST)
- 대상: 루트 `package.json`의 runtime/build/test 직접 의존성
- 제외: `@zvec/zvec`, `apps/docs`, `tools/narrative-tui`
- 목적: 최신판을 무조건 채택하는 대신 현재 Node·ESM·MCP·빌드·테스트·패키지 계약을 보존하는 안전 목표와 검증 경계를 정한다.

## 결론

루트 의존성은 한 번에 최신화하지 않고 세 웨이브로 나누는 것이 안전하다.

1. **보안/동일 계열 갱신:** `vitest@4.1.10`, `tsx@4.23.1`, `tsdown@0.21.10`을 먼저 적용하고 잠금파일의 취약한 `picomatch`, `path-to-regexp`, `esbuild`, `vite`, `postcss`, `defu`를 패치 버전으로 해소한다. 특히 현재 직접 의존성 `vitest@4.0.18`은 critical advisory의 취약 범위다.
2. **런타임 major:** `commander@15.0.0`과 `zod@4.4.3`을 각각 CLI 계약과 MCP 프로토콜 계약으로 검증한다. Commander의 ESM-only 전환은 RAGit의 ESM-only 출력 및 Node `>=22.14.0`과 맞으며, Zod는 RAGit 소스가 직접 사용하지 않고 MCP SDK가 공식적으로 v4를 허용한다.
3. **컴파일러:** `tsdown@0.21.10` 위에서 `typescript@6.0.3`과 `@types/node@24.13.3`을 별도 웨이브로 검증한다. `typescript@7.0.2`와 `tsdown@0.22.8`은 이번 안전 목표에서 보류한다.

유지할 경계는 다음과 같다.

- `@modelcontextprotocol/sdk`는 production 지원선인 v1의 최신 안정판 `1.29.0`을 **exact pin**으로 유지한다. split-package v2는 조사 시점 beta다.
- `fast-glob@3.3.3`, `micromatch@4.0.8`, `@types/micromatch@4.0.10`은 이미 최신 안정판이므로 직접 버전은 유지한다.
- `@types/node`는 registry latest인 26.x로 올리지 않고 현재 검증된 LTS 축인 24.x에 머문다.
- `tsdown`은 Node 22.14 빌드 축을 보존하기 위해 0.21 계열의 최신 `0.21.10`까지만 올린다.
- TypeScript 7은 안정판이어도 아직 compiler program API가 없고 현재 선택한 tsdown 계열의 peer 범위 밖이므로 별도 향후 결정이다.

## 조사 방법과 판정 기준

- `latest stable`은 2026-07-16에 npm registry의 `dist-tags.latest`가 가리킨 버전이다. prerelease/canary/beta tag는 제외했다.
- `현재`는 선언 범위와 실제 설치 버전을 혼동하지 않도록 `package.json`의 specifier와 `pnpm-lock.yaml`의 root importer 해석 버전을 함께 적었다.
- npm version metadata의 `engines`, `peerDependencies`, `type`, `exports`, `types`/`typings`, `bin`, dependency ranges와 각 프로젝트의 공식 release/changelog/source를 대조했다.
- 저장소에서는 직접 import, `tsconfig.json`, `tsdown.config.ts`, `vitest.config.ts`, 빌드/런타임/pack/smoke 검증 스크립트와 CI 축을 확인했다.
- 보안은 npm의 공식 bulk advisory endpoint로 현재 root dependency graph를 검사했다. `pnpm audit`은 조사 시점 registry의 구 audit endpoint가 HTTP 410을 반환하므로 결과 근거로 사용하지 않았다.
- 애플리케이션 코드와 의존성은 변경하지 않았다. 후보 조합 설치와 구현은 후속 작업이다.

## 버전 의사결정표

| 직접 의존성 | 역할 | 선언 → 잠금 | 최신 안정판 | 잠금 대비 delta | 안전 목표 | 판정 |
| --- | --- | --- | --- | --- | --- | --- |
| `@modelcontextprotocol/sdk` | runtime/MCP | `1.29.0` → `1.29.0` | `1.29.0` | 없음 | `1.29.0` exact | 유지 |
| `commander` | runtime/CLI | `^14.0.1` → `14.0.3` | `15.0.0` | major | `^15.0.0` | 조건부 채택 |
| `fast-glob` | runtime/glob | `^3.3.3` → `3.3.3` | `3.3.3` | 없음 | `^3.3.3` | 유지, 전이 잠금 갱신 |
| `micromatch` | runtime/glob | `^4.0.8` → `4.0.8` | `4.0.8` | 없음 | `^4.0.8` | 유지, 전이 잠금 갱신 |
| `zod` | runtime/MCP peer | `^3.25.76` → `3.25.76` | `4.4.3` | major | `^4.4.3` | 조건부 채택 |
| `@types/micromatch` | type | `^4.0.10` → `4.0.10` | `4.0.10` | 없음 | `^4.0.10` | 유지 |
| `@types/node` | type | `^24.10.1` → `24.10.15` | `26.1.1` | major | `^24.13.3` | 24.x 유지, 26.x 보류 |
| `tsdown` | build | `^0.21.0` → `0.21.0` | `0.22.8` | minor(0.x breaking) | `^0.21.10` | 0.21 최신까지만 채택 |
| `tsx` | dev/script runner | `^4.20.6` → `4.21.0` | `4.23.1` | minor | `^4.23.1` | 채택 |
| `typescript` | build/type | `^5.9.3` → `5.9.3` | `7.0.2` | major 2회 | `^6.0.3` | 중간 목표 채택, 7.x 보류 |
| `vitest` | test | `^4.0.8` → `4.0.18` | `4.1.10` | minor | `^4.1.10` | 우선 채택 |

버전 근거는 각 package별 절과 [npm metadata 색인](#npm-metadata-색인)에 직접 연결했다.

## package별 변경 표면

### `@modelcontextprotocol/sdk`: `1.29.0` exact 유지

- npm metadata상 Node engine은 `>=18`, package는 ESM이면서 ESM/CJS conditional exports를 함께 제공한다. required peer는 `zod ^3.25 || ^4.0`이고 `@cfworker/json-schema`는 optional peer다. [npm metadata](https://registry.npmjs.org/%40modelcontextprotocol%2Fsdk/1.29.0)
- RAGit은 `server/index.js`, `server/stdio.js`, `types.js`를 runtime에서, `client/index.js`, `client/stdio.js`, `inMemory.js`를 test/pack smoke에서 사용한다. v1.29의 wildcard export가 이 deep import를 계속 수용한다.
- 공식 v1.29 release에는 typings export 보강, v1 npm audit fix, Windows stdio의 `windowsHide` fix가 포함됐다. [v1.29.0 release](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/v1.29.0)
- 공식 repository는 split-package v2를 beta로 표시하며 안정판 출시 전까지 v1.x를 production 지원선으로 명시한다. 따라서 별도 package들로의 v2 migration은 이번 직접 업그레이드가 아니다. [공식 README의 v2/v1 상태](https://github.com/modelcontextprotocol/typescript-sdk#readme)
- 현재 lock에는 SDK → Express/Router → `path-to-regexp@8.3.0`이 남아 있다. SDK version을 바꿀 수는 없지만 Router의 `^8.0.0` 범위는 패치된 8.4.x를 허용하므로 production subtree의 lock refresh가 필요하다.
- 검증 경계: MCP server/unit, protocol integration, packed MCP client/server smoke, repository byte-invariance, `dist/mcp.js` 초기 runtime guard.

### `commander`: `14.0.3` → `15.0.0`

- v15는 implementation을 CommonJS에서 ESM-only로 바꾸고 Node engine을 `>=22.12.0`으로 올렸다. RAGit은 `type: module`, tsdown `format: ["esm"]`, Node `>=22.14.0`이므로 module/engine 방향은 일치한다. [v15 changelog](https://github.com/tj/commander.js/blob/v15.0.0/CHANGELOG.md#1500-2026-05-29), [npm metadata](https://registry.npmjs.org/commander/15.0.0)
- 공개 `Command` named import와 RAGit이 사용하는 command/option/action APIs는 유지된다.
- v15의 별도 행동 breaking change는 positive/negative option을 함께 선언할 때 `--no-*` 기본값 계산이다. 현재 `src/cli.ts`에는 Commander의 `--no-*` option 선언이 없어 직접 충돌하지 않는다.
- Commander 14는 2027-05까지 security maintenance를 받으므로 v15 패키징 문제가 발견될 때 명확한 fallback이 있다.
- packaging 영향은 중요하다. RAGit tarball은 Commander를 external runtime dependency로 설치하고 ESM entry에서 불러오므로 Node 22.14의 실제 설치 smoke가 통과해야 한다.
- 검증 경계: CLI help/version/option parsing, CLI contract·snapshot·hardening tests, `build:verify`, `pack:verify`, `pack:smoke`, Node 22.14/24 runtime matrix.

### `fast-glob`: `3.3.3` 유지

- 현재와 registry latest가 같다. engine `>=8.6.0`, bundled typings와 현재 callable default import 형태도 바뀌지 않는다. [3.3.3 release](https://github.com/mrmlnc/fast-glob/releases/tag/3.3.3), [npm metadata](https://registry.npmjs.org/fast-glob/3.3.3)
- RAGit 사용은 async file listing과 `cwd`, `ignore`, `dot`, `onlyFiles` options뿐이다.
- 직접 package upgrade는 없지만 dependency range `micromatch ^4.0.8` 아래의 `picomatch ^2.3.1`이 현재 `2.3.1`로 잠겨 있다. patched `2.3.2`로 lock refresh해야 한다.
- 검증 경계: ingest file selection, repository scan, security control-plane scan, Windows path separator가 포함된 glob tests.

### `micromatch`: `4.0.8` 및 `@types/micromatch@4.0.10` 유지

- runtime과 types 모두 이미 registry latest다. [micromatch 4.0.8 release](https://github.com/micromatch/micromatch/releases/tag/4.0.8), [micromatch metadata](https://registry.npmjs.org/micromatch/4.0.8), [types metadata](https://registry.npmjs.org/%40types%2Fmicromatch/4.0.10)
- RAGit의 직접 API 표면은 `micromatch.isMatch(target, pattern)` 한 가지다. type package는 runtime/pack에 들어가지 않는다.
- `micromatch@4.0.8`의 `picomatch ^2.3.1` 범위가 현재 취약한 `2.3.1`을 해석하므로 `2.3.2` lock이 acceptance 조건이다. `fast-glob`과 같은 production glob 묶음으로 검증한다.
- deprecation signal은 runtime/types version metadata 모두 없다.

### `zod`: `3.25.76` → `4.4.3`, MCP 묶음으로 검증

- RAGit source/test/scripts에는 Zod 직접 import가 없다. 이 직접 의존성의 역할은 MCP SDK required peer를 만족시키는 것이다.
- SDK v1 공식 문서는 내부적으로 `zod/v4`를 import하면서 project peer로 Zod 3.25+와 4를 모두 지원한다고 명시하고, npm peer range도 `^3.25 || ^4.0`이다. [SDK v1 README](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x#installation)
- 따라서 root import API migration은 없지만, SDK의 protocol schema가 실행하는 Zod v4 구현은 3.25.76에 동봉된 초기 v4에서 4.4.3으로 바뀐다. validation error/record/default/object semantics의 변화 가능성은 MCP tests로 확인해야 한다.
- Zod 4 공식 migration guide에는 error customization, default 적용, object strictness, record, generic/type 구조 등 breaking/deprecation이 정리되어 있다. RAGit이 직접 해당 API를 쓰지는 않지만 SDK schema 행동 회귀의 점검 목록이다. [Zod 4 migration guide](https://zod.dev/v4/changelog), [v4.4.3 release](https://github.com/colinhacks/zod/releases/tag/v4.4.3), [npm metadata](https://registry.npmjs.org/zod/4.4.3)
- 검증 경계: MCP invalid-input normalization, `CallToolResultSchema`, list/call tool protocol integration, packed MCP smoke, generated declaration 변화.

### `@types/node`: 26.x 대신 `24.13.3`

- registry latest `26.1.1`은 `undici-types ~8.3.0`과 Node 26 API surface를 제공한다. Node 26은 조사 시점 Current이고, RAGit CI/공개 release contract는 Node 22.14와 Node 24 LTS다. [Node 공식 release 상태](https://nodejs.org/en/about/previous-releases), [26.1.1 metadata](https://registry.npmjs.org/%40types%2Fnode/26.1.1)
- DefinitelyTyped는 `@types` major/minor가 대응 library의 major/minor를 따르는 versioning 원칙을 설명한다. [DefinitelyTyped versioning](https://github.com/DefinitelyTyped/DefinitelyTyped#how-do-definitely-typed-package-versions-relate-to-versions-of-the-corresponding-library)
- 따라서 26.x 채택은 아직 검증하지 않은 Node 26 API를 compile-time에 허용한다. 현재 24.x 계열의 최신 `24.13.3`까지만 올리고 `undici-types`도 7.x 계열에 둔다. [24.13.3 metadata](https://registry.npmjs.org/%40types%2Fnode/24.13.3)
- 잔여 위험: 24.x types도 최소 runtime인 Node 22.14 API를 엄격하게 제한하지는 않는다. 이를 완전히 해소하려면 minimum-runtime types 전략 또는 API compatibility lint라는 별도 정책 결정이 필요하다. 이번 연구는 기존 24.x 선택을 넓히지 않는 선에서 멈춘다.
- 검증 경계: TypeScript/tsdown declaration build, Node 22.14 runtime matrix, `node:` API가 많은 integration tests. type package는 tarball runtime dependency가 아니어야 한다.

### `tsdown`: latest `0.22.8` 대신 `0.21.10`

- 현재 resolved `0.21.0`에서 같은 0.21 line의 최신 `0.21.10`으로 갱신할 수 있다. engine은 계속 `>=20.19.0`이고 TypeScript peer는 `^5 || ^6`이다. 내부 Rolldown과 declaration plugin이 갱신되며 `defu ^6.1.7`을 요구해 현재 보안 문제도 해소한다. [v0.21.10 release](https://github.com/rolldown/tsdown/releases/tag/v0.21.10), [0.21.10 metadata](https://registry.npmjs.org/tsdown/0.21.10)
- latest `0.22.8`의 engine은 `^22.18.0 || >=24.11.0`이다. RAGit은 Node 22.14 축에서 install/test/build/pack을 실행하므로 그대로 채택할 수 없다. [0.22.8 metadata](https://registry.npmjs.org/tsdown/0.22.8)
- 0.22.0은 Node floor 외에도 config loader 변경, `declaration: true` 기반 dts auto-enable, shebang 기반 `exports.bin` auto-detection을 breaking으로 기록한다. RAGit은 `declaration: true`, 명시적 `dts: true`, 두 shebang entry와 두 개의 `package.json.bin` mapping을 가지므로 build/pack 계약 표면이 크다. [v0.22.0 migration guide](https://github.com/rolldown/tsdown/releases/tag/v0.22.0)
- 0.21.10에서도 Rolldown/declaration emitter가 크게 이동하므로 단순 patch로 취급하지 않고 output file list, shebang, executable bit, `.d.ts`, source map, optional zvec lazy-load를 모두 비교한다.
- 검증 경계: `build`, `build:verify`, `pack:verify`, `pack:smoke`, `pack:upgrade-smoke`; 특히 17-file tarball allowlist와 `dist/cli.js`/`dist/mcp.js`의 executable/shebang.

### `tsx`: `4.21.0` → `4.23.1`

- Node engine은 계속 `>=18`; RAGit Node floor와 충돌하지 않는다. package는 ESM loader/CLI와 CJS/ESM API subpaths를 유지한다. [npm metadata](https://registry.npmjs.org/tsx/4.23.1)
- 4.22에서 esbuild 0.28로 이동했고 4.23.1은 loader/watch correctness와 lazy loading을 보강했다. [v4.22.0 release](https://github.com/privatenumber/tsx/releases/tag/v4.22.0), [v4.23.1 release](https://github.com/privatenumber/tsx/releases/tag/v4.23.1)
- RAGit에서는 `ragit`, `mcp`, `dev`, benchmark scripts를 실행하는 개발 도구이고 packed runtime에는 들어가지 않는다.
- 현재 `esbuild@0.27.3`은 Windows dev server file-read advisory 범위다. `tsx@4.23.1`의 `esbuild ~0.28.0`을 patched `0.28.1`로 해석하는 것이 acceptance 조건이다.
- 검증 경계: `pnpm ragit --help`, `pnpm mcp --help`, benchmark TypeScript entry 최소 실행, test transform, lock의 platform별 esbuild optional packages, tarball dependency 비포함.

### `typescript`: latest `7.0.2` 대신 중간 목표 `6.0.3`

- TypeScript 7은 Go native port로 약 10배 성능 향상을 제공하지만, 7.0은 programmatic compiler API를 제공하지 않는다. 공식 release는 API 의존 도구를 위해 별도 TypeScript 6 compatibility package/alias를 안내한다. [TypeScript 7 공식 release](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/), [7.0.2 metadata](https://registry.npmjs.org/typescript/7.0.2)
- npm package shape도 JS compiler의 `typings`/`tsserver`에서 native platform packages와 `tsc` 중심으로 크게 바뀐다. 선언 생성을 수행하는 build toolchain에 단독으로 넣을 수 없다.
- TypeScript 6은 5.9 API compatibility를 유지하는 transition release이면서 향후 제거될 options/behaviors를 deprecate한다. 현재 RAGit config의 `target: ES2022`, `module: ESNext`, `moduleResolution: Bundler`, explicit `types: ["node"]`는 대표 제거 항목과 충돌하지 않는다. [TypeScript 6 release notes](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html), [6.0.3 metadata](https://registry.npmjs.org/typescript/6.0.3)
- local `tsc --noEmit` probe에서는 5.9.3, 6.0.3, 7.0.2가 같은 기존 diagnostics를 냈다. baseline 자체가 green gate가 아니므로 이 결과는 호환성 증명이 아니라 “새 compiler 고유 diagnostic은 관찰되지 않음” 정도로만 해석한다.
- 안전 경로는 `tsdown@0.21.10`을 먼저 고정한 뒤 TypeScript 6.0.3을 별도 commit/wave로 적용해 emitted declarations와 build/pack을 비교하는 것이다. TypeScript 7은 tsdown 0.22+의 Node floor 및 compiler API 소비자 상태를 다시 결정할 때 다룬다.

### `vitest`: `4.0.18` → `4.1.10` 우선

- engine은 양쪽 모두 `^20 || ^22 || >=24`; RAGit Node 22.14/24 축과 맞는다. 4.1은 Vite 8 support와 installed Vite reuse, test tags, reporters/coverage 등을 추가한 minor다. [Vitest 4.1 announcement](https://vitest.dev/blog/vitest-4-1.html), [v4.1.10 release](https://github.com/vitest-dev/vitest/releases/tag/v4.1.10), [npm metadata](https://registry.npmjs.org/vitest/4.1.10)
- 현재 config가 쓰는 `vitest/config`, `configDefaults`, `defineConfig`, forks pool, `no-isolate`, single-worker flags는 최신 public surface에 남아 있다.
- 4.1은 일부 spy assertion alias를 deprecate했지만 RAGit tests에는 해당 `toBeCalled*`/`toBeReturned*` 사용이 없다.
- 직접 보안 동기가 있다. 공식 advisory는 `vitest >=4.0.0 <4.1.0`에서 UI server가 listen할 때 arbitrary file read/execution이 가능하고 first patched가 4.1.0이라고 명시한다. RAGit script는 `vitest run`만 사용해 해당 server 노출은 기본 경로가 아니지만, 취약 직접 의존성을 유지할 이유는 없다. [Vitest security advisory](https://github.com/vitest-dev/vitest/security/advisories/GHSA-5xrq-8626-4rwp)
- 4.1.10은 Vite `^6 || ^7 || ^8`을 허용한다. resolver가 Vite 8을 조용히 선택하게 두지 말고 먼저 patched 7.x(`7.3.6`)로 잠가 change surface를 제한한다. Vite 8은 별도 major 결정이다.
- 검증 경계: 전체 test suite, snapshot byte diff, mock/timeout/teardown behavior, CI output에 새 agent/GitHub reporter가 주는 비기능적 변화, Node 22.14/24.

## 현재 보안 및 deprecation 신호

현재 root graph를 npm bulk advisory API로 조회하면 아래 항목이 매치된다. 전이 package는 직접 upgrade가 어떻게 해소하는지에 한해서만 적었다.

| 현재 package/path | 신호 | patched floor | 이번 계획의 해소 방식 |
| --- | --- | --- | --- |
| `vitest@4.0.18` (직접) | critical, UI server file read/execution ([GHSA-5xrq-8626-4rwp](https://github.com/vitest-dev/vitest/security/advisories/GHSA-5xrq-8626-4rwp)) | `4.1.0` | 직접 `4.1.10` |
| `picomatch@2.3.1` (`fast-glob`/`micromatch`) | high ReDoS + medium method injection ([GHSA-c2c7-rcm5-vvqj](https://github.com/micromatch/picomatch/security/advisories/GHSA-c2c7-rcm5-vvqj), [GHSA-3v7f-55p6-f55p](https://github.com/micromatch/picomatch/security/advisories/GHSA-3v7f-55p6-f55p)) | `2.3.2` | 현 직접 ranges 안에서 lock refresh |
| `picomatch@4.0.3` (`tsdown`/`vitest`/`vite`) | 같은 advisories | `4.0.4` | `tsdown`/`vitest` 갱신과 lock refresh, 최소 `4.0.5` 권고 |
| `path-to-regexp@8.3.0` (SDK → Express → Router) | high/moderate DoS ([GHSA-j3q9-mxjg-w52f](https://github.com/pillarjs/path-to-regexp/security/advisories/GHSA-j3q9-mxjg-w52f), [GHSA-27v5-c462-wpq7](https://github.com/pillarjs/path-to-regexp/security/advisories/GHSA-27v5-c462-wpq7)) | `8.4.0` | SDK pin 유지, Router의 허용 range 안에서 `8.4.2` lock |
| `esbuild@0.27.3` (`tsx`/`vite`) | low, Windows dev server arbitrary file read ([GHSA-g7r4-m6w7-qqqr](https://github.com/evanw/esbuild/security/advisories/GHSA-g7r4-m6w7-qqqr)) | `0.28.1` | `tsx@4.23.1` 및 patched Vite subtree에서 `0.28.1` lock |
| `vite@7.3.1` (`vitest`) | Windows path/UNC 및 dev-server file exposure advisories ([GHSA-fx2h-pf6j-xcff](https://github.com/vitejs/vite/security/advisories/GHSA-fx2h-pf6j-xcff), [GHSA-v6wh-96g9-6wx3](https://github.com/vitejs/launch-editor/security/advisories/GHSA-v6wh-96g9-6wx3)) | 7.x는 `7.3.5` | Vitest subtree를 `7.3.6`에 잠금; 8.x 자동 선택 금지 |
| `postcss@8.5.6` (`vite`) | moderate XSS in stringify ([GHSA-qx2v-qp2m-jg93](https://github.com/postcss/postcss/security/advisories/GHSA-qx2v-qp2m-jg93)) | `8.5.10` | Vite subtree lock refresh, `8.5.19` 가능 |
| `defu@6.1.4` (`tsdown`) | high prototype pollution ([GHSA-737v-mqg7-c878](https://github.com/unjs/defu/security/advisories/GHSA-737v-mqg7-c878)) | `6.1.5` | `tsdown@0.21.10`이 `defu ^6.1.7` 요구 |

노출도를 구분하면 `picomatch@2`는 사용자가 제공하는 glob 처리의 production path이고 `path-to-regexp`는 installed production subtree지만 현재 stdio-only MCP에서는 HTTP router가 직접 사용되지 않는다. 나머지는 build/test/dev server graph다. 노출도가 낮더라도 lock에서 제거되는 것을 acceptance 조건으로 삼는다.

검토한 현재/목표 직접 version metadata에는 npm `deprecated` field가 없었다. 단, TypeScript 6, Zod 4, Vitest 4.1은 공식 문서에 API별 deprecation이 있으므로 package-level deprecation 부재와 API deprecation 부재를 같은 뜻으로 보지 않는다.

## 함께 올릴 묶음과 순서

### Wave A — 보안 및 동일 compatibility line

- `tsdown ^0.21.10`
- `tsx ^4.23.1`
- `vitest ^4.1.10`
- 직접 버전이 그대로인 SDK/fast-glob/micromatch까지 root subtree lock refresh
- 잠금 acceptance:
  - `picomatch@2.3.2`
  - `picomatch@4.0.5` 이상
  - `path-to-regexp@8.4.2`
  - `esbuild@0.28.1`
  - root Vitest subtree `vite@7.3.6`
  - `postcss@8.5.10` 이상
  - `defu@6.1.7`

이 웨이브에서는 Commander, Zod, TypeScript major를 섞지 않는다. 실패 시 test runner/build runner/lock refresh 중 어디가 원인인지 분리할 수 있어야 한다.

### Wave B — runtime major 두 개를 각각 독립 commit으로

1. `commander ^15.0.0`
2. `zod ^4.4.3` (`@modelcontextprotocol/sdk@1.29.0` exact와 함께 검증)

두 변경은 서로 dependency 관계가 없으므로 같은 commit으로 묶지 않는다. Commander는 CLI/packaging, Zod는 MCP validation/protocol을 각각 독립적으로 회귀시킬 수 있다.

### Wave C — compiler/type toolchain

- 선행: Wave A의 `tsdown@0.21.10`
- 함께: `typescript ^6.0.3`, `@types/node ^24.13.3`
- 보류: `typescript@7.0.2`, `@types/node@26.1.1`, `tsdown@0.22.8`

TypeScript 6과 Node types는 compile/declaration diagnostics를 함께 바꿀 수 있으므로 한 웨이브에서 보되, failure triage를 위해 lock diff와 emitted `.d.ts` diff를 별도로 기록한다.

## 유지할 pin과 버전 정책

- **exact 유지:** `@modelcontextprotocol/sdk@1.29.0`. production v1 API/프로토콜 선택 자체가 release contract다.
- **major line 유지:** `@types/node@24`; Node 26 CI/support 결정 전에는 registry latest를 추종하지 않는다.
- **0.x minor line 유지:** `tsdown@0.21`; `^0.21.10`은 0.22 breaking/engine floor를 받아들이지 않는다.
- **중간 compiler line:** TypeScript는 6.0.3까지. 7.x는 단순 major bump가 아니라 native toolchain/API migration ticket이어야 한다.
- **이미 최신:** fast-glob, micromatch, @types/micromatch. manifest churn 없이 전이 lock만 패치한다.
- `@zvec/zvec@0.2.1` pin과 Windows/native support는 별도 research ticket의 결정이며 이 문서에서 바꾸지 않는다.

## 구현 시 acceptance gates

각 wave는 독립 lock diff와 아래 증거를 남겨야 한다.

1. **설치/그래프**
   - root importer만 의도한 direct specifier로 바뀌었는지 확인한다.
   - `apps/docs` importer와 narrative TUI lock/source는 이 작업에서 변경하지 않는다.
   - `pnpm why`로 위 patched floors를 확인한다.
   - npm bulk advisory endpoint를 다시 실행해 이 문서의 매치가 사라졌는지 확인한다.
2. **test**
   - 전체 root Vitest suite를 Node 22.14와 24에서 실행한다.
   - Commander wave는 CLI contract/snapshot/hardening과 `--help`, `--version`, invalid options를 집중 확인한다.
   - Zod wave는 MCP server/protocol, invalid input, `CallToolResultSchema`, packed MCP calls를 집중 확인한다.
   - snapshot 파일은 자동 갱신하지 말고 의미 있는 차이만 검토한다.
3. **build/type**
   - `pnpm build`, `runtime:verify`, `build:verify`를 실행한다.
   - emitted file list, shebang, executable mode, source map, `.d.ts` public surface를 baseline과 비교한다.
   - TypeScript 6 wave는 기존 `tsc --noEmit` diagnostics를 별도 baseline issue로 분리하고 새 diagnostics가 추가되지 않았는지 비교한다.
4. **packaging/runtime**
   - `pack:verify`, `pack:smoke`, `pack:upgrade-smoke`를 실행한다.
   - fresh tarball install에서 Commander ESM loading, CLI/MCP executable, SDK+Zod protocol validation을 확인한다.
   - Node 22.14와 Node 24, macOS ARM64/Linux ARM64의 기존 runtime matrix를 모두 통과한다. Windows 축 추가 여부는 zvec 결정 뒤에 합친다.
5. **rollback**
   - wave별 commit을 유지한다. Wave A security fix는 되돌리지 않고 문제 package만 forward-fix하는 것을 우선한다.
   - Commander는 유지보수 중인 14.0.3으로 일시 fallback할 수 있다.
   - Zod는 SDK가 허용하는 3.25.76으로 독립 fallback할 수 있다.
   - compiler wave 실패 시 TypeScript 5.9.3과 `@types/node` 기존 line으로 되돌려도 runtime artifact/store format에는 영향이 없어야 한다.

## 확인된 것과 아직 확인하지 않은 것

확인된 사실:

- current install에서 `pnpm build`, `build:verify`, `pack:verify`가 통과했고 pack allowlist는 17 files였다.
- RAGit은 Commander의 `--no-*` option을 선언하지 않고 Zod를 직접 import하지 않는다.
- `tsc --noEmit`의 기존 diagnostics는 TypeScript 5.9.3/6.0.3/7.0.2에서 동일하게 관찰됐다.
- 조사한 모든 목표 version은 npm metadata에 package-level `deprecated` field가 없다.
- 보안 표의 current lock paths와 patched floors는 registry graph 및 project security advisories로 확인했다.

아직 확인하지 않은 것:

- 이 연구는 후보 manifest/lock을 생성하지 않았으므로 후보 조합의 실제 resolved graph와 전체 suite 성공 여부는 미확인이다.
- Vitest update 시 package manager가 Vite 7.3.6 대신 8.x를 선택할 수 있다. 구현자는 Vite 7 patched line을 명시적으로 확인해야 한다.
- TypeScript 6 + tsdown 0.21.10의 실제 declaration output은 미확인이다. 공식 peer compatibility만으로 acceptance하지 않는다.
- Zod 4.4.3이 SDK의 모든 protocol schema에서 3.25.76 동봉 v4와 byte/diagnostic 동등한지는 미확인이다.
- `@types/node@24`가 Node 22.14 minimum API를 보장하지 않는 기존 정책 공백은 남는다.
- Node 26, TypeScript 7, tsdown 0.22, MCP v2 split packages는 모두 향후 별도 결정이다.

## npm metadata 색인

- [`@modelcontextprotocol/sdk@1.29.0`](https://registry.npmjs.org/%40modelcontextprotocol%2Fsdk/1.29.0)
- [`commander@14.0.3`](https://registry.npmjs.org/commander/14.0.3), [`commander@15.0.0`](https://registry.npmjs.org/commander/15.0.0)
- [`fast-glob@3.3.3`](https://registry.npmjs.org/fast-glob/3.3.3)
- [`micromatch@4.0.8`](https://registry.npmjs.org/micromatch/4.0.8)
- [`zod@3.25.76`](https://registry.npmjs.org/zod/3.25.76), [`zod@4.4.3`](https://registry.npmjs.org/zod/4.4.3)
- [`@types/micromatch@4.0.10`](https://registry.npmjs.org/%40types%2Fmicromatch/4.0.10)
- [`@types/node@24.10.15`](https://registry.npmjs.org/%40types%2Fnode/24.10.15), [`@types/node@24.13.3`](https://registry.npmjs.org/%40types%2Fnode/24.13.3), [`@types/node@26.1.1`](https://registry.npmjs.org/%40types%2Fnode/26.1.1)
- [`tsdown@0.21.0`](https://registry.npmjs.org/tsdown/0.21.0), [`tsdown@0.21.10`](https://registry.npmjs.org/tsdown/0.21.10), [`tsdown@0.22.8`](https://registry.npmjs.org/tsdown/0.22.8)
- [`tsx@4.21.0`](https://registry.npmjs.org/tsx/4.21.0), [`tsx@4.23.1`](https://registry.npmjs.org/tsx/4.23.1)
- [`typescript@5.9.3`](https://registry.npmjs.org/typescript/5.9.3), [`typescript@6.0.3`](https://registry.npmjs.org/typescript/6.0.3), [`typescript@7.0.2`](https://registry.npmjs.org/typescript/7.0.2)
- [`vitest@4.0.18`](https://registry.npmjs.org/vitest/4.0.18), [`vitest@4.1.10`](https://registry.npmjs.org/vitest/4.1.10)
