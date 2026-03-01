import fs from 'node:fs';
import path from 'node:path';

const searchDir = path.join(process.cwd(), 'out', 'api', 'search');
const sourcePath = path.join(searchDir, 'en');
const aliasPath = path.join(searchDir, 'index');

if (!fs.existsSync(sourcePath)) {
  throw new Error(`영문 검색 인덱스가 없습니다: ${sourcePath}`);
}

fs.copyFileSync(sourcePath, aliasPath);
console.log(`검색 alias 생성 완료: ${aliasPath}`);
