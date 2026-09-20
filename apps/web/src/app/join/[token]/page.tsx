import type { Metadata } from 'next';
import { ConsentFlow } from '@/components/learner/ConsentFlow';
import { LearnerShell } from '@/components/learner/LearnerShell';
import { other, pickLang } from '@/components/learner/lang';
import { StopAllButton } from '@/components/learner/StopAllButton';
import { t } from '@/lib/i18n';
import { readInvite } from '@/lib/invites';

export const dynamic = 'force-dynamic';
// The token is in the URL: never send it onward as a referrer, never index the page.
export const metadata: Metadata = { referrer: 'no-referrer', robots: { index: false, follow: false } };

type Props = { params: Promise<{ token: string }>; searchParams: Promise<{ lang?: string }> };

/** Learner consent. One screen, Hindi by default, one primary button, kill switch below. */
export default async function JoinPage({ params, searchParams }: Props) {
  const { token } = await params;
  const { lang: langParam } = await searchParams;
  const invite = await readInvite(token);

  if (invite.state === 'invalid') {
    const lang = pickLang(langParam);
    return (
      <LearnerShell lang={lang} switchHref={`/join/${token}?lang=${other(lang)}`}>
        <h1 className="text-3xl font-bold">{t(lang, 'inviteInvalidTitle')}</h1>
        <p>{t(lang, 'inviteInvalidBody')}</p>
      </LearnerShell>
    );
  }

  const lang = pickLang(langParam, invite.language);
  return (
    <LearnerShell
      lang={lang}
      switchHref={`/join/${token}?lang=${other(lang)}`}
      footer={<StopAllButton lang={lang} token={token} />}
    >
      <h1 className="text-3xl font-bold leading-snug">{t(lang, 'consentTitle')}</h1>
      <p className="text-2xl">{t(lang, 'consentGreeting', { name: invite.displayName })}</p>
      <p>{t(lang, 'consentIntro')}</p>
      <ul className="flex list-disc flex-col gap-3 pl-6">
        <li>{t(lang, 'consentPointCalls')}</li>
        <li>{t(lang, 'consentPointAudio')}</li>
        <li>{t(lang, 'consentPointFamily')}</li>
        <li>{t(lang, 'consentPointStop')}</li>
      </ul>
      <ConsentFlow lang={lang} token={token} />
    </LearnerShell>
  );
}
