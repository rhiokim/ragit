export const PACKAGE_MANAGERS = ['pnpm', 'npm', 'yarn', 'bun'] as const;

export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

export type PackageManagerTabs = Record<PackageManager, string>;

export const DEFAULT_PACKAGE_MANAGER: PackageManager = 'pnpm';

export const PACKAGE_MANAGER_STORAGE_KEY = 'ragit.docs.packageManager';

export function isPackageManager(
  value: string | null | undefined
): value is PackageManager {
  return value != null && PACKAGE_MANAGERS.includes(value as PackageManager);
}

type BlockFamily = 'install' | 'run' | 'script';

export type PackageManagerCodeBlock = {
  tabs: PackageManagerTabs;
  transformedLineCount: number;
};

function createTabs(
  pnpm: string,
  npm: string,
  yarn: string,
  bun: string
): PackageManagerTabs {
  return {
    pnpm,
    npm,
    yarn,
    bun,
  };
}

function detectBlockFamily(line: string): BlockFamily | null {
  if (/^\s*pnpm\s+install(?:\s|$)/.test(line)) {
    return 'install';
  }

  if (/^\s*pnpm\s+run\s+/.test(line)) {
    return 'run';
  }

  if (/^\s*pnpm\s+/.test(line)) {
    return 'script';
  }

  return null;
}

function convertInstallLine(line: string): PackageManagerTabs | null {
  const match = line.match(/^(\s*)pnpm(\s+install(?:\s+.*)?)$/);
  if (!match) {
    return null;
  }

  const [, indent, rest] = match;

  return createTabs(
    `${indent}pnpm${rest}`,
    `${indent}npm${rest}`,
    `${indent}yarn${rest}`,
    `${indent}bun${rest}`
  );
}

function convertScriptTabs(
  indent: string,
  original: string,
  script: string,
  args: string
): PackageManagerTabs {
  const suffix = args ? ` ${args}` : '';
  const npmArgs = args ? ` -- ${args}` : '';

  return createTabs(
    `${indent}pnpm ${original}`,
    `${indent}npm run ${script}${npmArgs}`,
    `${indent}yarn ${script}${suffix}`,
    `${indent}bun run ${script}${suffix}`
  );
}

function convertRunLine(line: string): PackageManagerTabs | null {
  const match = line.match(/^(\s*)pnpm\s+run\s+([^\s]+)(?:\s+(.*))?$/);
  if (!match) {
    return null;
  }

  const [, indent, script, args = ''] = match;
  if (!script || script.startsWith('-')) {
    return null;
  }

  return convertScriptTabs(indent, `run ${script}${args ? ` ${args}` : ''}`, script, args);
}

function convertScriptLine(line: string): PackageManagerTabs | null {
  const match = line.match(/^(\s*)pnpm\s+([^\s]+)(?:\s+(.*))?$/);
  if (!match) {
    return null;
  }

  const [, indent, script, args = ''] = match;
  if (!script || script.startsWith('-') || script === 'install' || script === 'run') {
    return null;
  }

  return convertScriptTabs(indent, `${script}${args ? ` ${args}` : ''}`, script, args);
}

function convertLineForFamily(
  line: string,
  family: BlockFamily
): PackageManagerTabs | null {
  if (line.trim() === '') {
    return createTabs(line, line, line, line);
  }

  if (detectBlockFamily(line) !== family) {
    return null;
  }

  switch (family) {
    case 'install':
      return convertInstallLine(line);
    case 'run':
      return convertRunLine(line);
    case 'script':
      return convertScriptLine(line);
  }
}

export function buildPackageManagerTabs(raw: string): PackageManagerCodeBlock | null {
  const newline = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/);
  const firstCommandLine = lines.find((line) => line.trim() !== '');

  if (!firstCommandLine) {
    return null;
  }

  const family = detectBlockFamily(firstCommandLine);
  if (!family) {
    return null;
  }

  const outputLines: Record<PackageManager, string[]> = {
    pnpm: [],
    npm: [],
    yarn: [],
    bun: [],
  };

  let transformedLineCount = 0;

  for (const line of lines) {
    const converted = convertLineForFamily(line, family);
    if (!converted) {
      return null;
    }

    if (line.trim() !== '') {
      transformedLineCount += 1;
    }

    for (const packageManager of PACKAGE_MANAGERS) {
      outputLines[packageManager].push(converted[packageManager]);
    }
  }

  if (transformedLineCount === 0) {
    return null;
  }

  return {
    transformedLineCount,
    tabs: createTabs(
      outputLines.pnpm.join(newline),
      outputLines.npm.join(newline),
      outputLines.yarn.join(newline),
      outputLines.bun.join(newline)
    ),
  };
}
