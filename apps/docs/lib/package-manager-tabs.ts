export const PACKAGE_MANAGERS = ['pnpm', 'npm', 'yarn', 'bun'] as const;

export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

export type PackageManagerTabs = Record<PackageManager, string>;
export type PackageManagerDisplayTabs = Record<PackageManager, string>;

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
  displayTabs: PackageManagerDisplayTabs;
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

type ParsedCommandItem =
  | {
      kind: 'blank';
      line: string;
    }
  | {
      kind: 'command';
      physicalLines: string[];
      canonicalLine: string;
    };

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

function hasLineContinuation(line: string): boolean {
  const trimmed = line.trimEnd();
  return trimmed.endsWith('\\') && !trimmed.endsWith('\\\\');
}

function stripLineContinuation(line: string): string {
  const trimmed = line.trimEnd();
  return trimmed.replace(/\s*\\$/, '');
}

function toContinuationSegment(line: string): string {
  const withoutContinuation = hasLineContinuation(line)
    ? stripLineContinuation(line)
    : line.trimEnd();
  return withoutContinuation.trimStart();
}

function toCanonicalCommandLine(physicalLines: string[]): string {
  let current: string | null = null;

  for (const line of physicalLines) {
    current =
      current == null
        ? hasLineContinuation(line)
          ? stripLineContinuation(line)
          : line.trimEnd()
        : `${current} ${toContinuationSegment(line)}`;
  }

  return current ?? '';
}

function parseCommandItems(raw: string): ParsedCommandItem[] | null {
  const physicalLines = raw.split(/\r?\n/);
  const items: ParsedCommandItem[] = [];
  let currentLines: string[] = [];

  for (const line of physicalLines) {
    if (line.trim() === '') {
      if (currentLines.length > 0) {
        return null;
      }

      items.push({
        kind: 'blank',
        line,
      });
      continue;
    }

    currentLines.push(line);
    if (hasLineContinuation(line)) {
      continue;
    }

    items.push({
      kind: 'command',
      physicalLines: currentLines,
      canonicalLine: toCanonicalCommandLine(currentLines),
    });
    currentLines = [];
  }

  if (currentLines.length > 0) {
    return null;
  }

  return items;
}

function buildDisplayTabs(
  physicalLines: string[],
  canonicalTabs: PackageManagerTabs
): PackageManagerDisplayTabs {
  if (physicalLines.length <= 1) {
    return canonicalTabs;
  }

  const tail = physicalLines
    .slice(1)
    .map((line) => toContinuationSegment(line))
    .join(' ');
  const suffix = tail ? ` ${tail}` : '';

  const buildDisplay = (canonical: string): string => {
    if (suffix === '' || !canonical.endsWith(suffix)) {
      return canonical;
    }

    const head = canonical.slice(0, canonical.length - suffix.length);
    return [(`${head} \\`), ...physicalLines.slice(1)].join('\n');
  };

  return createTabs(
    buildDisplay(canonicalTabs.pnpm),
    buildDisplay(canonicalTabs.npm),
    buildDisplay(canonicalTabs.yarn),
    buildDisplay(canonicalTabs.bun)
  );
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
  const items = parseCommandItems(raw);
  if (!items) {
    return null;
  }

  const firstCommand = items.find((item) => item.kind === 'command');

  if (!firstCommand || firstCommand.kind !== 'command') {
    return null;
  }

  const family = detectBlockFamily(firstCommand.canonicalLine);
  if (!family) {
    return null;
  }

  const outputLines: Record<PackageManager, string[]> = {
    pnpm: [],
    npm: [],
    yarn: [],
    bun: [],
  };
  const displayLines: Record<PackageManager, string[]> = {
    pnpm: [],
    npm: [],
    yarn: [],
    bun: [],
  };

  let transformedLineCount = 0;

  for (const item of items) {
    if (item.kind === 'blank') {
      for (const packageManager of PACKAGE_MANAGERS) {
        outputLines[packageManager].push(item.line);
        displayLines[packageManager].push(item.line);
      }
      continue;
    }

    const converted = convertLineForFamily(item.canonicalLine, family);
    if (!converted) {
      return null;
    }

    transformedLineCount += 1;
    const display = buildDisplayTabs(item.physicalLines, converted);

    for (const packageManager of PACKAGE_MANAGERS) {
      outputLines[packageManager].push(converted[packageManager]);
      displayLines[packageManager].push(display[packageManager]);
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
    displayTabs: createTabs(
      displayLines.pnpm.join(newline),
      displayLines.npm.join(newline),
      displayLines.yarn.join(newline),
      displayLines.bun.join(newline)
    ),
  };
}
