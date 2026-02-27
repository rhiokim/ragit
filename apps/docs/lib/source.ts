import { docsEn, docsKo } from 'fumadocs-mdx:collections/server';
import { type InferPageType, loader } from 'fumadocs-core/source';
import { Language, normalizeLanguage } from '@/lib/i18n';

const sourceEn = loader({
  baseUrl: '/en/docs',
  source: docsEn.toFumadocsSource(),
  plugins: [],
});

const sourceKo = loader({
  baseUrl: '/ko/docs',
  source: docsKo.toFumadocsSource(),
  plugins: [],
});

export const sources = {
  en: sourceEn,
  ko: sourceKo,
} as const;

export type SourceByLanguage = (typeof sources)[Language];
export type SourcePage = InferPageType<typeof sourceEn>;

export const getSource = (language: string): SourceByLanguage => {
  const normalized = normalizeLanguage(language);
  return sources[normalized];
};

export function getPageImage(page: SourcePage, language: Language) {
  const segments = [...page.slugs, 'image.webp'];

  return {
    segments,
    url: `/og/${language}/docs/${segments.join('/')}`,
  };
}

export async function getLLMText(page: SourcePage) {
  const processed = await page.data.getText('processed');

  return `# ${page.data.title}

${processed}`;
}
