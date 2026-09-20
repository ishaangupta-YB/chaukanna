import { getScore, listDrills, type Drill, type JudgeMark, type Score, type ScoreBand } from './db';
import { notFound } from './errors';
import { log } from './log';
import { presignGet } from './s3';

/**
 * What a finished drill looks like to the person who lived it, and what the same drill looks like
 * to their family. Two mappers, one file, because the difference between them is the product's
 * central privacy promise and it should be readable in one screenful.
 *
 * The learner gets everything: the band, the number, the sentence that was the moment to hang up,
 * and the quote behind every flag. The guardian gets a band and a date (PRD F7 AC2). Nothing in
 * `GuardianDrillRow` is derived from transcript text, and that is a property the tests assert
 * rather than a convention anybody has to remember.
 */

export type DebriefStatus = 'pending' | 'scored' | 'score_failed';

/** One thing the judge recognised, with the learner's own words behind it. Fired ones only. */
export interface DebriefMark {
  id: string;
  evidence?: string;
}

export interface DebriefView {
  drillId: string;
  status: DebriefStatus;
  endedAt?: string;
  /** Present only when `status === 'scored'`. Never guessed (PRD F5 AC5). */
  band?: ScoreBand;
  score?: number;
  turningPoint?: string;
  debriefText?: string;
  /** Presigned GET for `debrief/<drillId>.mp3`, absent when Polly never produced one. */
  audioUrl?: string;
  flags: DebriefMark[];
  credits: DebriefMark[];
}

/** States in which a drill has a debrief, or will have one shortly. */
const DEBRIEFABLE = new Set<Drill['state']>(['ended', 'scored', 'score_failed']);

/**
 * The learner's most recent call that actually happened, for the link on `/me`. A drill that was
 * cancelled or never answered is not one of these: there is nothing to debrief.
 */
export async function lastDebriefableDrill(memberId: string): Promise<Drill | null> {
  const drills = await listDrills(memberId, 5);
  return drills.find((drill) => DEBRIEFABLE.has(drill.state)) ?? null;
}

function fired(marks: Record<string, JudgeMark> | undefined): DebriefMark[] {
  return Object.entries(marks ?? {})
    .filter(([, mark]) => mark.fired)
    .map(([id, mark]) => ({ id, evidence: mark.evidence || undefined }));
}

/**
 * The learner's own debrief.
 *
 * Three answers, and the third is the one that matters most:
 *
 * - no score row yet: `pending`. The state machine is still running, and the screen waits rather
 *   than inventing anything.
 * - `scored`: everything, plus a link to the audio when there is audio. A debrief whose Polly
 *   step failed is still a debrief — the text is on the screen either way, because plenty of
 *   learners never turn the sound on.
 * - `score_failed`: the status and nothing else. No band, no number, not even a rounded one. The
 *   screen falls back to the generic debrief, which is the three rules and an encouraging line.
 *
 * A drill that never became a call has no debrief at all and is reported as not found, the same
 * way an id from another household is, so nothing can be probed through this.
 */
export async function learnerDebrief(drill: Drill): Promise<DebriefView> {
  if (!DEBRIEFABLE.has(drill.state)) throw notFound();

  const score = await getScore(drill.drillId);
  if (!score) return { drillId: drill.drillId, status: 'pending', endedAt: drill.endedAt, flags: [], credits: [] };

  if (score.status === 'score_failed' || !score.band) {
    return {
      drillId: drill.drillId,
      status: 'score_failed',
      endedAt: drill.endedAt,
      flags: [],
      credits: [],
    };
  }

  return {
    drillId: drill.drillId,
    status: 'scored',
    endedAt: drill.endedAt,
    band: score.band,
    score: score.score,
    turningPoint: score.turningPoint,
    debriefText: score.debriefText,
    audioUrl: await debriefAudioUrl(drill.drillId, score),
    flags: fired(score.flags),
    credits: fired(score.credits),
  };
}

/**
 * A link to the spoken debrief, or nothing.
 *
 * Presigning is one signature and no network call, so it cannot really fail — but if it ever
 * does, a learner should still get their debrief in text rather than an error page. Sound is the
 * nicer half of this screen, never the necessary one.
 */
async function debriefAudioUrl(drillId: string, score: Score): Promise<string | undefined> {
  if (!score.debriefAudioKey) return undefined;
  try {
    return await presignGet(score.debriefAudioKey);
  } catch (error) {
    log.error('debrief.presign_failed', { drillId, reason: error instanceof Error ? error.name : 'unknown' });
    return undefined;
  }
}

/** What a guardian may see about one drill, and the whole of it. */
export interface GuardianDrillRow {
  drillId: string;
  /** The drill's own outcome, so that "not answered" and "still scoring" read differently. */
  state: Drill['state'];
  /** Present only for a drill that scored. Absent is absent; it is never filled in with a guess. */
  band?: ScoreBand;
  /** When the call happened, or was due to. */
  at: string;
}

/**
 * The guardian's view of a drill: a band and a date.
 *
 * Deliberately built by naming the four fields that may cross, rather than by deleting fields
 * from the score row. A spread with a delete list breaks silently the day the pipeline adds a
 * field; this cannot. There is no branch here that can emit `turningPoint`, `debriefText`,
 * `evidence` or `score`, and `lib/debrief.test.ts` asserts that over the fullest score row the
 * pipeline can produce.
 *
 * Phase 6 is what adds the Cedar policy that could ever grant more than this, and only when the
 * learner has turned sharing on themselves.
 */
export function toGuardianBand(drill: Drill, score: Score | undefined): GuardianDrillRow {
  return {
    drillId: drill.drillId,
    state: drill.state,
    band: score?.status === 'scored' ? score.band : undefined,
    at: drill.endedAt ?? drill.scheduledAt,
  };
}
