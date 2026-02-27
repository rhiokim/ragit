import Link from 'next/link';
import { normalizeLanguage } from '@/lib/i18n';

type PageParams = {
  params: Promise<{
    lang: string;
  }>;
};

export default async function HomePage({ params }: PageParams) {
  const { lang } = await params;
  const language = normalizeLanguage(lang);

  return (
    <div className="flex flex-col justify-center text-center flex-1 gap-3">
      <h1 className="text-2xl font-bold">ragit documentation</h1>
      <p>
        Open{' '}
        <Link href={`/${language}/docs`} className="font-medium underline">
          /{language}/docs
        </Link>{' '}
        to read docs.
      </p>
    </div>
  );
}

export function generateStaticParams() {
  return [{ lang: 'en' }, { lang: 'ko' }];
}
