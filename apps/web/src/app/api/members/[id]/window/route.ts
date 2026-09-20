import { resolveMember } from '@/lib/access';
import { config } from '@/lib/config';
import { DrillWindow } from '@/lib/db';
import { assertSameOrigin, handle, json, parseBody } from '@/lib/http';
import { setWindow } from '@/lib/members';
import { currentPrincipals } from '@/lib/session';

/** Learner or guardian sets the weekly window, stored as Asia/Kolkata local times plus the tz. */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle('window.put', async () => {
    assertSameOrigin(request, config.appUrl(new URL(request.url).origin));
    const { id } = await params;
    const { member, actor } = await resolveMember(await currentPrincipals(), id, ['learner', 'guardian']);
    const window = await parseBody(request, DrillWindow);
    await setWindow(member, window, actor);
    return json({ window });
  });
}
