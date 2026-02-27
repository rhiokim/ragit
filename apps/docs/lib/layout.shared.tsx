import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { Language } from '@/lib/i18n';

export const gitConfig = {
  user: 'rhiokim',
  repo: 'ragit',
  branch: 'main',
};

const labels: Record<Language, string> = {
  en: 'Documentation',
  ko: '문서',
};

export function baseOptions(language: Language): BaseLayoutProps {
  const docsPath = `/${language}/docs`;
  return {
    nav: {
      title: `ragit ${labels[language]}`,
      url: docsPath,
    },
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
