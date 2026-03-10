import { normalizeLanguage } from '@/lib/i18n';
import { baseOptions } from '@/lib/layout.shared';
import { getSource } from '@/lib/source';
import { DocsSidebar } from '@/components/docs-sidebar';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
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
  const source = getSource(language);

  return (
    <DocsI18nProvider language={language}>
      <DocsLayout
        tree={source.getPageTree()}
        {...baseOptions(language)}
        sidebar={{ component: <DocsSidebar /> }}
      >
        {children}
      </DocsLayout>
    </DocsI18nProvider>
  );
}
