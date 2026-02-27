import { normalizeLanguage } from '@/lib/i18n';
import { getPageImage, getSource } from '@/lib/source';
import { notFound } from 'next/navigation';
import { ImageResponse } from '@takumi-rs/image-response';
import { generate as DefaultImage } from 'fumadocs-ui/og/takumi';

export const revalidate = false;

type Params = {
  params: Promise<{
    lang: string;
    slug: string[];
  }>;
};

export async function GET(_req: Request, { params }: Params) {
  const { lang, slug } = await params;
  const language = normalizeLanguage(lang);
  const source = getSource(language);
  const page = source.getPage(slug.slice(0, -1));
  if (!page) notFound();

  return new ImageResponse(
    <DefaultImage title={page.data.title} description={page.data.description} site="ragit" />,
    {
      width: 1200,
      height: 630,
      format: 'webp',
    },
  );
}

export function generateStaticParams() {
  return [
    ...getSource('en').getPages().map((page) => ({
      lang: 'en',
      slug: getPageImage(page, 'en').segments,
    })),
    ...getSource('ko').getPages().map((page) => ({
      lang: 'ko',
      slug: getPageImage(page, 'ko').segments,
    })),
  ];
}
