import { NextResponse } from 'next/server';
import { config } from '@/lib/config';
import { assertSameOrigin, handle } from '@/lib/http';
import { acceptInvite } from '@/lib/invites';
import { LEARNER_COOKIE } from '@/lib/learner-session';
import { cookieOptions } from '@/lib/session';

/** Idempotent: a double tap returns the same member and a fresh learner cookie. */
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  return handle('invites.accept', async () => {
    assertSameOrigin(request, config.appUrl(new URL(request.url).origin));
    const { token } = await params;
    const { member, session } = await acceptInvite(token);
    const response = NextResponse.json(
      { memberId: member.memberId, language: member.language, status: member.status },
      { headers: { 'cache-control': 'no-store' } },
    );
    response.cookies.set(LEARNER_COOKIE, session.value, cookieOptions(session.maxAge));
    return response;
  });
}
