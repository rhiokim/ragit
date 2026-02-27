import { readdir } from 'node:fs/promises';
import path from 'node:path';

const cwd = process.cwd();
const enRoot = path.join(cwd, 'content', 'docs', 'en');
const koRoot = path.join(cwd, 'content', 'docs', 'ko');

const walkFiles = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(absolute)));
      continue;
    }
    files.push(absolute);
  }
  return files;
};

const relativeFrom = (root, absolute) => path.relative(root, absolute).replaceAll(path.sep, '/');

const warn = (message) => {
  console.warn(`[i18n-check][warn] ${message}`);
};

const run = async () => {
  const enFiles = await walkFiles(enRoot);
  const koFiles = await walkFiles(koRoot);

  const enRelative = new Set(enFiles.map((file) => relativeFrom(enRoot, file)));
  const koRelative = new Set(koFiles.map((file) => relativeFrom(koRoot, file)));

  const missingKo = [];
  for (const relativePath of enRelative) {
    if (!koRelative.has(relativePath)) {
      missingKo.push(relativePath);
    }
  }

  const extraKo = [];
  for (const relativePath of koRelative) {
    if (!enRelative.has(relativePath)) {
      extraKo.push(relativePath);
    }
  }

  console.log('[i18n-check] source-of-truth: English');
  console.log(`[i18n-check] english files: ${enRelative.size}`);
  console.log(`[i18n-check] korean files: ${koRelative.size}`);

  if (missingKo.length === 0 && extraKo.length === 0) {
    console.log('[i18n-check] all locale pairs are aligned.');
    return;
  }

  if (missingKo.length > 0) {
    warn(`missing Korean counterparts (${missingKo.length})`);
    for (const file of missingKo) {
      warn(`  - ko/${file}`);
    }
  }

  if (extraKo.length > 0) {
    warn(`Korean-only files (${extraKo.length})`);
    for (const file of extraKo) {
      warn(`  - ko/${file}`);
    }
  }

  console.log('[i18n-check] warnings only. build/deploy can continue.');
};

run().catch((error) => {
  warn(`check failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(0);
});
