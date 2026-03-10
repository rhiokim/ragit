import { baseOptions } from '@/lib/layout.shared';
import { normalizeLanguage } from '@/lib/i18n';
import { HomeLayout } from 'fumadocs-ui/layouts/home';
import type { ReactNode } from 'react';
import { DocsI18nProvider } from '@/components/docs-i18n-provider';

type LayoutProps = {
  children: ReactNode;
  params: Promise<{
    lang: string;
  }>;
};

export default async function Layout({ children, params }: LayoutProps) {
  const { lang } = await params;
  const language = normalizeLanguage(lang);
  return (
    <DocsI18nProvider language={language}>
      <HomeLayout {...baseOptions(language)}>{children}</HomeLayout>
    </DocsI18nProvider>
  );
}
