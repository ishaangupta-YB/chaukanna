import { resolveMember } from '@/lib/access';
import { buildDrillResource, buildLearnerPrincipal, requireAuthz, VP_ACTIONS } from '@/lib/authz';
import { getDrill } from '@/lib/db';
import { learnerDebrief } from '@/lib/debrief';
import { notFound } from '@/lib/errors';
import { handle, json } from '@/lib/http';
import { currentPrincipals, requireLearner } from '@/lib/session';

/**
 * One drill's debrief, for the learner who lived it and for nobody else.
 *
 * Unlike `GET /api/drills/[id]`, a guardian cannot reach this at all: it carries the sentence
 * that was the moment to hang up and the quotes behind every flag, which are transcript text
 * (PRD F7 AC2). `requireLearner` is therefore the first thing that happens, and a guardian gets
 * a 401 whatever member id they name. What a guardian may see is a band and a date, and it
 * reaches them through the dashboard's own server render, never through this route.
 *
 * `resolveMember` is still called afterwards, with `['learner']` only, so the drill is looked for
 * inside the learner's own member row and an id from another household simply does not resolve.
 */

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle('drills.debrief', async () => {
    const learner = await requireLearner();
    const { member } = await resolveMember(await currentPrincipals(), learner.m, ['learner']);
    const { id } = await params;
    const drill = await getDrill(member.memberId, id);
    if (!drill) throw notFound();
    /*
     * The debrief is transcript text, so the decision belongs in policy: the learner's own
     * `permit` covers them whatever their sharing switch says, and anyone else is denied.
     */
    await requireAuthz(
      buildLearnerPrincipal(member.memberId, member.householdId, member.status),
      VP_ACTIONS.VIEW_TRANSCRIPT,
      buildDrillResource(drill.drillId, drill.householdId, drill.memberId, member.transcriptSharing),
    );
    return json(await learnerDebrief(drill));
  });
}
