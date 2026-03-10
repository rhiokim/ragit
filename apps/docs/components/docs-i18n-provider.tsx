'use client';

import { I18nProvider } from 'fumadocs-ui/contexts/i18n';
import { usePathname, useRouter } from 'next/navigation';
import { languageLabels, languages, normalizeLanguage, type Language } from '@/lib/i18n';
import { replaceLanguageInPathname } from '@/lib/i18n-routing';
import type { ReactNode } from 'react';

type DocsI18nProviderProps = {
  children: ReactNode;
  language: Language;
};

export function DocsI18nProvider({
  children,
  language,
}: DocsI18nProviderProps) {
  const pathname = usePathname();
  const router = useRouter();

  return (
    <I18nProvider
      locale={language}
      locales={languages.map((locale) => ({
        locale,
        name: languageLabels[locale],
      }))}
      onLocaleChange={(value) => {
        const nextLanguage = normalizeLanguage(value);
        router.push(replaceLanguageInPathname(pathname, nextLanguage));
      }}
    >
      {children}
    </I18nProvider>
  );
}
