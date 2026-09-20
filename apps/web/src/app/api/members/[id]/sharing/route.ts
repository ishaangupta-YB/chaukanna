import { z } from 'zod';
import { resolveMember } from '@/lib/access';
import { config } from '@/lib/config';
import { assertSameOrigin, handle, json, parseBody } from '@/lib/http';
import { setSharing } from '@/lib/members';
import { currentPrincipals } from '@/lib/session';

const Body = z.object({ transcriptSharing: z.boolean() });

/**
 * The learner alone decides whether their family may read what they said (PRD F7 AC2). Guardians
 * are not in the allowed actors here on purpose: the whole point of the flag is that it cannot be
 * granted by the person it grants access to.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle('members.sharing', async () => {
    assertSameOrigin(request, config.appUrl(new URL(request.url).origin));
    const { id } = await params;
    const { member } = await resolveMember(await currentPrincipals(), id, ['learner']);
    const { transcriptSharing } = await parseBody(request, Body);
    await setSharing(member, transcriptSharing);
    return json({ transcriptSharing });
  });
}
