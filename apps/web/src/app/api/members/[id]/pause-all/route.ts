import { resolveMember } from '@/lib/access';
import { config } from '@/lib/config';
import { cancelPendingDrills } from '@/lib/drills';
import { assertSameOrigin, handle, json } from '@/lib/http';
import { pauseAll } from '@/lib/members';
import { currentPrincipals } from '@/lib/session';

/**
 * Kill switch, reachable from every learner screen. Idempotent.
 *
 * Pausing is not only a flag: it reaches every drill that has not become a call yet and cancels
 * it, schedule and all (PRD F2 AC4). A learner who presses this must not be rung an hour later by
 * something that was already in flight.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle('members.pause_all', async () => {
    assertSameOrigin(request, config.appUrl(new URL(request.url).origin));
    const { id } = await params;
    const { member, actor } = await resolveMember(await currentPrincipals(), id, ['learner', 'guardian']);
    await pauseAll(member, actor);
    const cancelled = await cancelPendingDrills(member, 'paused');
    return json({ status: 'paused', cancelled });
  });
}
