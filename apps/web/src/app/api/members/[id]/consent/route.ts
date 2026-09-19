import { z } from 'zod';
import { resolveMember } from '@/lib/access';
import { config } from '@/lib/config';
import { recordConsent, withdrawConsent } from '@/lib/consent';
import { ConsentCategory, ConsentMethod, Language } from '@/lib/db';
import { assertSameOrigin, handle, json, parseBody } from '@/lib/http';
import { currentPrincipals } from '@/lib/session';

const Body = z.object({
  method: ConsentMethod,
  language: Language,
  categories: z.array(ConsentCategory).min(1),
  audioKey: z.string().max(200).optional(),
});

/** Consent is the learner's alone. A guardian can pause, never consent on someone's behalf. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle('consent.record', async () => {
    assertSameOrigin(request, config.appUrl(new URL(request.url).origin));
    const { id } = await params;
    const { member } = await resolveMember(await currentPrincipals(), id, ['learner']);
    const result = await recordConsent(member, await parseBody(request, Body));
    return json(result, result.replay ? 200 : 201);
  });
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle('consent.revoke', async () => {
    assertSameOrigin(request, config.appUrl(new URL(request.url).origin));
    const { id } = await params;
    const { member } = await resolveMember(await currentPrincipals(), id, ['learner']);
    await withdrawConsent(member);
    return json({ status: 'revoked' });
  });
}
