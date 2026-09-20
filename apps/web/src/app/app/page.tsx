import Link from 'next/link';
import { CreateHouseholdForm } from '@/components/guardian/CreateHouseholdForm';
import { guardianOrLogin } from '@/components/guardian/guardian-page';
import { MemberActions } from '@/components/guardian/MemberActions';
import { getLatestConsent, listMembers, type Member } from '@/lib/db';
import { getGuardianHousehold } from '@/lib/households';
import { windowSummary } from '@/lib/i18n';
import { windowOrDefault } from '@/lib/members';

export const dynamic = 'force-dynamic';

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
    members.map(async (m) => ({
      member: m,
      window: (await windowOrDefault(m.memberId)).window,
      consent: m.status === 'invited' ? null : await getLatestConsent(m.memberId),
    })),
  );

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">{household.name}</h1>
        <Link href="/app/invite" className="inline-flex min-h-11 items-center rounded-lg bg-emerald-700 px-4 font-semibold text-white">
          Invite a family member
        </Link>
      </div>

      {rows.length === 0 && <p className="rounded-2xl border border-dashed border-stone-400 p-6">No one invited yet.</p>}

      <ul className="flex flex-col gap-4">
        {rows.map(({ member, window, consent }) => (
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
              {consent && (
                <>
                  <dt className="text-stone-600">Consent</dt>
                  <dd>
                    {consent.method === 'voice' ? 'Spoken' : 'Typed'} on{' '}
                    {new Date(consent.at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })}
                    {consent.revokedAt ? ', withdrawn' : ''}
                  </dd>
                </>
              )}
            </dl>
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
            />
          </li>
        ))}
      </ul>
    </>
  );
}
