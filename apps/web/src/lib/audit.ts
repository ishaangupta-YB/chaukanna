import type { Consent, Drill, DrillEndReason, Member, Score } from './db';
import { istDateTime } from './dashboard';

/**
 * The audit view's rows, built from rows somebody else fetched and authorised.
 *
 * One line per drill: who asked for it, the consent it was run under, which scenario and which
 * prompts produced it, and how it ended. It is a demo asset as much as an internal tool (phase 6
 * task 9), so every cell is a string that is already fit to project — no ids a human cannot read,
 * no snake_case, and no blank where a judge would wonder whether the field is missing or the
 * value is.
 *
 * Bands and metadata only. Nothing here touches a transcript, a quote or a score number: the
 * audit trail answers "was this drill run properly", not "what did she say".
 */

/** What a field that genuinely has no value prints as. One character, consistently. */
export const ABSENT = '—';

function absent(value: string | number | undefined | null): string {
  return value === undefined || value === null || value === '' ? ABSENT : String(value);
}

/**
 * How a drill ended, in words.
 *
 * `endReason` is written by the agent and only exists for a call that happened. A drill that was
 * cancelled or never answered has a state and no reason, and the state is the honest answer.
 */
const END_REASON: Record<DrillEndReason, string> = {
  completed: 'Ran to the end',
  safe_word: 'Safe word',
  is_this_real: 'Asked if it was real',
  distress: 'Stopped on distress',
  tripwire: 'Tripwire',
  timeout: 'Hit the time cap',
  hangup: 'Learner hung up',
  model_ended: 'Caller ended it',
  error: 'Error',
};

const STATE: Record<Drill['state'], string> = {
  scheduled: 'Scheduled',
  due: 'Ringing',
  session_pending: 'Ringing',
  in_progress: 'On the call',
  ended: 'Ended, scoring',
  scored: 'Scored',
  score_failed: 'Scoring failed',
  cancelled: 'Cancelled',
  missed: 'Not answered',
};

/** Who brought the drill into existence. The row records the kind of actor, not a person. */
const CREATED_BY: Record<Drill['createdBy'], string> = {
  guardian: 'Guardian',
  learner: 'Learner',
  scheduler: 'Scheduler',
};

/**
 * A consent's identity.
 *
 * There is no `consentId` attribute: a consent row is keyed by the member and the instant it was
 * given (`MEMBER#<memberId>#CONSENT#<at>`), so that instant *is* the id and is what a reader can
 * match against the table. A drill does not carry a reference to one, so this is the member's
 * latest consent at read time, which is the consent the drill was allowed under.
 */
export function consentRef(consent: Consent | null): string {
  if (!consent) return ABSENT;
  return `CONSENT#${consent.at}${consent.revokedAt ? ' (withdrawn)' : ''}`;
}

/** Prompt versions from both halves of the pipeline: the caller's prompts and the judge's. */
export function promptVersions(drill: Drill, score: Score | undefined): string {
  const parts = [
    ...Object.entries(drill.promptVersions ?? {}).map(([name, version]) => `${name} ${version}`),
    ...(score?.judgePromptVersion ? [`judge ${score.judgePromptVersion}`] : []),
    ...(score?.debriefPromptVersion ? [`debrief ${score.debriefPromptVersion}`] : []),
    ...(score?.rubricVersion ? [`rubric ${score.rubricVersion}`] : []),
  ];
  return parts.length ? parts.join(', ') : ABSENT;
}

export interface AuditEntry {
  drill: Drill;
  member: Member;
  consent: Consent | null;
  score?: Score;
}

export interface AuditRow {
  drillId: string;
  learner: string;
  scheduledAt: string;
  scheduledBy: string;
  consent: string;
  scenario: string;
  promptVersions: string;
  ending: string;
  endedAt: string;
}

/**
 * Newest first, across every learner in the household. Sorted on `scheduledAt` rather than on
 * when the row was written, because that is the column a reader is scanning.
 */
export function buildAuditRows(entries: readonly AuditEntry[]): AuditRow[] {
  return [...entries]
    .sort((a, b) => Date.parse(b.drill.scheduledAt) - Date.parse(a.drill.scheduledAt))
    .map(({ drill, member, consent, score }) => ({
      drillId: drill.drillId,
      learner: member.displayName,
      scheduledAt: istDateTime(drill.scheduledAt),
      scheduledBy: CREATED_BY[drill.createdBy],
      consent: consentRef(consent),
      scenario: `${drill.scenarioId} ${drill.scenarioVersion !== undefined ? `v${drill.scenarioVersion}` : ABSENT}`,
      promptVersions: promptVersions(drill, score),
      ending: drill.endReason ? `${END_REASON[drill.endReason]} (${STATE[drill.state]})` : STATE[drill.state],
      endedAt: drill.endedAt ? istDateTime(drill.endedAt) : absent(undefined),
    }));
}
