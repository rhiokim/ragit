import { gitConfig } from '@/lib/layout.shared';
import { getPageImage, getSource } from '@/lib/source';
import { getMDXComponents } from '@/mdx-components';
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from 'fumadocs-ui/layouts/docs/page';
import { createRelativeLink } from 'fumadocs-ui/mdx';
import { notFound } from 'next/navigation';
import { LLMCopyButton, ViewOptions } from '@/components/ai/page-actions';
import { normalizeLanguage } from '@/lib/i18n';
import type { Metadata } from 'next';

type PageParams = {
  params: Promise<{
    lang: string;
    slug?: string[];
  }>;
};

export default async function Page({ params }: PageParams) {
  const { lang, slug } = await params;
  const language = normalizeLanguage(lang);
  const source = getSource(language);
  const page = source.getPage(slug);
  if (!page) notFound();

  const MDX = page.data.body;
  const markdownUrl = `/llms.mdx/${language}/docs/${[...page.slugs, 'index.mdx'].join('/')}`;

  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription className="mb-0">{page.data.description}</DocsDescription>
      <div className="flex flex-row gap-2 items-center border-b pb-6">
        <LLMCopyButton markdownUrl={markdownUrl} />
        <ViewOptions
          markdownUrl={markdownUrl}
          githubUrl={`https://github.com/${gitConfig.user}/${gitConfig.repo}/blob/${gitConfig.branch}/apps/docs/content/docs/${language}/${page.path}`}
        />
      </div>
      <DocsBody>
        <MDX
          components={getMDXComponents({
            a: createRelativeLink(source, page),
          })}
        />
      </DocsBody>
    </DocsPage>
  );
}

export async function generateStaticParams() {
  return [
    ...getSource('en').generateParams().map((entry) => ({ ...entry, lang: 'en' })),
    ...getSource('ko').generateParams().map((entry) => ({ ...entry, lang: 'ko' })),
  ];
}

export async function generateMetadata({ params }: PageParams): Promise<Metadata> {
  const { lang, slug } = await params;
  const language = normalizeLanguage(lang);
  const source = getSource(language);
  const page = source.getPage(slug);
  if (!page) notFound();

  return {
    title: page.data.title,
    description: page.data.description,
    openGraph: {
      images: getPageImage(page, language).url,
    },
  };
}
