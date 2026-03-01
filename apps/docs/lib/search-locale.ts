export const searchLanguages = ['en', 'ko'] as const;

export type SearchLanguage = (typeof searchLanguages)[number];

export const defaultSearchLanguage: SearchLanguage = 'en';
export const docsBasePath: string = '/ragit';

export function normalizeSearchLanguage(value?: string): SearchLanguage {
  return value === 'ko' ? 'ko' : defaultSearchLanguage;
}

export function resolveSearchLanguage(input: {
  pathname?: string;
  locale?: string;
}): SearchLanguage {
  const fromPath = languageFromPathname(input.pathname);
  if (fromPath) return fromPath;
  return normalizeSearchLanguage(input.locale);
}

export function getSearchIndexPath(language: SearchLanguage): string {
  const normalizedBasePath = docsBasePath === '/' ? '' : docsBasePath.replace(/\/$/, '');
  return `${normalizedBasePath}/api/search/${language}`;
}

function languageFromPathname(pathname?: string): SearchLanguage | undefined {
  if (!pathname) return undefined;
  const segments = pathname.split('/').filter(Boolean);
  const matched = segments.find((segment): segment is SearchLanguage =>
    searchLanguages.includes(segment as SearchLanguage),
  );
  return matched;
}
