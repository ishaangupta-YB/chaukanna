import { NextResponse, type NextRequest } from 'next/server';
import { GUARDIAN_COOKIE, logoutUrl } from '@/lib/auth';
import { config } from '@/lib/config';
import { handle } from '@/lib/http';
import { currentGuardian } from '@/lib/session';
import { revokeHouseholdTokens } from '@/lib/db/households';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  return handle('auth.logout', async () => {
    const guardian = await currentGuardian();
    if (guardian) {
      const householdId = (await import('@/lib/households')).householdIdForGuardian(guardian.sub);
      await revokeHouseholdTokens(householdId);
    }
    const response = NextResponse.redirect(logoutUrl(config.appUrl(request.nextUrl.origin)));
    response.cookies.delete(GUARDIAN_COOKIE);
    return response;
  });
}
