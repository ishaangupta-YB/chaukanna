import Link from 'next/link';
import { config } from '@/lib/config';
import { currentGuardian } from '@/lib/session';

export const dynamic = 'force-dynamic';

const ctaBase = 'inline-flex min-h-14 items-center justify-center self-start rounded-xl px-6 text-xl font-semibold text-white';
const cta = `${ctaBase} bg-emerald-700`;
/** Amber, not the emerald of the real sign-in, so the demo never looks like the way in. */
const demoCta = `${ctaBase} bg-amber-700`;

export default async function Home({ searchParams }: { searchParams: Promise<{ auth?: string }> }) {
  const { auth } = await searchParams;
  const guardian = await currentGuardian().catch(() => null);
  const demoMode = config.demoMode;
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-8 px-5 py-12">
      <div className="flex flex-col gap-4">
        <h1 className="text-4xl font-extrabold tracking-tight sm:text-5xl">
          चौकन्ना <span className="text-amber-700">Chaukanna</span>
        </h1>
        <p className="text-xl leading-relaxed text-stone-700">
          Consented practice scam calls that train Indian families against digital arrest fraud. Your parents rehearse
          hanging up, in their own language, before a real scammer ever calls.
        </p>
      </div>
      {demoMode && !guardian && (
        /*
         * The judge entry point, deliberately above the fold and impossible to miss. A form POST
         * rather than a link: /api/demo/start mints a household, so it must not be prefetchable.
         */
        <form
          method="post"
          action="/api/demo/start"
          className="flex flex-col gap-3 rounded-2xl border-2 border-amber-600 bg-amber-50 p-5"
        >
          <p className="text-xl font-bold text-amber-900">Judging this? Try it now, no sign-in needed.</p>
          <p className="text-base text-stone-700">
            One click puts you in a guardian dashboard with a practice household already set up, plus the link to open
            the learner side on your phone. It is a throwaway demo account, not a real one, and it lasts two hours.
          </p>
          <button type="submit" className={demoCta}>
            Open the judge demo
          </button>
        </form>
      )}
      <ul className="flex flex-col gap-2 text-lg text-stone-800">
        <li>Nothing happens without their spoken consent.</li>
        <li>They can stop every practice call with one tap.</li>
        <li>You see how they did, never what they said, unless they choose to share.</li>
      </ul>
      {auth === 'failed' && (
        <p role="alert" className="text-red-800">
          Sign in did not complete. Please try again.
        </p>
      )}
      {guardian ? (
        <Link href="/app" className={cta}>
          Open your dashboard
        </Link>
      ) : (
        // A plain anchor: the login route handler must not be prefetched.
        <a href="/api/auth/login?next=/app" className={cta}>
          Continue with Google
        </a>
      )}
    </main>
  );
}
