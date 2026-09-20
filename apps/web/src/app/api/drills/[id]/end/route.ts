import { resolveMember } from '@/lib/access';
import { config } from '@/lib/config';
import { cancelDrill, getDrill } from '@/lib/db';
import { notFound } from '@/lib/errors';
import { assertSameOrigin, handle, json } from '@/lib/http';
import { log } from '@/lib/log';
import { currentPrincipals, requireLearner } from '@/lib/session';

/**
 * Closes a drill that never reached the agent: the learner declined the call, or the socket
 * failed before the model connected. Without it a drill would sit `session_pending` until
 * somebody noticed, and the weekly cap would count a call nobody took.
 *
 * It cannot end a call that is happening. Once the agent has claimed the drill, the agent owns
 * how it ends and what gets written, and the conditional write here simply does nothing. That is
 * deliberate: the outcome of a real call must not be something a browser can post.
 */

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle('drills.end', async () => {
    assertSameOrigin(request, config.appUrl(new URL(request.url).origin));
    const learner = await requireLearner();
    const { member } = await resolveMember(await currentPrincipals(), learner.m, ['learner']);
    const { id } = await params;
    const drill = await getDrill(member.memberId, id);
    if (!drill) throw notFound();

    const closed = await cancelDrill(drill, new Date().toISOString(), 'browser_gave_up');
    log.info('drill.end_requested', {
      householdId: member.householdId,
      memberId: member.memberId,
      drillId: drill.drillId,
      closed,
    });
    // `closed: false` is the normal answer once the agent owns the call, not an error.
    return json({ drillId: drill.drillId, closed });
  });
}
