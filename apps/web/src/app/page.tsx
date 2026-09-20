import Link from 'next/link';
import { currentGuardian } from '@/lib/session';

export const dynamic = 'force-dynamic';

const cta =
  'inline-flex min-h-14 items-center justify-center self-start rounded-xl bg-emerald-700 px-6 text-xl font-semibold text-white';

export default async function Home({ searchParams }: { searchParams: Promise<{ auth?: string }> }) {
  const { auth } = await searchParams;
  const guardian = await currentGuardian().catch(() => null);
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
