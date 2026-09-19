import { NextResponse, type NextRequest } from 'next/server';
import { completeLogin } from '@/lib/auth-flow';
import { GUARDIAN_COOKIE, OAUTH_COOKIE } from '@/lib/auth';
import { config } from '@/lib/config';
import { errorFields, log } from '@/lib/log';
import { cookieOptions } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const appUrl = config.appUrl(request.nextUrl.origin);
  try {
    const { idToken, maxAge, next } = await completeLogin(appUrl, request.nextUrl.searchParams, request.cookies.get(OAUTH_COOKIE)?.value);
    const response = NextResponse.redirect(`${appUrl}${next}`);
    response.cookies.set(GUARDIAN_COOKIE, idToken, cookieOptions(maxAge));
    response.cookies.delete(OAUTH_COOKIE);
    return response;
  } catch (error) {
    log.warn('auth.callback_failed', errorFields(error));
    const response = NextResponse.redirect(`${appUrl}/?auth=failed`);
    response.cookies.delete(OAUTH_COOKIE);
    return response;
  }
}
