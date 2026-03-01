import { sources } from '@/lib/source';
import { createFromSource } from 'fumadocs-core/search/server';
import { createKoreanSearchTokenizer } from '@/lib/search-tokenizer.ko';

export const revalidate = false;

export const { staticGET: GET } = createFromSource(sources.ko, {
  tokenizer: createKoreanSearchTokenizer(),
});
