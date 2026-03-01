import type { Tokenizer } from '@orama/orama';

const KOREAN_TOKEN_REGEX = /[가-힣]+|[a-z0-9]+/gi;

export function tokenizeKoreanText(value: string): string[] {
  const normalized = value.normalize('NFKC').toLowerCase();
  const matched = normalized.match(KOREAN_TOKEN_REGEX) ?? [];
  const deduped = new Set(matched);
  return [...deduped];
}

export function createKoreanSearchTokenizer(): Tokenizer {
  return {
    language: 'korean',
    normalizationCache: new Map<string, string>(),
    tokenize(raw: string): string[] {
      if (!raw) return [];
      return tokenizeKoreanText(raw);
    },
  };
}
