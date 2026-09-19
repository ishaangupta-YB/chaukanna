import { LearnerShell } from '@/components/learner/LearnerShell';
import { other, pickLang } from '@/components/learner/lang';
import { loadLearnerMember } from '@/components/learner/learner-page';
import { StopAllButton } from '@/components/learner/StopAllButton';
import { WindowPicker } from '@/components/WindowPicker';
import { t } from '@/lib/i18n';
import { windowOrDefault } from '@/lib/members';

export const dynamic = 'force-dynamic';

export default async function LearnerWindow({ searchParams }: { searchParams: Promise<{ lang?: string; first?: string }> }) {
  const { lang: langParam, first } = await searchParams;
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
  const { window } = await windowOrDefault(member.memberId);
  const firstParam = first ? '&first=1' : '';
  return (
    <LearnerShell
      lang={lang}
      switchHref={`/me/window?lang=${other(lang)}${firstParam}`}
      footer={<StopAllButton lang={lang} memberId={member.memberId} />}
    >
      {first && (
        <p role="status" className="rounded-2xl bg-emerald-100 p-5 text-2xl font-bold text-emerald-900">
          {t(lang, 'consentDone')}
        </p>
      )}
      <h1 className="text-3xl font-bold">{t(lang, 'windowTitle')}</h1>
      <WindowPicker memberId={member.memberId} initial={window} lang={lang} doneHref={`/me?lang=${lang}`} />
    </LearnerShell>
  );
}
