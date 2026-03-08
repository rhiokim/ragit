import { describe, expect, it } from 'vitest';

import { buildPackageManagerTabs } from '../apps/docs/lib/package-manager-tabs';

describe('package manager tabs', () => {
  it('converts pnpm install line across package managers', () => {
    const converted = buildPackageManagerTabs('pnpm install');

    expect(converted?.tabs.pnpm).toBe('pnpm install');
    expect(converted?.tabs.npm).toBe('npm install');
    expect(converted?.tabs.yarn).toBe('yarn install');
    expect(converted?.tabs.bun).toBe('bun install');
  });

  it('converts multi-line install blocks as one family', () => {
    const converted = buildPackageManagerTabs(
      ['pnpm install', 'pnpm install --frozen-lockfile'].join('\n')
    );

    expect(converted?.tabs.npm).toBe(
      ['npm install', 'npm install --frozen-lockfile'].join('\n')
    );
    expect(converted?.tabs.yarn).toBe(
      ['yarn install', 'yarn install --frozen-lockfile'].join('\n')
    );
  });

  it('converts pnpm script invocation with arguments', () => {
    const converted = buildPackageManagerTabs(
      'pnpm ragit init --yes --output json'
    );

    expect(converted?.tabs.pnpm).toBe('pnpm ragit init --yes --output json');
    expect(converted?.tabs.npm).toBe(
      'npm run ragit -- init --yes --output json'
    );
    expect(converted?.tabs.yarn).toBe('yarn ragit init --yes --output json');
    expect(converted?.tabs.bun).toBe('bun run ragit init --yes --output json');
  });

  it('converts common script commands', () => {
    const converted = buildPackageManagerTabs(
      ['pnpm docs:dev', 'pnpm build', 'pnpm test'].join('\n')
    );

    expect(converted?.tabs.npm).toBe(
      ['npm run docs:dev', 'npm run build', 'npm run test'].join('\n')
    );
    expect(converted?.tabs.yarn).toBe(
      ['yarn docs:dev', 'yarn build', 'yarn test'].join('\n')
    );
    expect(converted?.tabs.bun).toBe(
      ['bun run docs:dev', 'bun run build', 'bun run test'].join('\n')
    );
  });

  it('converts pnpm run family blocks', () => {
    const converted = buildPackageManagerTabs(
      ['pnpm run build --watch', 'pnpm run test'].join('\n')
    );

    expect(converted?.tabs.npm).toBe(
      ['npm run build -- --watch', 'npm run test'].join('\n')
    );
    expect(converted?.tabs.yarn).toBe(
      ['yarn build --watch', 'yarn test'].join('\n')
    );
    expect(converted?.tabs.bun).toBe(
      ['bun run build --watch', 'bun run test'].join('\n')
    );
  });

  it('does not promote blocks without convertible pnpm lines', () => {
    expect(buildPackageManagerTabs('echo "hello"')).toBeNull();
    expect(buildPackageManagerTabs('npm install')).toBeNull();
  });

  it('does not promote mixed-family command blocks', () => {
    expect(
      buildPackageManagerTabs(['pnpm install', 'pnpm ragit --help'].join('\n'))
    ).toBeNull();
    expect(
      buildPackageManagerTabs(
        ['pnpm run build', 'pnpm ragit --help'].join('\n')
      )
    ).toBeNull();
  });
});
