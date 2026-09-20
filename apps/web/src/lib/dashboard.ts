import type { Drill, Score, ScoreBand } from './db';

/**
 * What the guardian dashboard shows about a learner, computed from rows somebody else fetched.
 *
 * Every function here is pure. Nothing in this file reads DynamoDB, presigns anything or decides
 * who may look: the page does the authorisation and the fetching, and hands the rows over. That
 * is what makes the interesting part — which way a learner is trending, and which tactic keeps
 * catching them — testable without a table, and it is why `dashboard.test.ts` can assert the
 * tie break without inventing an AWS client.
 *
 * Bands only. A `Score` row carries quotes (`turningPoint`, `debriefText`, every `evidence`
 * string) and those belong to the learner alone (PRD F7 AC2). Nothing that crosses out of here
 * is derived from transcript text: a band, a date, a flag id and a count.
 */

/** Worst to best. The order is the trend: a step up is improvement, a step down is not. */
const BAND_RANK: Record<ScoreBand, number> = { at_risk: 0, wobbly: 1, safe: 2 };

/**
 * The rubric's flag ids, in the guardian's words (`services/scoring/scoring_service/rubric.py`).
 *
 * Phrased as what the caller got the learner to do, not as something the learner got wrong. The
 * debrief's no-blame rule (PRD F5) is not suspended because the reader is family. An id the
 * rubric grows later falls through to a readable fallback rather than printing snake_case.
 */
const FLAG_LABELS: Record<string, string> = {
  stayed_on_call: 'Stayed on the call',
  accepted_secrecy: 'Agreed to keep it secret',
  shared_identifier: 'Read out an ID number',
  agreed_to_move_money: 'Agreed to move money',
  accepted_authority: 'Took the caller for a real official',
};

/** Never a raw id at the judge: an unknown flag becomes "Accepted authority" rather than shouting. */
export function flagLabel(id: string): string {
  return FLAG_LABELS[id] ?? id.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

/** One scored drill, as the trend list renders it. */
export interface BandPoint {
  drillId: string;
  band: ScoreBand;
  /** When the call happened, or was due to. */
  at: string;
}

export type TrendDirection = 'better' | 'worse' | 'same';

/** The step between two consecutive scored drills, oldest first. */
export interface TrendStep {
  direction: TrendDirection;
  from: ScoreBand;
  to: ScoreBand;
}

/** The flag that fired most often across a learner's scored drills. */
export interface WeakestTactic {
  id: string;
  label: string;
  count: number;
}

export interface LearnerProgress {
  /** Chronological, oldest first. Empty when nothing has scored yet. */
  points: BandPoint[];
  /** `points.length - 1` steps, so `steps[i]` sits between `points[i]` and `points[i + 1]`. */
  steps: TrendStep[];
  /** First band against last. Null with fewer than two scored drills: one drill is not a trend. */
  overall: TrendDirection | null;
  weakest: WeakestTactic | null;
}

/**
 * The scored half of a learner's history, oldest first.
 *
 * A drill with no score row, or one the pipeline could not read (`score_failed`), has no band and
 * is left out rather than guessed at (PRD F5 AC5). It still appears in the history list on the
 * page with its own honest word; it just cannot be a point on a trend.
 */
export function bandPoints(drills: readonly Drill[], scores: ReadonlyMap<string, Score>): BandPoint[] {
  return drills
    .flatMap((drill) => {
      const score = scores.get(drill.drillId);
      if (!score || score.status !== 'scored' || !score.band) return [];
      return [{ drillId: drill.drillId, band: score.band, at: drill.endedAt ?? drill.scheduledAt }];
    })
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

function direction(from: ScoreBand, to: ScoreBand): TrendDirection {
  if (BAND_RANK[to] > BAND_RANK[from]) return 'better';
  if (BAND_RANK[to] < BAND_RANK[from]) return 'worse';
  return 'same';
}

/**
 * The flag that caught this learner most often.
 *
 * Ties are broken by the most recent firing, then by id. Recency rather than the rubric's weight
 * because this line answers "what should we talk about", and the thing that happened last week
 * is the more useful answer; the id is there only so the same history always produces the same
 * sentence and the test can hold it to that.
 */
export function weakestTactic(
  drills: readonly Drill[],
  scores: ReadonlyMap<string, Score>,
): WeakestTactic | null {
  const at = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const drill of drills) {
    const score = scores.get(drill.drillId);
    if (!score || score.status !== 'scored') continue;
    const when = drill.endedAt ?? drill.scheduledAt;
    for (const [id, mark] of Object.entries(score.flags ?? {})) {
      if (!mark.fired) continue;
      counts.set(id, (counts.get(id) ?? 0) + 1);
      const seen = at.get(id);
      if (!seen || Date.parse(when) > Date.parse(seen)) at.set(id, when);
    }
  }

  const [top] = [...counts.entries()].sort(
    ([idA, countA], [idB, countB]) =>
      countB - countA ||
      Date.parse(at.get(idB) ?? '') - Date.parse(at.get(idA) ?? '') ||
      idA.localeCompare(idB),
  );
  return top ? { id: top[0], label: flagLabel(top[0]), count: top[1] } : null;
}

export function learnerProgress(
  drills: readonly Drill[],
  scores: ReadonlyMap<string, Score>,
): LearnerProgress {
  const points = bandPoints(drills, scores);
  const steps = points.slice(1).map((point, i) => ({
    direction: direction(points[i].band, point.band),
    from: points[i].band,
    to: point.band,
  }));
  const overall = points.length >= 2 ? direction(points[0].band, points[points.length - 1].band) : null;
  return { points, steps, overall, weakest: weakestTactic(drills, scores) };
}

/**
 * The next call that will ring, or nothing. Earliest first, because "next" is the soonest one and
 * `listDrills` hands them over newest first.
 */
export function nextScheduled(drills: readonly Drill[]): Drill | null {
  return (
    [...drills]
      .filter((drill) => drill.state === 'scheduled')
      .sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt))[0] ?? null
  );
}

/** Every time on these screens is IST and says so. A bare timestamp is a support call. */
export function istDateTime(at: string): string {
  return new Date(at).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}
