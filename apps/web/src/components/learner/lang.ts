import { langFromLocale, type Lang } from '@/lib/i18n';

/** ?lang= wins, then the member's own language, then Hindi. */
export function pickLang(param: string | string[] | undefined, locale?: 'hi-IN' | 'en-IN'): Lang {
  if (param === 'en' || param === 'hi') return param;
  return locale ? langFromLocale(locale) : 'hi';
}

export function other(lang: Lang): Lang {
  return lang === 'hi' ? 'en' : 'hi';
}
