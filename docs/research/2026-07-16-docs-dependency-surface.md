# apps/docs 의존성 업그레이드 조사

- 조사 기준일: 2026-07-16 (Asia/Seoul)
- 범위: apps/docs의 직접 의존성, 해당 의존성이 요구하는 peer/engine, 저장소 안의 변경 표면
- 버전 기준: npm 레지스트리의 dist-tags.latest. 단순히 가장 큰 semver가 존재한다는 이유로 prerelease나 latest 태그 밖의 버전을 채택하지 않는다.
- 조사 방법: 현재 package.json과 pnpm-lock.yaml을 대조하고, npm 레지스트리 메타데이터 및 프로젝트의 공식 문서·변경 기록·소스만 사용했다.
- 성격: 구현 전 연구 산출물이다. package.json이나 lockfile을 변경하거나 새 조합을 설치·실행하지 않았다.

## 결론

문서 앱은 한 번에 전부 올리기보다 호환성 경계별로 나누어야 한다. 특히 Fumadocs 묶음은 단순 버전 변경이 아니다. 현재 코드가 fumadocs-ui의 비공개 dist 경로를 직접 가져오는데, 목표 버전 16.11.5에는 그 파일들이 존재하지 않는다. 따라서 Fumadocs core/ui/mdx, Lucide, Takumi, 사이드바·검색·코드 하이라이트·OG 코드를 하나의 원자적 변경 및 롤백 단위로 취급해야 한다.

권고 목표 조합은 다음과 같다.

| 묶음 | 권고 목표 |
| --- | --- |
| 프레임워크 | next 16.2.10, react/react-dom 19.2.7, 대응 React 타입 |
| Fumadocs/콘텐츠 | fumadocs-core 16.11.5, fumadocs-ui 16.11.5, fumadocs-mdx 15.2.0 |
| OG 이미지 | @takumi-rs/image-response 제거, takumi-js 2.2.0으로 이전 |
| 스타일 | tailwindcss와 @tailwindcss/postcss 4.3.2, postcss 8.5.19, tailwind-merge 3.6.0 |
| 툴체인 | TypeScript 6.0.3, @types/node 24.13.3, @types/mdx 2.0.14 |
| 렌더링 보조 | lucide-react 1.24.0, mermaid 11.16.0, rehype-pretty-code 0.14.4 |
| 유지 | @orama/orama 3.1.18 |
| 운영 보조 | serve 14.2.6 |

TypeScript는 레지스트리 latest인 7.0.2가 아니라 6.0.3을 목표로 한다. TypeScript 팀은 7.0의 안정적인 programmatic API가 아직 없어 MDX를 포함한 도구 체인이 당장은 6.x를 사용해야 한다고 명시한다. @types/node도 latest 26이 아니라 문서 CI의 Node 24 LTS와 맞는 24.13.3을 사용한다.

## 직접 의존성 버전 표

괄호 안은 lockfile에 실제로 해석된 버전이다. “차이”는 현재 선언 기준에서 레지스트리 latest까지의 semver 축을 뜻한다.

### 런타임 의존성

| 패키지 | 현재 선언 (lock) | registry latest | 차이 | 권고 목표 | 판단 |
| --- | --- | --- | --- | --- | --- |
| [@orama/orama](https://registry.npmjs.org/@orama%2Forama/3.1.18) | ^3.1.18 (3.1.18) | 3.1.18 | 없음 | 3.1.18 유지 | 검색 엔진 자체는 변경할 이유가 없다. |
| [@takumi-rs/image-response](https://registry.npmjs.org/@takumi-rs%2Fimage-response/2.2.0) | ^0.68.17 (0.68.17) | 2.2.0 | major | 제거 | 최신 패키지는 takumi-js를 감싸는 호환 래퍼다. 공식 이전 경로를 따른다. |
| [fumadocs-core](https://registry.npmjs.org/fumadocs-core/16.11.5) | 16.6.6 (16.6.6) | 16.11.5 | minor | 16.11.5 exact | ui와 exact peer로 묶는다. |
| [fumadocs-mdx](https://registry.npmjs.org/fumadocs-mdx/15.2.0) | 14.2.8 (14.2.8) | 15.2.0 | major | 15.2.0 exact | core ^16.7, Next 15.3/16, React 19.2와 호환된다. |
| [fumadocs-ui](https://registry.npmjs.org/fumadocs-ui/16.11.5) | 16.6.6 (16.6.6) | 16.11.5 | minor | 16.11.5 exact | core 16.11.5를 정확히 요구한다. |
| [lucide-react](https://registry.npmjs.org/lucide-react/1.24.0) | ^0.570.0 (0.570.0) | 1.24.0 | major | ^1.24.0 | 앱의 사용 아이콘은 남아 있지만 접근성·렌더링 회귀 검증이 필요하다. |
| [mermaid](https://registry.npmjs.org/mermaid/11.16.0) | ^11.14.0 (11.14.0) | 11.16.0 | minor | ^11.16.0 | 대표 다이어그램의 테마·동적 렌더링을 확인한다. |
| [next](https://registry.npmjs.org/next/16.2.10) | 16.1.6 (16.1.6) | 16.2.10 | minor | 16.2.10 exact | React 런타임과 함께 올린다. |
| [react](https://registry.npmjs.org/react/19.2.7) | ^19.2.4 (19.2.4) | 19.2.7 | patch | ^19.2.7 | react-dom과 같은 변경으로 묶는다. |
| [react-dom](https://registry.npmjs.org/react-dom/19.2.7) | ^19.2.4 (19.2.4) | 19.2.7 | patch | ^19.2.7 | peer가 react ^19.2.7이다. |
| [rehype-pretty-code](https://registry.npmjs.org/rehype-pretty-code/0.14.4) | ^0.14.3 (0.14.3) | 0.14.4 | patch | ^0.14.4 | 무한 루프 수정 패치이며 Shiki 4를 지원한다. |
| [tailwind-merge](https://registry.npmjs.org/tailwind-merge/3.6.0) | ^3.4.1 (3.5.0) | 3.6.0 | minor | ^3.6.0 | Tailwind CSS 4.3 지원 버전이다. |

새 직접 의존성은 [takumi-js 2.2.0](https://registry.npmjs.org/takumi-js/2.2.0) 하나다. 기존 @takumi-rs/image-response와 동시에 유지하지 않는다.

### 개발 의존성

| 패키지 | 현재 선언 (lock) | registry latest | 차이 | 권고 목표 | 판단 |
| --- | --- | --- | --- | --- | --- |
| [@tailwindcss/postcss](https://registry.npmjs.org/@tailwindcss%2Fpostcss/4.3.2) | ^4.1.18 (4.2.1) | 4.3.2 | minor | ^4.3.2 | tailwindcss와 같은 버전 축으로 묶는다. |
| [@types/mdx](https://registry.npmjs.org/@types%2Fmdx/2.0.14) | ^2.0.13 (2.0.13) | 2.0.14 | patch | ^2.0.14 | MDX 15와 별도 major 전환은 없다. |
| [@types/node](https://registry.npmjs.org/@types%2Fnode/26.1.1) | ^25.2.3 (25.3.2) | 26.1.1 | major | [^24.13.3](https://registry.npmjs.org/@types%2Fnode/24.13.3) | latest가 아니라 CI의 Node 24 LTS 축에 맞춘다. |
| [@types/react](https://registry.npmjs.org/@types%2Freact/19.2.17) | ^19.2.14 (19.2.14) | 19.2.17 | patch | ^19.2.17 | React 패치 묶음에 포함한다. |
| [@types/react-dom](https://registry.npmjs.org/@types%2Freact-dom/19.2.3) | ^19.2.3 (19.2.3) | 19.2.3 | 없음 | 유지 | 변경 불필요. |
| [postcss](https://registry.npmjs.org/postcss/8.5.19) | ^8.5.6 (8.5.6) | 8.5.19 | patch | ^8.5.19 | Tailwind/PostCSS 묶음에 포함한다. |
| [serve](https://registry.npmjs.org/serve/14.2.6) | ^14.2.5 (14.2.5) | 14.2.6 | patch | ^14.2.6 | 정적 산출물 smoke에 사용한다. |
| [tailwindcss](https://registry.npmjs.org/tailwindcss/4.3.2) | ^4.1.18 (4.2.1) | 4.3.2 | minor | ^4.3.2 | PostCSS 플러그인과 함께 올린다. |
| [typescript](https://registry.npmjs.org/typescript/7.0.2) | ^5.9.3 (5.9.3) | 7.0.2 | 2 major | [^6.0.3](https://registry.npmjs.org/typescript/6.0.3) | MDX 도구 체인 때문에 6.x 브리지에 멈춘다. |

레지스트리에는 Fumadocs 17.0.0 버전도 보이지만 dist-tags.latest는 core/ui 16.11.5다. 이 조사에서는 17을 목표로 삼지 않는다. Next 16.3 preview/canary도 같은 이유로 제외한다.

## 목표 조합의 호환성

### Peer 관계

| 소비자 | 공식 peer 계약 | 목표 조합에서의 해석 |
| --- | --- | --- |
| fumadocs-ui 16.11.5 | fumadocs-core 16.11.5, Next 16.x, React/DOM ^19.2; takumi-js는 optional | core/ui를 반드시 exact pair로 올리고 Takumi 사용 시 takumi-js를 직접 설치한다. |
| fumadocs-core 16.11.5 | Next 16.x, React/DOM ^19.2, lucide-react, zod는 optional | Next 16.2.10·React 19.2.7과 맞는다. |
| fumadocs-mdx 15.2.0 | core ^16.7, Next ^15.3 또는 ^16, React ^19.2 | core 16.11.5·Next 16.2.10과 맞는다. |
| next 16.2.10 | React/DOM ^18.2 또는 ^19 | React 19.2.7과 맞는다. |
| react-dom 19.2.7 | React ^19.2.7 | React와 같은 PR·lock 변경으로 묶는다. |
| lucide-react 1.24.0 | React 16.5부터 19까지 | React 19.2.7과 맞는다. |

Fumadocs core/ui 16.11.5의 peer 메타데이터와 실제 배포 파일은 각각 [core metadata](https://registry.npmjs.org/fumadocs-core/16.11.5), [ui metadata](https://registry.npmjs.org/fumadocs-ui/16.11.5), [ui tarball](https://registry.npmjs.org/fumadocs-ui/-/fumadocs-ui-16.11.5.tgz)에서 확인했다.

### Node engine

| 패키지 | 최소 Node |
| --- | --- |
| next 16.2.10 | >=20.9.0 |
| @orama/orama 3.1.18 | >=20 |
| takumi-js 2.2.0 | >=18 |
| rehype-pretty-code 0.14.4 | >=18 |
| TypeScript 6.0.3 | >=14.17 |

루트 package.json의 Node >=22.14와 docs GitHub Actions의 Node 24는 모두 충족한다. 다만 현재 @types/node 25는 런타임과 어긋난다. Node 공식 릴리스 표에서 24는 LTS, 26은 Current, 25는 EOL이므로 타입은 24 축으로 되돌리는 편이 명시적이고 재현 가능하다.

## 저장소 변경 표면

### 1. Fumadocs 레이아웃과 사이드바 — 높은 위험

현재 apps/docs/components/docs-sidebar.tsx는 다음 비공개 경로를 직접 가져온다.

- ../node_modules/fumadocs-ui/dist/layouts/shared/search-toggle.js
- ../node_modules/fumadocs-ui/dist/layouts/docs/sidebar.js

16.11.5 배포 tarball에는 두 파일 모두 없다. 따라서 버전만 바꾸면 컴파일 단계에서 실패하는 것이 확정적이다. 최신 공개 surface에는 다음과 같은 exports가 있다.

- fumadocs-ui/layouts/shared/slots/search-trigger
- fumadocs-ui/layouts/docs/slots/sidebar
- fumadocs-ui/components/sidebar/base
- DocsLayout의 sidebar.components, sidebar.footer, slots 옵션

권고 작업은 비공개 dist import를 모두 제거하고 DocsLayout의 지원 옵션으로 커스텀 폴더/항목과 라이선스·GitHub footer를 구성하는 것이다. 현재 사용 중인 sidebar.component는 최신 타입에 남아 있지만 deprecated이므로 새 구현의 기반으로 삼지 않는다. 공개 옵션으로 표현할 수 없는 커스터마이징만 남는다면 Fumadocs의 공식 customize CLI로 코드를 저장소에 vendoring하는 선택을 별도로 검토한다.

16.11 계열은 내부 템플릿/상호작용을 Base UI로 옮겼고, 레이아웃 슬롯 및 스타일 변경도 포함한다. 컴파일 성공만으로 동등성을 판단할 수 없으므로 데스크톱·모바일의 열림 상태, active 항목, 키보드 포커스, 접근성 이름을 확인해야 한다.

1차 출처:

- [Docs layout 공식 문서](https://www.fumadocs.dev/docs/ui/layouts/docs)
- [UI customize 공식 문서](https://www.fumadocs.dev/docs/guides/customize-ui)
- [Fumadocs UI changelog](https://github.com/fuma-nama/fumadocs/blob/52af6cf292efe62c5d547dea1affdcdd4e92e988/packages/radix-ui/CHANGELOG.md)
- [Fumadocs v16 소개](https://www.fumadocs.dev/blog/v16)
- [Fumadocs v16.2 레이아웃 변경](https://www.fumadocs.dev/blog/v16-2)

### 2. MDX 소스·코드 하이라이트 — 중간 위험

현재 구성은 MDX 14의 생성 alias 계약을 이미 따른다.

- fumadocs-mdx:collections/* → .source/*
- collections/server import 사용
- ESM next.config.mjs 사용

MDX 15의 공식 주요 조건은 fumadocs-core >=16.7과 ESM Next 설정이다. 두 조건 모두 목표 조합에서 충족하므로 frontmatter나 MDX 본문을 일괄 변환할 근거는 없다.

다만 source.config.ts가 기본 rehype 플러그인을 제거하기 위해 rehypePlugins.shift()를 호출한다. 이는 플러그인 순서라는 내부 구현에 의존한다. 최신 공식 설정의 rehypeCodeOptions: false로 기본 코드 하이라이터를 명시적으로 끄고, 저장소의 rehype-pretty-code 플러그인을 그대로 등록하도록 바꾼다. 생성된 .source 출력은 깨끗하게 재생성하여 stale 산출물이 호환성을 가리지 않게 한다.

Fumadocs 16.8.12/MDX 15.0.7에는 structuredData 정규화가 포함되어 있어 정적 검색 JSON의 구조와 실제 질의 결과도 함께 검증해야 한다.

1차 출처:

- [MDX v14 공식 이전 안내](https://www.fumadocs.dev/blog/mdx-v14)
- [MDX v15 공식 이전 안내](https://www.fumadocs.dev/blog/mdx-v15)
- [fumadocs-mdx changelog](https://github.com/fuma-nama/fumadocs/blob/52af6cf292efe62c5d547dea1affdcdd4e92e988/packages/mdx/CHANGELOG.md)
- [fumadocs-core changelog](https://github.com/fuma-nama/fumadocs/blob/52af6cf292efe62c5d547dea1affdcdd4e92e988/packages/core/CHANGELOG.md)

### 3. 정적 검색과 Orama — 중간 위험

Orama는 이미 latest 3.1.18이므로 엔진 버전은 유지한다. 저장소의 한국어 tokenizer가 구현하는 Tokenizer 계약도 목표 core가 사용하는 Orama 3.1.18과 같은 축이다.

변경점은 Fumadocs client API다. core 16.10.2부터 useDocsSearch의 type: static 표기는 deprecated이며 명시적 client 구성이 권장된다. components/search.tsx를 다음 공개 API 형태로 옮긴다.

- fumadocs-core/search/client/orama-static의 oramaStaticClient 사용
- 기존 from 경로와 initOrama의 언어별 tokenizer/dependencies 보존
- /ragit/api/search/en, /ragit/api/search/ko 및 호환 alias /api/search 유지

현재 check:search-index는 URL 및 산출물 구조를 주로 확인한다. 업그레이드 검증에는 실제 영어·한국어 질의를 각각 실행해 해당 locale 결과만 반환되는지, alias가 영어 인덱스와 같은 동작을 하는지까지 추가해야 한다.

### 4. OG 이미지와 Takumi — 높은 위험

@takumi-rs/image-response 2.2.0은 takumi-js로 이동한 이후의 호환 래퍼다. Fumadocs 최신 공식 통합 예제와 fumadocs-ui의 OG 소스는 모두 takumi-js/response를 직접 가져온다. 따라서 다음을 한 번에 변경한다.

- apps/docs/app/og/[lang]/docs/[...slug]/route.tsx의 ImageResponse import를 takumi-js/response로 이동
- next.config.mjs의 serverExternalPackages를 @takumi-rs/image-response에서 @takumi-rs/core로 변경
- package.json에서 이전 패키지를 제거하고 takumi-js 2.2.0을 직접 추가

Takumi v2는 단순 패키지 이름 변경이 아니다. 기본 CSS에서 position, border width, transform/object-position 기준점과 SVG currentColor 격리 등이 달라졌다. 따라서 기존 JSX가 빌드되더라도 이미지 배치가 달라질 수 있다. 대표 영어·한국어 OG 이미지를 1200×630, WebP content type, 비어 있지 않은 payload, 시각적 기준 이미지로 검증한다. Linux/Node 24 CI에서 네이티브 모듈 로드도 별도 통과 조건이다.

1차 출처:

- [Takumi v2 공식 이전 안내](https://takumi.kane.tw/docs/upgrade/v2)
- [Takumi ImageResponse 공식 문서](https://takumi.kane.tw/docs/image-response)
- [Fumadocs의 Takumi 통합 소스](https://github.com/fuma-nama/fumadocs/blob/52af6cf292efe62c5d547dea1affdcdd4e92e988/apps/docs/content/docs/%28framework%29/integrations/og/takumi.mdx)

### 5. Next/React와 정적 빌드 — 중간 위험

저장소는 이미 Next 16이므로 15→16의 큰 이전 작업을 다시 수행할 필요는 없다. 16.2는 주로 성능·도구 개선이며, 16.2.10은 16.2.4 이후 빠졌던 SWC WASM 배포물을 보완한 패치다. 커스텀 webpack 설정도 없다.

그럼에도 문서 배포는 output: export, basePath /ragit, trailingSlash, 동적 OG route, 검색 alias 생성에 의존한다. Next와 React 패치 묶음 뒤에 전체 정적 export를 만들고 배포 artifact에서 이 계약을 확인한다. React/React DOM은 반드시 같은 버전으로 움직인다. React 19.2.7에는 RSC FormData 회귀 수정이 포함되어 있다.

1차 출처:

- [Next.js 16 업그레이드 가이드](https://nextjs.org/docs/app/guides/upgrading/version-16)
- [Next.js 16.2 발표](https://nextjs.org/blog/next-16-2)
- [Next.js 16.2.10 릴리스](https://github.com/vercel/next.js/releases/tag/v16.2.10)
- [React 19.2.7 릴리스](https://github.com/facebook/react/releases/tag/v19.2.7)

### 6. Tailwind/PostCSS — 중간 위험

현재 app/global.css와 postcss.config.mjs는 이미 Tailwind 4 방식이다.

- tailwindcss, fumadocs neutral.css, preset.css를 CSS import로 구성
- @tailwindcss/postcss 플러그인 사용

따라서 4.3으로 올릴 때 config 형식 이전은 필요하지 않다. 공식 4.3 안내대로 tailwindcss와 @tailwindcss/postcss를 함께 올리고, Tailwind 4.3 규칙을 인식하는 tailwind-merge 3.6.0을 같은 묶음에 둔다. 저장소 검색 결과 4.3에서 deprecated된 start-*/end-* utility 사용은 발견되지 않았다. 전체 docs 렌더 결과의 spacing, overflow, dark mode 및 클래스 병합을 확인한다.

1차 출처:

- [Tailwind CSS 4.3 공식 발표](https://tailwindcss.com/blog/tailwindcss-v4-3)
- [tailwind-merge 3.6.0 릴리스](https://github.com/dcastil/tailwind-merge/releases/tag/v3.6.0)

### 7. TypeScript와 Node 타입 — 중간 위험

TypeScript 6은 다음 구성 변경을 요구하거나 권장한다.

- apps/docs/tsconfig.json의 deprecated baseUrl 제거. 현재 paths 값은 이미 ./ 기준이므로 의미를 보존할 수 있다.
- TypeScript 6의 기본 types: [] 변화에 기대지 않고, Node API를 쓰는 문서 빌드 의도를 types: [node]로 명시한다.
- ignoreDeprecations로 덮지 않고 실제 설정을 고친다.

TypeScript 7은 MDX·Astro·Vue·Svelte 같은 programmatic API 소비자가 아직 안정적으로 사용할 수 없다는 공식 제한 때문에 보류한다. 루트도 TypeScript를 직접 사용하므로 문서 앱만 7로 앞서가지 않는다.

1차 출처:

- [TypeScript 6.0 release notes](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html)
- [TypeScript 6.0 발표](https://devblogs.microsoft.com/typescript/announcing-typescript-6-0/)
- [TypeScript 7.0 발표와 도구 호환성 제한](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)
- [Node.js 공식 릴리스 상태](https://nodejs.org/en/about/previous-releases)

### 8. Lucide, Mermaid, rehype-pretty-code — 낮음~중간 위험

- Lucide 1.x는 brand icon 제거, 기본 aria-hidden 처리, UMD 제거를 포함한다. 저장소가 직접 쓰는 Check, Clipboard, Terminal, PanelLeft, ChevronDown, ExternalLinkIcon, TextIcon은 1.24.0 배포물에 모두 존재한다. 그래도 UI 및 접근성 snapshot을 확인한다.
- Mermaid 11.16은 11.x minor다. 현재 동적 import → initialize → render 흐름은 유지하되, 영어·한국어의 flowchart/sequence 등 대표 블록을 light/dark 양쪽에서 렌더하고 console error가 없는지 확인한다.
- rehype-pretty-code 0.14.4는 무한 루프 수정 patch다. MDX 구성 변경과 함께 코드 제목, 줄 강조, 복사 버튼, package-manager 탭을 확인한다.

1차 출처:

- [Lucide 1.0.1 릴리스의 major 변경](https://github.com/lucide-icons/lucide/releases/tag/1.0.1)
- [Lucide 1.24.0 릴리스](https://github.com/lucide-icons/lucide/releases/tag/1.24.0)
- [Mermaid 11.16.0 릴리스](https://github.com/mermaid-js/mermaid/releases/tag/mermaid%4011.16.0)
- [rehype-pretty-code 0.14.4 릴리스](https://github.com/rehype-pretty/rehype-pretty-code/releases/tag/rehype-pretty-code%400.14.4)

## 권고 작업 묶음과 순서

다음은 서로 독립적인 PR 경계가 아니라 호환성 및 롤백 경계다. 실제 PR 수는 구현 시 조정할 수 있지만 한 경계 안의 항목을 부분적으로 배포하지 않는다.

### 0. 기준선 기록

- 현재 Node 24에서 docs 검사와 정적 빌드를 실행한다.
- 대표 EN/KO 페이지, 모바일/데스크톱 sidebar, 검색, Mermaid, OG 이미지 기준 자료를 남긴다.
- 현재 실패가 있다면 업그레이드 회귀와 구분할 수 있도록 먼저 기록한다.

### A. 프레임워크 패치 묶음

- next 16.2.10
- react/react-dom 19.2.7
- @types/react 19.2.17, @types/react-dom 19.2.3

React runtime pair와 lockfile을 하나로 되돌릴 수 있게 한다. 이 단계에서 정적 export 계약을 먼저 안정화한다.

### B. 스타일 묶음

- tailwindcss와 @tailwindcss/postcss 4.3.2
- postcss 8.5.19
- tailwind-merge 3.6.0

CSS 결과와 class merge 규칙을 하나의 시각적 회귀 단위로 둔다.

### C. 툴체인 브리지 묶음

- TypeScript 6.0.3
- @types/node 24.13.3
- @types/mdx 2.0.14
- tsconfig의 baseUrl 제거 및 types 명시

루트 TypeScript 계획과 조율한다. TypeScript 7은 별도 후속 조사 전까지 올리지 않는다.

### D. Fumadocs/검색/OG 원자 묶음

- fumadocs-core와 fumadocs-ui 16.11.5 exact
- fumadocs-mdx 15.2.0 exact
- lucide-react 1.24.0
- @takumi-rs/image-response 제거 및 takumi-js 2.2.0 추가
- 비공개 sidebar import 제거 및 공개 slots/components로 이전
- 정적 검색 client API 이전
- rehypeCodeOptions: false로 기본 하이라이터 비활성화
- OG import와 serverExternalPackages 이전

이 묶음은 가장 위험하다. peer exact 관계, 삭제된 UI 내부 파일, 생성 소스, 검색 API, 네이티브 이미지 런타임을 동시에 일관되게 맞춰야 한다. 일부만 되돌리면 컴파일은 되더라도 peer 또는 출력 계약이 어긋날 수 있으므로 manifest·lockfile·소스 변경을 모두 함께 롤백한다.

### E. 독립적인 렌더/운영 보조 묶음

- mermaid 11.16.0
- rehype-pretty-code 0.14.4
- serve 14.2.6
- @orama/orama는 3.1.18 유지

rehype 버전만 이 경계에 두되, source.config.ts의 명시적 highlighter 선택은 D에서 처리한다.

## 완료 조건

### 설치·peer·타입

- Node 24의 깨끗한 checkout에서 pnpm install --frozen-lockfile 성공
- peer mismatch 경고 없음. 특히 fumadocs-core/ui exact pair와 react/react-dom pair 확인
- pnpm --filter ./apps/docs... types:check 성공
- TypeScript 6 deprecation을 ignoreDeprecations로 숨기지 않음

### 저장소 자동 검사

- pnpm docs:check:i18n
- pnpm docs:check:commands
- pnpm docs:build
- pnpm docs:check:search-index
- pnpm docs:check:internal-links
- GitHub Actions docs-gh-pages workflow를 Node 24/Ubuntu에서 통과

### 산출물 계약

- out 아래 basePath /ragit와 trailing slash 유지
- EN/KO 문서, llms 관련 파일, 검색 JSON, /api/search alias 보존
- 영어·한국어 실제 검색 질의가 locale별 결과를 반환
- 모든 생성 OG route가 WebP, 1200×630, 비어 있지 않은 응답을 반환
- 배포 preview와 게시 artifact에서 내부 링크 및 asset 경로가 모두 유효

### UI·콘텐츠 smoke

- 데스크톱 sidebar 열기/접기, 모바일 drawer, 폴더 active/open 상태
- 검색 열기, locale 전환, 키보드 탐색
- 언어·테마 전환
- 코드 블록의 제목/줄 강조/복사/package-manager 탭
- 대표 EN/KO Mermaid를 light/dark에서 렌더, console error 없음
- 대표 EN/KO OG 이미지의 시각적 기준 비교
- sidebar와 검색 trigger의 접근성 이름 및 포커스 동작

## 중단 및 롤백 기준

다음 중 하나라도 발생하면 해당 묶음을 배포하지 않는다.

- peer 경고 또는 core/ui 버전 불일치
- fumadocs-ui의 node_modules/dist 비공개 import가 남아 있음
- Node 24/Ubuntu에서 Takumi 네이티브 로드 또는 static export 실패
- 검색 인덱스 구조는 만들어지지만 EN/KO 실제 질의가 실패하거나 locale이 섞임
- TypeScript 6을 쓰기 위해 ignoreDeprecations가 필요함
- OG 크기/content type/내용 또는 승인된 시각 기준이 달라짐
- sidebar·검색·코드 블록의 기능 또는 접근성 회귀

롤백은 각 묶음의 package.json, pnpm-lock.yaml, 관련 소스 변경을 함께 되돌린다. Fumadocs/OG 묶음은 이전 패키지 일부만 pin하는 방식으로 복구하지 않는다. Takumi v2 또는 공개 sidebar API 이전이 승인 기준을 충족하지 못하면 D 전체를 현재 core/ui 16.6.6, mdx 14.2.8, @takumi-rs/image-response 0.68.17 조합에 유지한다.

## 구현 시 확인해야 할 미검증 항목

이 연구에서 공식 메타데이터와 배포 surface의 계약은 확인했지만 다음은 구현 브랜치에서만 확정할 수 있다.

- 2026-07-16의 새 조합으로 실제 pnpm install 및 lockfile 재해석이 성공하는지
- 최신 Fumadocs 공개 sidebar API로 현재 커스텀 외관과 동작을 어느 정도 동일하게 재현할 수 있는지
- Takumi 2.2의 Linux 네이티브 모듈과 기존 OG JSX의 실제 픽셀 출력
- MDX 15가 생성한 .source 및 structuredData가 현재 정적 검색 스크립트와 실제 질의에서 완전히 호환되는지
- TypeScript 6 설정을 루트 툴체인과 함께 쓸 때 추가 진단이 생기는지
- Tailwind/Lucide/Fumadocs 조합의 최종 시각 및 접근성 회귀 여부

따라서 이 문서의 버전 조합은 구현 후보를 좁히는 권고안이며, 위 완료 조건을 통과하기 전에는 배포 승인으로 간주하지 않는다.
