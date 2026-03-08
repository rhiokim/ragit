import { normalizeLanguage } from '@/lib/i18n';
import { baseOptions } from '@/lib/layout.shared';
import { getSource } from '@/lib/source';
import { DocsSidebar } from '@/components/docs-sidebar';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import type { ReactNode } from 'react';
import { LanguageSwitcher } from '@/components/language-switcher';

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
    <>
      <LanguageSwitcher />
      <DocsLayout
        tree={source.getPageTree()}
        {...baseOptions(language)}
        sidebar={{ component: <DocsSidebar /> }}
      >
        {children}
      </DocsLayout>
    </>
  );
}
