import { HomeLayout } from 'fumadocs-ui/layouts/home';
import { DocsI18nProvider } from '@/components/docs-i18n-provider';
import { baseOptions } from '@/lib/layout.shared';

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <DocsI18nProvider language="en">
      <HomeLayout {...baseOptions('en')}>{children}</HomeLayout>
    </DocsI18nProvider>
  );
}
