import Link from 'next/link';
import { t, type Lang } from '@/lib/i18n';

/** Frame for every learner screen: large type, practice badge, language switch, kill switch slot. */
export function LearnerShell({
  lang,
  switchHref,
  footer,
  children,
}: {
  lang: Lang;
  switchHref?: string;
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <main lang={lang} className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-8 px-5 py-6 text-xl leading-relaxed">
      <header className="flex items-center justify-between gap-4">
        <span className="text-2xl font-bold text-amber-800">{t(lang, 'appName')}</span>
        {switchHref && (
          <Link
            href={switchHref}
            className="inline-flex min-h-12 items-center rounded-xl border-2 border-stone-400 px-4 text-lg font-medium"
          >
            {t(lang, 'switchLanguage')}
          </Link>
        )}
      </header>
      <p className="self-start rounded-full bg-emerald-100 px-4 py-1 text-lg font-semibold text-emerald-900">
        {t(lang, 'practiceBadge')}
      </p>
      <div className="flex flex-1 flex-col gap-8">{children}</div>
      {footer && <footer className="border-t-2 border-stone-200 pt-6">{footer}</footer>}
    </main>
  );
}
