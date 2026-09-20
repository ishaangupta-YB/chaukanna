import { z } from 'zod';
import { resolveMember } from '@/lib/access';
import { buildGuardianPrincipal, buildMemberResource, requireAuthz, VP_ACTIONS } from '@/lib/authz';
import { config } from '@/lib/config';
import { DrillNotAllowed, ringNow, scheduleDrill } from '@/lib/drills';
import { AppError, unauthorized } from '@/lib/errors';
import { householdIdForGuardian } from '@/lib/households';
import { assertSameOrigin, handle, json, parseBody } from '@/lib/http';
import { currentPrincipals } from '@/lib/session';

/**
 * Creates a drill, by either of the two paths into the drill table.
 *
 * `{ now: true }` is the guardian's demo control (PRD F3 AC4): a drill that is already ringing.
 * `{ schedule: true }` is the real one (PRD F3 AC2): a drill written now that will ring by itself
 * at a random instant inside the learner's window, with an EventBridge schedule behind it.
 *
 * Whether this guardian may create a drill for this member at all is decided by Verified
 * Permissions before any of that: `ScheduleDrill` is permitted inside the guardian's own
 * household and forbidden outright when the member is `paused`. That forbid is the fourth effect
 * of the kill switch (phase 6 task 5), and it has to be a policy rather than the `paused` branch
 * in `guardNewDrill`, because a branch is not something a judge can be shown denying.
 *
 * The remaining rules — consent, the window, the weekly cap — live in `lib/drills.ts` and run
 * after. A refusal says which rule refused so the screen can explain it, and each reason is a
 * state the caller can already see for themselves, so it gives nothing away.
 */

const Body = z.union([z.object({ now: z.literal(true) }), z.object({ schedule: z.literal(true) })]);

const STATUS: Record<string, number> = {
  not_consented: 409,
  paused: 409,
  outside_window: 409,
  weekly_cap: 409,
  not_ready: 409,
};

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle('drills.create', async () => {
    assertSameOrigin(request, config.appUrl(new URL(request.url).origin));
    const { id } = await params;
    // Either path is the guardian's: a learner cannot summon, or schedule, their own practice
    // call. Surprise is the point, and a learner who chooses the moment is not being surprised.
    const principals = await currentPrincipals();
    const { member, actor } = await resolveMember(principals, id, ['guardian']);
    if (!principals.guardian) throw unauthorized();
    /*
     * The principal's household comes from the Cognito subject and the resource's from the member
     * row, so the Cedar `when` is comparing two independently sourced values rather than a value
     * with itself. A paused member is denied here, by the forbid, and never reaches `ringNow`.
     */
    await requireAuthz(
      buildGuardianPrincipal(principals.guardian.sub, householdIdForGuardian(principals.guardian.sub)),
      VP_ACTIONS.SCHEDULE_DRILL,
      buildMemberResource(member.memberId, member.householdId, member.status),
    );
    const body = await parseBody(request, Body);
    try {
      const drill = 'now' in body ? await ringNow(member, actor) : await scheduleDrill(member, actor);
      return json({ drillId: drill.drillId, state: drill.state, scheduledAt: drill.scheduledAt }, 201);
    } catch (error) {
      if (error instanceof DrillNotAllowed) {
        throw new AppError(STATUS[error.refusal] ?? 409, error.refusal);
      }
      throw error;
    }
  });
}
