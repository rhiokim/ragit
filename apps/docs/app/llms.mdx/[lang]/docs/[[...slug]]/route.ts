import { getLLMText, getSource } from '@/lib/source';
import { normalizeLanguage } from '@/lib/i18n';
import { notFound } from 'next/navigation';

export const revalidate = false;

type Params = {
  params: Promise<{
    lang: string;
    slug?: string[];
  }>;
};

export async function GET(_req: Request, { params }: Params) {
  const { lang, slug } = await params;
  const language = normalizeLanguage(lang);
  const source = getSource(language);
  const page = source.getPage(slug?.slice(0, -1));
  if (!page) notFound();

  return new Response(await getLLMText(page), {
    headers: {
      'Content-Type': 'text/markdown',
    },
  });
}

export function generateStaticParams() {
  return [
    ...getSource('en').getPages().map((page) => ({
      lang: 'en',
      slug: [...page.slugs, 'index.mdx'],
    })),
    ...getSource('ko').getPages().map((page) => ({
      lang: 'ko',
      slug: [...page.slugs, 'index.mdx'],
    })),
  ];
}
