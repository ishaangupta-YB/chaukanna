import { NextResponse } from 'next/server';
import { config } from '@/lib/config';
import { assertDemoFormPost, DEMO_COOKIE, startDemo } from '@/lib/demo';
import { notFound } from '@/lib/errors';
import { handle } from '@/lib/http';
import { cookieOptions } from '@/lib/session';

export const dynamic = 'force-dynamic';

/**
 * Starts a judge demo session. POST only, and reached from a real `<form method="post">`, so it
 * cannot be prefetched, link-previewed or walked into by a crawler — every hit is a deliberate
 * click that mints a household.
 *
 * With `DEMO_MODE` anything other than "on" this is a 404, exactly as if the route did not exist.
 */
export async function POST(request: Request) {
  return handle('demo.start', async () => {
    if (!config.demoMode) throw notFound();
    const appUrl = config.appUrl(new URL(request.url).origin);
    assertDemoFormPost(request, appUrl);

    const { session } = await startDemo(appUrl);
    // 303, so the browser follows a POST with a GET.
    const response = NextResponse.redirect(`${appUrl}/app`, 303);
    response.cookies.set(DEMO_COOKIE, session.value, cookieOptions(session.maxAge));
    return response;
  });
}
