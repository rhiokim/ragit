import fs from 'node:fs';
import path from 'node:path';

const outDir = path.join(process.cwd(), 'out', 'api', 'search');

function readJson(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`검색 인덱스 파일이 없습니다: ${filePath}`);
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function pickAliasPath() {
  const candidates = [path.join(outDir), path.join(outDir, 'index')];
  const matched = candidates.find((filePath) => fs.existsSync(filePath) && fs.statSync(filePath).isFile());
  if (!matched) {
    throw new Error('영문 alias 인덱스 파일(/api/search)을 찾지 못했습니다.');
  }
  return matched;
}

function collectUrls(indexJson) {
  const docsNode = indexJson?.docs;
  if (!docsNode || typeof docsNode !== 'object') return [];

  const records = docsNode.docs && typeof docsNode.docs === 'object' ? docsNode.docs : docsNode;

  return Object.values(records)
    .map((item) => item?.url)
    .filter((url) => typeof url === 'string');
}

function assertLocaleIndex(name, urls, expectedPrefix, unexpectedPrefix) {
  if (!urls.some((url) => url.startsWith(expectedPrefix))) {
    throw new Error(`${name} 인덱스에서 ${expectedPrefix} 경로를 찾지 못했습니다.`);
  }

  if (urls.some((url) => url.startsWith(unexpectedPrefix))) {
    throw new Error(`${name} 인덱스에 ${unexpectedPrefix} 경로가 섞여 있습니다.`);
  }
}

function main() {
  const enFile = path.join(outDir, 'en');
  const koFile = path.join(outDir, 'ko');
  const aliasFile = pickAliasPath();

  const enUrls = collectUrls(readJson(enFile));
  const koUrls = collectUrls(readJson(koFile));
  const aliasUrls = collectUrls(readJson(aliasFile));

  assertLocaleIndex('en', enUrls, '/en/docs', '/ko/docs');
  assertLocaleIndex('ko', koUrls, '/ko/docs', '/en/docs');
  assertLocaleIndex('alias', aliasUrls, '/en/docs', '/ko/docs');

  console.log('검색 인덱스 검증 완료: en/ko 분리 및 alias 정상');
}

main();
