import { NextResponse } from 'next/server';
import { config } from '@/lib/config';
import { assertDemoFormPost, DEMO_COOKIE } from '@/lib/demo';
import { notFound } from '@/lib/errors';
import { handle } from '@/lib/http';

export const dynamic = 'force-dynamic';

/**
 * Ends a demo session by dropping the cookie. The seeded household stays behind for whoever
 * cleans up demo rows; nothing here deletes data.
 *
 * The ordinary "Sign out" goes to Cognito managed login, which has nothing to say about a demo
 * session, so the demo badge offers this instead.
 */
export async function POST(request: Request) {
  return handle('demo.exit', async () => {
    if (!config.demoMode) throw notFound();
    const appUrl = config.appUrl(new URL(request.url).origin);
    assertDemoFormPost(request, appUrl);
    const response = NextResponse.redirect(`${appUrl}/`, 303);
    response.cookies.delete(DEMO_COOKIE);
    return response;
  });
}
