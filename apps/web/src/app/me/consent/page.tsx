import { ConsentFlow } from '@/components/learner/ConsentFlow';
import { LearnerShell } from '@/components/learner/LearnerShell';
import { other, pickLang } from '@/components/learner/lang';
import { loadLearnerMember } from '@/components/learner/learner-page';
import { StopAllButton } from '@/components/learner/StopAllButton';
import { t } from '@/lib/i18n';

export const dynamic = 'force-dynamic';

/** Turning practice back on is a fresh, recorded consent, never a silent toggle. */
export default async function LearnerConsent({ searchParams }: { searchParams: Promise<{ lang?: string }> }) {
  const { lang: langParam } = await searchParams;
  const member = await loadLearnerMember();
  if (!member) {
    const lang = pickLang(langParam);
    return (
      <LearnerShell lang={lang}>
        <p>{t(lang, 'homeNoSession')}</p>
      </LearnerShell>
    );
  }
  const lang = pickLang(langParam, member.language);
  return (
    <LearnerShell
      lang={lang}
      switchHref={`/me/consent?lang=${other(lang)}`}
      footer={<StopAllButton lang={lang} memberId={member.memberId} />}
    >
      <h1 className="text-3xl font-bold leading-snug">{t(lang, 'consentTitle')}</h1>
      <ul className="flex list-disc flex-col gap-3 pl-6">
        <li>{t(lang, 'consentPointCalls')}</li>
        <li>{t(lang, 'consentPointAudio')}</li>
        <li>{t(lang, 'consentPointFamily')}</li>
        <li>{t(lang, 'consentPointStop')}</li>
      </ul>
      <ConsentFlow lang={lang} memberId={member.memberId} />
    </LearnerShell>
  );
}
