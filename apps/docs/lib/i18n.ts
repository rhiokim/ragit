export const languages = ['en', 'ko'] as const;

export type Language = (typeof languages)[number];

export const defaultLanguage: Language = 'en';

export const languageLabels: Record<Language, string> = {
  en: 'English',
  ko: '한국어',
};

export const isLanguage = (value: string): value is Language =>
  languages.includes(value as Language);

export const normalizeLanguage = (value?: string): Language =>
  value && isLanguage(value) ? value : defaultLanguage;
