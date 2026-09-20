import Link from 'next/link';
import { BandChip } from '@/components/guardian/BandChip';
import { CreateHouseholdForm } from '@/components/guardian/CreateHouseholdForm';
import { guardianOrLogin } from '@/components/guardian/guardian-page';
import { LearnerProgress } from '@/components/guardian/LearnerProgress';
import { MemberActions } from '@/components/guardian/MemberActions';
import { istDateTime, learnerProgress, nextScheduled } from '@/lib/dashboard';
import { getLatestConsent, listDrills, listMembers, listScores, type Member } from '@/lib/db';
import { toGuardianBand } from '@/lib/debrief';
import { getGuardianHousehold } from '@/lib/households';
import { windowSummary } from '@/lib/i18n';
import { windowOrDefault } from '@/lib/members';

export const dynamic = 'force-dynamic';

/** How many recent drills a member's card lists. One a week, so this is about two months. */
const HISTORY = 8;

const STATUS: Record<Member['status'], { label: string; tone: string }> = {
  invited: { label: 'Invite sent, waiting for consent', tone: 'bg-amber-100 text-amber-900' },
  active: { label: 'Consented, practice calls on', tone: 'bg-emerald-100 text-emerald-900' },
  paused: { label: 'Paused, no practice calls', tone: 'bg-stone-200 text-stone-900' },
  revoked: { label: 'Consent withdrawn', tone: 'bg-red-100 text-red-900' },
};

export default async function GuardianDashboard() {
  const guardian = await guardianOrLogin('/app');
  const household = await getGuardianHousehold(guardian);

  if (!household) {
    return (
      <>
        <h1 className="text-2xl font-bold">Welcome</h1>
        <p>Start by creating a household. You can then invite a parent or grandparent to practice.</p>
        <CreateHouseholdForm />
      </>
    );
  }

  const members = await listMembers(household.householdId);
  const rows = await Promise.all(
    members.map(async (m) => {
      const drills = await listDrills(m.memberId, HISTORY);
      // One batched read for the whole card rather than one per drill. Bands only: what the
      // scoring pipeline wrote about what was *said* never leaves `toGuardianBand`.
      const scores = await listScores(drills.map((drill) => drill.drillId));
      return {
        member: m,
        window: (await windowOrDefault(m.memberId)).window,
        consent: m.status === 'invited' ? null : await getLatestConsent(m.memberId),
        // The instant a scheduled drill will ring, shown because a random time nobody can see is
        // just an unexplained phone call. The guardian sees when, never what.
        scheduled: nextScheduled(drills),
        // Bands, arrows and a flag count. Computed in `lib/dashboard.ts`, which never sees a quote.
        progress: learnerProgress(drills, scores),
        history: drills
          .filter((drill) => drill.state !== 'scheduled')
          .map((drill) => toGuardianBand(drill, scores.get(drill.drillId))),
      };
    }),
  );

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">{household.name}</h1>
        <div className="flex flex-wrap gap-2">
          <Link href="/app/audit" className="inline-flex min-h-11 items-center rounded-lg border border-stone-400 px-4 font-semibold">
            Audit log
          </Link>
          <Link href="/app/invite" className="inline-flex min-h-11 items-center rounded-lg bg-emerald-700 px-4 font-semibold text-white">
            Invite a family member
          </Link>
        </div>
      </div>

      {rows.length === 0 && <p className="rounded-2xl border border-dashed border-stone-400 p-6">No one invited yet.</p>}

      <ul className="flex flex-col gap-4">
        {rows.map(({ member, window, consent, scheduled, progress, history }) => (
          <li key={member.memberId} className="flex flex-col gap-3 rounded-2xl border border-stone-300 bg-white p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-xl font-bold">{member.displayName}</h2>
              <span className={`rounded-full px-3 py-1 text-sm font-semibold ${STATUS[member.status].tone}`}>
                {STATUS[member.status].label}
              </span>
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-base">
              <dt className="text-stone-600">Language</dt>
              <dd>{member.language === 'hi-IN' ? 'Hindi' : 'Indian English'}</dd>
              <dt className="text-stone-600">Window</dt>
              <dd>{windowSummary('en', window.days, window.start, window.end)} IST</dd>
              <dt className="text-stone-600">Next call</dt>
              {/*
                Said either way. A blank row reads as a bug, and "no drill scheduled" is a fact a
                guardian acts on — it is the difference between waiting and pressing the button.
              */}
              <dd>{scheduled ? `${istDateTime(scheduled.scheduledAt)} IST` : 'No drill scheduled'}</dd>
              {consent && (
                <>
                  <dt className="text-stone-600">Consent</dt>
                  <dd>
                    {consent.method === 'voice' ? 'Spoken' : 'Typed'} on {istDateTime(consent.at)}
                    {consent.revokedAt ? ', withdrawn' : ''}
                  </dd>
                </>
              )}
            </dl>

            <section className="flex flex-col gap-2 border-t border-stone-200 pt-3">
              <h3 className="text-base font-semibold text-stone-700">How it is going</h3>
              <LearnerProgress progress={progress} name={member.displayName} />
            </section>

            {history.length > 0 && (
              <section className="flex flex-col gap-2 border-t border-stone-200 pt-3">
                <h3 className="text-base font-semibold text-stone-700">Recent practice calls</h3>
                <ul className="flex flex-col gap-2">
                  {history.map((row) => (
                    <li key={row.drillId} className="flex flex-wrap items-center justify-between gap-2 text-base">
                      <span>{istDateTime(row.at)} IST</span>
                      <BandChip band={row.band} state={row.state} />
                    </li>
                  ))}
                </ul>
                {/*
                  Said out loud, on the page, because a guardian who does not know this is a
                  boundary will read the blank space as a missing feature and go looking for a
                  transcript. PRD F7 AC2: band and date, and the words stay with the learner.
                  Phase 6 is what adds the policy that could ever grant more, and only if the
                  learner turns sharing on themselves.
                */}
                <p className="text-sm text-stone-600">
                  You see the band and the date, and nothing else. What was said on the call stays with{' '}
                  {member.displayName}.
                </p>
              </section>
            )}
            <div className="flex flex-wrap gap-2">
              <Link href={`/app/members/${member.memberId}/window`} className="inline-flex min-h-11 items-center rounded-lg border border-stone-400 px-4 font-semibold">
                Set window
              </Link>
            </div>
            <MemberActions
              memberId={member.memberId}
              name={member.displayName}
              canPause={member.status === 'active'}
              canRing={member.status === 'active'}
              canSchedule={member.status === 'active' && !scheduled}
            />
          </li>
        ))}
      </ul>
    </>
  );
}
