import { defaultLanguage, isLanguage, type Language } from './i18n';
import { docsBasePath } from './site';

const normalizeBasePath = (value: string): string =>
  value === '/' ? '' : value.replace(/\/$/, '');

export function replaceLanguageInPathname(
  pathname: string,
  language: Language
): string {
  const basePath = normalizeBasePath(docsBasePath);
  const hasBasePath = basePath.length > 0 && pathname.startsWith(basePath);
  const relativePath = hasBasePath ? pathname.slice(basePath.length) || '/' : pathname;
  const segments = relativePath.split('/').filter(Boolean);

  if (segments.length === 0) {
    const nextPath = `/${language}`;
    return hasBasePath ? `${basePath}${nextPath}` : nextPath;
  }

  if (isLanguage(segments[0])) {
    segments[0] = language;
  } else if (isLanguage(segments[1])) {
    segments[1] = language;
  } else {
    segments.unshift(language);
  }

  const nextPath = `/${segments.join('/')}`;
  return hasBasePath ? `${basePath}${nextPath}` : nextPath;
}

export function readLanguageFromPathname(pathname?: string): Language {
  if (!pathname) return defaultLanguage;

  const basePath = normalizeBasePath(docsBasePath);
  const relativePath =
    basePath.length > 0 && pathname.startsWith(basePath)
      ? pathname.slice(basePath.length) || '/'
      : pathname;
  const segments = relativePath.split('/').filter(Boolean);
  const matched = segments.find(isLanguage);

  return matched ?? defaultLanguage;
}
