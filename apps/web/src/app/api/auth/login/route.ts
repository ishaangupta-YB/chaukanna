import { NextResponse, type NextRequest } from 'next/server';
import { OAUTH_COOKIE, safeNextPath, startOAuth } from '@/lib/auth';
import { config } from '@/lib/config';
import { handle } from '@/lib/http';
import { cookieOptions } from '@/lib/session';

export const dynamic = 'force-dynamic';

/** Starts Cognito managed login (authorization code + PKCE). */
export async function GET(request: NextRequest) {
  return handle('auth.login', async () => {
    const appUrl = config.appUrl(request.nextUrl.origin);
    const next = safeNextPath(request.nextUrl.searchParams.get('next'));
    const oauth = startOAuth(appUrl);
    const response = NextResponse.redirect(oauth.authorizeUrl);
    const state = Buffer.from(JSON.stringify({ s: oauth.state, v: oauth.verifier, n: next })).toString('base64url');
    response.cookies.set(OAUTH_COOKIE, state, cookieOptions(10 * 60));
    return response;
  });
}
