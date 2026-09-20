import { z } from 'zod';
import { resolveMember } from '@/lib/access';
import { config } from '@/lib/config';
import { CONSENT_AUDIO_TYPES, createConsentUpload, type ConsentAudioType } from '@/lib/consent';
import { assertSameOrigin, handle, json, parseBody } from '@/lib/http';
import { currentPrincipals } from '@/lib/session';

const Body = z.object({
  contentType: z.enum(Object.keys(CONSENT_AUDIO_TYPES) as [ConsentAudioType, ...ConsentAudioType[]]),
});

/** Presigned PUT for the spoken consent line, consent/<memberId>/<iso>.<ext>. Learner only. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle('consent.upload_url', async () => {
    assertSameOrigin(request, config.appUrl(new URL(request.url).origin));
    const { id } = await params;
    const { member } = await resolveMember(await currentPrincipals(), id, ['learner']);
    const { contentType } = await parseBody(request, Body);
    return json(await createConsentUpload(member, contentType));
  });
}
