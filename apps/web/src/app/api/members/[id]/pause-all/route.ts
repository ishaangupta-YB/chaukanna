import { resolveMember } from '@/lib/access';
import { config } from '@/lib/config';
import { assertSameOrigin, handle, json } from '@/lib/http';
import { pauseAll } from '@/lib/members';
import { currentPrincipals } from '@/lib/session';

/** Kill switch, reachable from every learner screen. Idempotent. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle('members.pause_all', async () => {
    assertSameOrigin(request, config.appUrl(new URL(request.url).origin));
    const { id } = await params;
    const { member, actor } = await resolveMember(await currentPrincipals(), id, ['learner', 'guardian']);
    await pauseAll(member, actor);
    return json({ status: 'paused' });
  });
}
