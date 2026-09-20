import { z } from 'zod';
import { config } from '@/lib/config';
import { Language } from '@/lib/db';
import { assertSameOrigin, handle, json, parseBody } from '@/lib/http';
import { createLearner } from '@/lib/invites';
import { requireGuardian } from '@/lib/session';

const Body = z.object({ displayName: z.string().trim().min(1).max(60), language: Language });

/** Guardian creates a learner and gets a single use invite link -> { memberId, inviteUrl }. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle('members.create', async () => {
    const appUrl = config.appUrl(new URL(request.url).origin);
    assertSameOrigin(request, appUrl);
    const guardian = await requireGuardian();
    const { id } = await params;
    const input = await parseBody(request, Body);
    return json(await createLearner(guardian, id, input, appUrl), 201);
  });
}
