import { NextResponse, type NextRequest } from 'next/server';
import { GUARDIAN_COOKIE, logoutUrl } from '@/lib/auth';
import { config } from '@/lib/config';
import { handle } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  return handle('auth.logout', async () => {
    const response = NextResponse.redirect(logoutUrl(config.appUrl(request.nextUrl.origin)));
    response.cookies.delete(GUARDIAN_COOKIE);
    return response;
  });
}
