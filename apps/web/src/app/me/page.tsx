import Link from 'next/link';
import { LearnerShell } from '@/components/learner/LearnerShell';
import { other, pickLang } from '@/components/learner/lang';
import { loadLearnerMember } from '@/components/learner/learner-page';
import { SharingToggle } from '@/components/learner/SharingToggle';
import { StopAllButton } from '@/components/learner/StopAllButton';
import { WithdrawButton } from '@/components/learner/WithdrawButton';
import { lastDebriefableDrill } from '@/lib/debrief';
import { pendingDrill } from '@/lib/drills';
import { t, windowSummary, type MessageKey } from '@/lib/i18n';
import { windowOrDefault } from '@/lib/members';

export const dynamic = 'force-dynamic';

const STATUS_KEY: Record<string, MessageKey> = {
  active: 'statusActive',
  paused: 'statusPaused',
  revoked: 'statusRevoked',
  invited: 'statusInvited',
};

export default async function LearnerHome({ searchParams }: { searchParams: Promise<{ lang?: string }> }) {
  const { lang: langParam } = await searchParams;
  const member = await loadLearnerMember();
  if (!member) {
    const lang = pickLang(langParam);
    return (
      <LearnerShell lang={lang} switchHref={`/me?lang=${other(lang)}`}>
        <p>{t(lang, 'homeNoSession')}</p>
      </LearnerShell>
    );
  }

  const lang = pickLang(langParam, member.language);
  const [{ window }, waiting, lastFinished] = await Promise.all([
    windowOrDefault(member.memberId),
    pendingDrill(member.memberId),
    lastDebriefableDrill(member.memberId),
  ]);
  const active = member.status === 'active';
  return (
    <LearnerShell
      lang={lang}
      switchHref={`/me?lang=${other(lang)}`}
      footer={active ? <StopAllButton lang={lang} memberId={member.memberId} /> : undefined}
    >
      <h1 className="text-3xl font-bold">{t(lang, 'homeGreeting', { name: member.displayName })}</h1>
      {active && waiting && (
        <section className="flex flex-col gap-3 rounded-2xl border-2 border-emerald-700 bg-emerald-50 p-5">
          <p className="text-2xl font-semibold text-emerald-900">{t(lang, 'homeCallWaiting')}</p>
          <Link
            href={`/drill/${waiting.drillId}?lang=${lang}`}
            className="inline-flex min-h-16 items-center justify-center rounded-2xl bg-emerald-700 px-6 py-3 text-center text-2xl font-bold text-white"
          >
            {t(lang, 'homeOpenCall')}
          </Link>
        </section>
      )}
      {/* The way back to the last debrief. It stays here: a learner may want to hear it again. */}
      {lastFinished && (
        <section className="flex flex-col gap-3">
          <h2 className="font-semibold text-stone-700">{t(lang, 'homeLastResult')}</h2>
          <Link
            href={`/drill/${lastFinished.drillId}/debrief?lang=${lang}`}
            className="inline-flex min-h-16 items-center justify-center rounded-2xl border-2 border-emerald-700 px-5 py-3 text-center text-2xl font-bold text-emerald-900"
          >
            {t(lang, 'debriefOpen')}
          </Link>
        </section>
      )}
      <p
        className={`rounded-2xl p-5 text-2xl font-bold ${active ? 'bg-emerald-100 text-emerald-900' : 'bg-stone-200 text-stone-900'}`}
      >
        {t(lang, STATUS_KEY[member.status])}
      </p>
      <section className="flex flex-col gap-3">
        <h2 className="font-semibold text-stone-700">{t(lang, 'homeWindowLabel')}</h2>
        <p className="text-2xl">{windowSummary(lang, window.days, window.start, window.end)}</p>
        <Link
          href={`/me/window?lang=${lang}`}
          className="inline-flex min-h-14 items-center justify-center rounded-2xl border-2 border-stone-500 px-5 text-xl font-semibold"
        >
          {t(lang, 'homeChangeWindow')}
        </Link>
      </section>
      <SharingToggle lang={lang} memberId={member.memberId} sharing={member.transcriptSharing} />
      {active ? (
        <WithdrawButton lang={lang} memberId={member.memberId} />
      ) : (
        <Link
          href={`/me/consent?lang=${lang}`}
          className="inline-flex min-h-16 items-center justify-center rounded-2xl bg-emerald-700 px-6 py-3 text-center text-2xl font-bold text-white"
        >
          {t(lang, 'homeResume')}
        </Link>
      )}
    </LearnerShell>
  );
}
