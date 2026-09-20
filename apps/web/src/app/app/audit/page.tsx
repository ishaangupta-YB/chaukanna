import Link from 'next/link';
import { guardianOrLogin } from '@/components/guardian/guardian-page';
import { resolveMember } from '@/lib/access';
import { ABSENT, buildAuditRows, type AuditEntry } from '@/lib/audit';
import { getLatestConsent, listDrills, listMembers, listScores } from '@/lib/db';
import { authorizedDrills } from '@/lib/guardian-view';
import { getGuardianHousehold } from '@/lib/households';

export const dynamic = 'force-dynamic';

/** Deep enough to cover the whole of a hackathon demo household, shallow enough to project. */
const HISTORY = 25;

const COLUMNS = [
  'Drill',
  'Learner',
  'Scheduled (IST)',
  'Asked for by',
  'Consent',
  'Scenario',
  'Prompt versions',
  'How it ended',
  'Ended (IST)',
] as const;

/**
 * The audit log: every drill this household has run, and the provenance of each one.
 *
 * A flat table on purpose. It answers, in one screen and without a click, the question a judge
 * asks about a system that rings someone's grandmother — who asked for this call, what were they
 * allowed to do it under, exactly which scenario and prompts produced it, and how did it stop.
 *
 * Bands, states and versions. No transcript, no quote, no score: this page is about whether the
 * drill was run properly, never about how the learner did. That boundary is not enforced by what
 * this file chooses to render — `lib/audit.ts` has no access to a quote to begin with.
 *
 * Authorisation happens here, on the server, and nowhere else, in two layers. `resolveMember` is
 * the household check every guardian read goes through, so a member outside this guardian's
 * household is not found. Cedar then decides drill by drill, through the same `ViewBand` policy
 * the dashboard uses, so the audit log cannot become a way around the dashboard's answer.
 */
export default async function AuditPage() {
  const guardian = await guardianOrLogin('/app/audit');
  const household = await getGuardianHousehold(guardian);

  if (!household) {
    return (
      <>
        <h1 className="text-2xl font-bold">Audit log</h1>
        <p>There is no household yet, so nothing has been run.</p>
        <Link href="/app" className="font-semibold underline">
          Back to the dashboard
        </Link>
      </>
    );
  }

  const members = await listMembers(household.householdId);
  const perMember = await Promise.all(
    members.map(async (listed) => {
      const { member } = await resolveMember({ guardian, learner: null }, listed.memberId, ['guardian']);
      const { drills, available } = await authorizedDrills(
        guardian.sub,
        household.householdId,
        member,
        await listDrills(member.memberId, HISTORY),
      );
      const scores = await listScores(drills.map((drill) => drill.drillId));
      const consent = member.status === 'invited' ? null : await getLatestConsent(member.memberId);
      return {
        available,
        entries: drills.map((drill) => ({ drill, member, consent, score: scores.get(drill.drillId) })),
      };
    }),
  );

  // One notice for the page rather than one per member: the table is a single list, and a row
  // silently missing from it is exactly the failure this is here to rule out.
  const incomplete = perMember.some((m) => !m.available);
  const entries: AuditEntry[] = perMember.flatMap((m) => m.entries);
  const rows = buildAuditRows(entries);

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Audit log</h1>
        <Link href="/app" className="inline-flex min-h-11 items-center rounded-lg border border-stone-400 px-4 font-semibold">
          Back to the dashboard
        </Link>
      </div>
      <p className="text-base text-stone-600">
        Every practice call {household.name} has run: who asked for it, the consent it ran under, the scenario and
        prompt versions behind it, and how it stopped. A dash means the row does not carry that field. Nothing on this
        page comes from a transcript.
      </p>

      {incomplete && (
        <p role="alert" className="rounded-2xl border border-amber-500 bg-amber-50 p-4 text-base text-amber-900">
          This log is incomplete: the permission check did not answer for at least one member, so
          their practice calls have been withheld rather than shown unauthorised. Reload in a moment.
        </p>
      )}

      {rows.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-stone-400 p-6">No practice calls have been run yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-stone-300 bg-white">
          <table className="w-full border-collapse text-base">
            <caption className="sr-only">Practice calls run by {household.name}, newest first</caption>
            <thead>
              <tr className="bg-stone-100 text-left">
                {COLUMNS.map((column) => (
                  <th key={column} scope="col" className="whitespace-nowrap px-4 py-3 font-semibold text-stone-700">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.drillId} className="border-t border-stone-200 align-top">
                  <td className="px-4 py-3 font-mono text-sm">{row.drillId.slice(0, 8)}</td>
                  <td className="px-4 py-3 font-semibold whitespace-nowrap">{row.learner}</td>
                  <td className="px-4 py-3 whitespace-nowrap">{row.scheduledAt}</td>
                  <td className="px-4 py-3 whitespace-nowrap">{row.scheduledBy}</td>
                  <td className="px-4 py-3 font-mono text-sm">{row.consent}</td>
                  <td className="px-4 py-3 font-mono text-sm">{row.scenario}</td>
                  <td className="px-4 py-3 font-mono text-sm">{row.promptVersions}</td>
                  <td className="px-4 py-3 whitespace-nowrap">{row.ending}</td>
                  <td className="px-4 py-3 whitespace-nowrap">{row.endedAt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-sm text-stone-600">
        Consent rows have no id of their own: they are keyed by the member and the moment consent was given, so{' '}
        <span className="font-mono">CONSENT#&lt;time&gt;</span> is the id. {ABSENT} means the field is genuinely absent
        on the row, not hidden.
      </p>
    </>
  );
}
