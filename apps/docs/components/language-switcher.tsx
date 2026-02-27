'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { defaultLanguage, isLanguage, languageLabels, languages, type Language } from '@/lib/i18n';
import { cn } from '@/lib/cn';

const toLanguagePath = (pathname: string, language: Language): string => {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 0) return `/${language}`;
  if (isLanguage(segments[0])) {
    segments[0] = language;
  } else {
    segments.unshift(language);
  }
  return `/${segments.join('/')}`;
};

export function LanguageSwitcher() {
  const pathname = usePathname();
  const segments = pathname.split('/').filter(Boolean);
  const activeLanguage = isLanguage(segments[0]) ? segments[0] : defaultLanguage;

  return (
    <div className="fixed right-4 top-4 z-50 inline-flex items-center rounded-lg border bg-fd-background/90 p-1 backdrop-blur">
      {languages.map((language) => (
        <Link
          key={language}
          href={toLanguagePath(pathname, language)}
          className={cn(
            'rounded-md px-2 py-1 text-xs font-medium transition-colors',
            activeLanguage === language
              ? 'bg-fd-primary text-fd-primary-foreground'
              : 'text-fd-muted-foreground hover:text-fd-foreground',
          )}
        >
          {languageLabels[language]}
        </Link>
      ))}
    </div>
  );
}
