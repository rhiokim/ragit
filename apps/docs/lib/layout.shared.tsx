import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { Language } from '@/lib/i18n';

export const gitConfig = {
  user: 'rhiokim',
  repo: 'ragit',
  branch: 'main',
};

export const projectLinks = {
  github: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  license: `https://github.com/${gitConfig.user}/${gitConfig.repo}/blob/${gitConfig.branch}/LICENSE`,
};

export function baseOptions(language: Language): BaseLayoutProps {
  const docsPath = `/${language}/docs`;
  return {
    nav: {
      title: 'RAGit',
      url: docsPath,
    },
    githubUrl: projectLinks.github,
  };
}
