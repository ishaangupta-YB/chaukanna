import { resolveMember } from '@/lib/access';
import { config } from '@/lib/config';
import { assertSameOrigin, handle, json } from '@/lib/http';
import { reissueInvite } from '@/lib/invites';
import { currentPrincipals } from '@/lib/session';

/** Guardian only: a fresh 72 hour link. The previous link stops working. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle('members.reinvite', async () => {
    const appUrl = config.appUrl(new URL(request.url).origin);
    assertSameOrigin(request, appUrl);
    const { id } = await params;
    const { member } = await resolveMember(await currentPrincipals(), id, ['guardian']);
    return json(await reissueInvite(member, appUrl), 201);
  });
}
