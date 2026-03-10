import { describe, expect, it } from 'vitest';

import {
  readLanguageFromPathname,
  replaceLanguageInPathname,
} from '../apps/docs/lib/i18n-routing';

describe('docs i18n routing', () => {
  it('replaces the language segment on a basePath root route', () => {
    expect(replaceLanguageInPathname('/ragit/en/', 'ko')).toBe('/ragit/ko');
  });

  it('replaces the language segment on nested docs routes', () => {
    expect(replaceLanguageInPathname('/ragit/en/docs/quickstart/', 'ko')).toBe(
      '/ragit/ko/docs/quickstart'
    );
    expect(
      replaceLanguageInPathname('/ragit/ko/docs/commands/init/', 'en')
    ).toBe('/ragit/en/docs/commands/init');
  });

  it('preserves basePath when the pathname does not yet have a language segment', () => {
    expect(replaceLanguageInPathname('/ragit/docs/quickstart/', 'ko')).toBe(
      '/ragit/ko/docs/quickstart'
    );
  });

  it('supports runtime pathnames that do not include basePath', () => {
    expect(replaceLanguageInPathname('/en/docs/quickstart', 'ko')).toBe(
      '/ko/docs/quickstart'
    );
  });

  it('reads the active language from basePath and non-basePath routes', () => {
    expect(readLanguageFromPathname('/ragit/ko/docs/quickstart/')).toBe('ko');
    expect(readLanguageFromPathname('/en/docs/quickstart')).toBe('en');
    expect(readLanguageFromPathname('/ragit/docs/quickstart')).toBe('en');
  });
});
