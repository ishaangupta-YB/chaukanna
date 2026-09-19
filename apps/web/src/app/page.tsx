import Link from "next/link";

export default function Home() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center justify-center px-4 py-12 selection:bg-amber-500 selection:text-black">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,_var(--tw-gradient-stops))] from-amber-500/10 via-slate-950/50 to-slate-950 pointer-events-none" />

      <main className="relative z-10 max-w-2xl w-full text-center space-y-8">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-amber-500/30 bg-amber-500/10 text-amber-300 text-xs font-medium tracking-wide uppercase">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          Phase 0: Foundations Active
        </div>

        <div className="space-y-4">
          <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight text-white">
            चौकन्ना <span className="text-amber-400">Chaukanna</span>
          </h1>
          <p className="text-lg text-slate-400 leading-relaxed max-w-xl mx-auto">
            Consented practice scam calls that train Indian families against digital arrest fraud.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-left">
          <div className="p-4 rounded-xl border border-slate-800 bg-slate-900/60 backdrop-blur">
            <h2 className="text-sm font-semibold text-slate-200 mb-1">Architecture</h2>
            <p className="text-xs text-slate-400">
              Next.js 15 App Router on Amplify, Amazon Nova 2 Sonic voice agent via Bedrock AgentCore, and DynamoDB single-table design.
            </p>
          </div>

          <div className="p-4 rounded-xl border border-slate-800 bg-slate-900/60 backdrop-blur">
            <h2 className="text-sm font-semibold text-slate-200 mb-1">Safety First</h2>
            <p className="text-xs text-slate-400">
              Explicit consent required, session caps, live tripwire controls, and no data collection surface in drills.
            </p>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-4 pt-4">
          <Link
            href="/api/health"
            className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold text-sm transition-colors shadow-lg shadow-amber-500/20"
          >
            Check System Health (/api/health)
          </Link>
          <a
            href="https://github.com"
            target="_blank"
            rel="noopener noreferrer"
            className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg border border-slate-800 bg-slate-900 hover:bg-slate-800 text-slate-300 font-medium text-sm transition-colors"
          >
            View Repository
          </a>
        </div>
      </main>

      <footer className="relative z-10 mt-16 text-center text-xs text-slate-500">
        Chaukanna &bull; AI Scam Defense Simulator &bull; Built with AWS Bedrock &amp; Amplify
      </footer>
    </div>
  );
}
