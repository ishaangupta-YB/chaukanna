import Link from 'next/link';

export default function GuardianLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b border-stone-200 bg-white">
        <nav className="mx-auto flex max-w-3xl items-center justify-between px-5 py-3">
          <Link href="/app" className="text-xl font-bold text-amber-800">
            चौकन्ना Chaukanna
          </Link>
          <a href="/api/auth/logout" className="min-h-11 content-center px-2 font-medium text-stone-700">
            Sign out
          </a>
        </nav>
      </header>
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-5 py-6 text-lg">{children}</main>
    </div>
  );
}
