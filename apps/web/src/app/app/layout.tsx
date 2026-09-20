import { headers } from 'next/headers';
import Link from 'next/link';
import { config } from '@/lib/config';
import { inviteUrl } from '@/lib/invites';
import { currentDemoSession } from '@/lib/session';

/**
 * The guardian shell. When the session is a judge demo one it wears an unmissable badge: nobody
 * looking at this screen, or reviewing this repository, should be in any doubt that the data
 * behind it is throwaway and that nobody signed in.
 */
export default async function GuardianLayout({ children }: { children: React.ReactNode }) {
  const demo = await currentDemoSession();

  return (
    <div className="flex flex-1 flex-col">
      {demo && <DemoBanner inviteToken={demo.i} />}
      <header className="border-b border-stone-200 bg-white">
        <nav className="mx-auto flex max-w-3xl items-center justify-between px-5 py-3">
          <Link href="/app" className="text-xl font-bold text-amber-800">
            चौकन्ना Chaukanna
          </Link>
          {demo ? (
            <form method="post" action="/api/demo/exit">
              <button type="submit" className="min-h-11 px-2 font-medium text-stone-700">
                End demo
              </button>
            </form>
          ) : (
            <a href="/api/auth/logout" className="min-h-11 content-center px-2 font-medium text-stone-700">
              Sign out
            </a>
          )}
        </nav>
      </header>
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-5 py-6 text-lg">{children}</main>
    </div>
  );
}

async function DemoBanner({ inviteToken }: { inviteToken: string }) {
  // Mirrors what a route handler does with request.nextUrl.origin: prefer APP_URL, fall back to
  // the host this request actually arrived on, so the link a judge opens on a phone is absolute.
  const requestHeaders = await headers();
  const host = requestHeaders.get('host');
  const proto = requestHeaders.get('x-forwarded-proto') ?? (host?.startsWith('localhost') ? 'http' : 'https');
  const url = inviteUrl(config.appUrl(host ? `${proto}://${host}` : undefined), inviteToken);

  return (
    <div className="border-b-4 border-amber-600 bg-amber-100 px-5 py-3 text-amber-950">
      <div className="mx-auto flex max-w-3xl flex-col gap-2">
        <p className="text-lg font-bold">Demo session — not a real account</p>
        <p className="text-base">
          Nobody is signed in. This household and everyone in it were made up when you pressed the button, and no real
          family&apos;s data is reachable from here.
        </p>
        <p className="text-base">
          Open the learner side on your phone:{' '}
          <a href={url} className="font-mono text-sm break-all underline">
            {url}
          </a>
        </p>
      </div>
    </div>
  );
}
