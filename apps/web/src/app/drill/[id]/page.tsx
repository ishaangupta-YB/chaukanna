import Link from 'next/link';
import { DrillCall } from '@/components/learner/DrillCall';
import { LearnerShell } from '@/components/learner/LearnerShell';
import { other, pickLang } from '@/components/learner/lang';
import { loadLearnerMember } from '@/components/learner/learner-page';
import { StopAllButton } from '@/components/learner/StopAllButton';
import { getDrill } from '@/lib/db';
import { t } from '@/lib/i18n';

/**
 * The learner's call screen. The server decides what may be shown; the client component decides
 * nothing except which of the three states it is in.
 *
 * The kill switch is in the footer here as it is on every other learner screen, because a screen
 * that a scam call is being practised on is the last place to make stopping hard to find.
 */

export const dynamic = 'force-dynamic';

export default async function DrillPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ lang?: string }>;
}) {
  const [{ id }, { lang: langParam }] = await Promise.all([params, searchParams]);
  const member = await loadLearnerMember();

  if (!member) {
    const lang = pickLang(langParam);
    return (
      <LearnerShell lang={lang} switchHref={`/drill/${id}?lang=${other(lang)}`}>
        <p>{t(lang, 'homeNoSession')}</p>
      </LearnerShell>
    );
  }

  const lang = pickLang(langParam, member.language);
  const drill = await getDrill(member.memberId, id);
  const answerable = drill?.state === 'due' || drill?.state === 'session_pending';

  return (
    <LearnerShell
      lang={lang}
      switchHref={`/drill/${id}?lang=${other(lang)}`}
      footer={<StopAllButton lang={lang} memberId={member.memberId} />}
    >
      {answerable ? (
        <DrillCall drillId={drill.drillId} lang={lang} />
      ) : (
        <section className="flex flex-col gap-6">
          <h1 className="text-3xl font-bold">{t(lang, 'drillEndedTitle')}</h1>
          <p className="rounded-2xl bg-stone-200 p-5 text-2xl">
            {t(lang, drill ? 'drillEndedBody' : 'drillNone')}
          </p>
          <Link
            href={`/me?lang=${lang}`}
            className="inline-flex min-h-16 items-center justify-center rounded-2xl bg-emerald-700 px-6 py-3 text-center text-2xl font-bold text-white"
          >
            {t(lang, 'drillBackHome')}
          </Link>
        </section>
      )}
    </LearnerShell>
  );
}
