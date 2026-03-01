'use client';
import {
  SearchDialog,
  SearchDialogClose,
  SearchDialogContent,
  SearchDialogHeader,
  SearchDialogIcon,
  SearchDialogInput,
  SearchDialogList,
  SearchDialogOverlay,
  type SharedProps,
} from 'fumadocs-ui/components/dialog/search';
import { useDocsSearch } from 'fumadocs-core/search/client';
import { create } from '@orama/orama';
import { useI18n } from 'fumadocs-ui/contexts/i18n';
import { useMemo } from 'react';
import { usePathname } from 'next/navigation';
import { createKoreanSearchTokenizer } from '@/lib/search-tokenizer.ko';
import { getSearchIndexPath, resolveSearchLanguage } from '@/lib/search-locale';

function initOrama(language: 'en' | 'ko') {
  const tokenizer = language === 'ko' ? createKoreanSearchTokenizer() : undefined;

  return create({
    schema: { _: 'string' },
    language: 'english',
    ...(tokenizer ? { components: { tokenizer } } : {}),
  });
}

export default function DefaultSearchDialog(props: SharedProps) {
  const { locale } = useI18n();
  const pathname = usePathname();
  const searchLanguage = resolveSearchLanguage({ pathname, locale });
  const clientOptions = useMemo(
    () => ({
      type: 'static' as const,
      from: getSearchIndexPath(searchLanguage),
      initOrama: () => initOrama(searchLanguage),
      locale: searchLanguage,
    }),
    [searchLanguage],
  );

  const { search, setSearch, query } = useDocsSearch(clientOptions, [searchLanguage]);

  return (
    <SearchDialog search={search} onSearchChange={setSearch} isLoading={query.isLoading} {...props}>
      <SearchDialogOverlay />
      <SearchDialogContent>
        <SearchDialogHeader>
          <SearchDialogIcon />
          <SearchDialogInput />
          <SearchDialogClose />
        </SearchDialogHeader>
        <SearchDialogList items={query.data !== 'empty' ? query.data : null} />
      </SearchDialogContent>
    </SearchDialog>
  );
}
