import Link from 'next/link';
import { Debrief } from '@/components/learner/Debrief';
import { other, pickLang } from '@/components/learner/lang';
import { LearnerShell } from '@/components/learner/LearnerShell';
import { loadLearnerMember } from '@/components/learner/learner-page';
import { StopAllButton } from '@/components/learner/StopAllButton';
import { getDrill } from '@/lib/db';
import { learnerDebrief } from '@/lib/debrief';
import { AppError } from '@/lib/errors';
import { t } from '@/lib/i18n';

/**
 * The learner's debrief screen.
 *
 * Rendered on the server with the verdict already in hand, so that a learner whose score landed
 * while they were walking back to the sofa never sees a spinner at all. The client component
 * takes over only when there is nothing yet, and polls.
 *
 * A guardian reaching this URL gets the "open this from your family's link" page, because
 * `loadLearnerMember` reads the learner cookie and nothing else. The turning point and the
 * quotes are the learner's (PRD F7 AC2), and the route behind this screen refuses a guardian for
 * the same reason.
 */

export const dynamic = 'force-dynamic';

export default async function DebriefPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ lang?: string }>;
}) {
  const [{ id }, { lang: langParam }] = await Promise.all([params, searchParams]);
  const member = await loadLearnerMember();
  const switchHref = `/drill/${id}/debrief?lang=${other(pickLang(langParam, member?.language))}`;

  if (!member) {
    const lang = pickLang(langParam);
    return (
      <LearnerShell lang={lang} switchHref={switchHref}>
        <p>{t(lang, 'homeNoSession')}</p>
      </LearnerShell>
    );
  }

  const lang = pickLang(langParam, member.language);
  const drill = await getDrill(member.memberId, id);
  // A drill that never became a call has no debrief, and neither does an id that is not theirs.
  const view = drill ? await learnerDebrief(drill).catch(swallowNotFound) : null;

  return (
    <LearnerShell
      lang={lang}
      switchHref={switchHref}
      footer={member.status === 'active' ? <StopAllButton lang={lang} memberId={member.memberId} /> : undefined}
    >
      {view ? (
        <Debrief lang={lang} initial={view} />
      ) : (
        <section className="flex flex-col gap-6">
          <h1 className="text-3xl font-bold">{t(lang, 'debriefTitle')}</h1>
          <p className="rounded-2xl bg-stone-200 p-5 text-2xl">{t(lang, 'debriefNone')}</p>
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

/** A drill with no debrief is a page that says so, not a 500. Anything else still throws. */
function swallowNotFound(error: unknown): null {
  if (error instanceof AppError && error.status === 404) return null;
  throw error;
}
