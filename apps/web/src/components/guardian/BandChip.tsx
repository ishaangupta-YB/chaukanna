import type { Drill, ScoreBand } from '@/lib/db';

/**
 * The one place a band or a drill state becomes a coloured word.
 *
 * Both maps live here so the dashboard, the trend and the audit table cannot drift into three
 * different vocabularies for the same outcome. None of these words say fail, mistake, careless or
 * foolish: the learner's no-blame rule (PRD F5) is not suspended because the reader is family.
 */

export const BAND: Record<ScoreBand, { label: string; tone: string }> = {
  safe: { label: 'Safe', tone: 'bg-emerald-100 text-emerald-900' },
  wobbly: { label: 'Wobbly', tone: 'bg-amber-100 text-amber-900' },
  at_risk: { label: 'At risk', tone: 'bg-orange-100 text-orange-900' },
};

/**
 * How a drill without a band reads. A call nobody answered and a result still being prepared are
 * different things, and a guardian who cannot tell them apart will worry about the wrong one.
 */
export const OUTCOME: Record<Drill['state'], { label: string; tone: string }> = {
  scheduled: { label: 'Scheduled', tone: 'bg-stone-100 text-stone-800' },
  due: { label: 'Ringing now', tone: 'bg-amber-100 text-amber-900' },
  session_pending: { label: 'Ringing now', tone: 'bg-amber-100 text-amber-900' },
  in_progress: { label: 'On the call', tone: 'bg-amber-100 text-amber-900' },
  ended: { label: 'Result on the way', tone: 'bg-stone-100 text-stone-800' },
  scored: { label: 'Scored', tone: 'bg-stone-100 text-stone-800' },
  score_failed: { label: 'No result this time', tone: 'bg-stone-100 text-stone-800' },
  missed: { label: 'Not answered', tone: 'bg-stone-100 text-stone-800' },
  cancelled: { label: 'Cancelled', tone: 'bg-stone-100 text-stone-800' },
};

export function BandChip({ band, state }: { band?: ScoreBand; state: Drill['state'] }) {
  const chip = band ? BAND[band] : OUTCOME[state];
  return <span className={`rounded-full px-3 py-1 text-sm font-semibold ${chip.tone}`}>{chip.label}</span>;
}
