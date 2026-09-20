import { z } from 'zod';

/** Entity shapes stored in the single `chaukanna` table. See docs/PRD.md section 10. */

export const Language = z.enum(['hi-IN', 'en-IN']);
export type Language = z.infer<typeof Language>;

export const MemberStatus = z.enum(['invited', 'active', 'paused', 'revoked']);
export type MemberStatus = z.infer<typeof MemberStatus>;

const Id = z.string().regex(/^[a-f0-9]{8,64}$/);
const IsoTime = z.iso.datetime();

export const Household = z.object({
  householdId: Id,
  ownerSub: z.string().min(1),
  name: z.string().min(1).max(80),
  createdAt: IsoTime,
  /**
   * The guardian's Google address, as Google itself verified it. Kept so the ring Lambda has
   * somewhere to send the nudge when a drill goes due. There is deliberately no learner address
   * anywhere in this product: a learner has no account and needs no email client.
   */
  ownerEmail: z.email().optional(),
});
export type Household = z.infer<typeof Household>;

export const Member = z.object({
  memberId: Id,
  householdId: Id,
  displayName: z.string().min(1).max(60),
  language: Language,
  status: MemberStatus,
  createdAt: IsoTime,
  updatedAt: IsoTime,
  /** sha256 of the outstanding invite token. Absent once accepted. */
  inviteHash: z.string().optional(),
  inviteExpiresAt: z.number().int().optional(),
  /** sha256 of the token that was accepted, kept for the double tap grace window. */
  acceptedInviteHash: z.string().optional(),
  acceptedAt: IsoTime.optional(),
  consentAt: IsoTime.optional(),
  pausedAt: IsoTime.optional(),
  /** The learner decides this, off by default. Enforced by policy in Phase 6. */
  transcriptSharing: z.boolean(),
});
export type Member = z.infer<typeof Member>;

export const ConsentMethod = z.enum(['voice', 'typed']);
export type ConsentMethod = z.infer<typeof ConsentMethod>;

export const ConsentCategory = z.enum(['practice_calls', 'call_audio_7_days', 'outcome_to_family']);
export type ConsentCategory = z.infer<typeof ConsentCategory>;
export const CONSENT_CATEGORIES: ConsentCategory[] = ['practice_calls', 'call_audio_7_days', 'outcome_to_family'];

export const Consent = z.object({
  memberId: Id,
  householdId: Id,
  at: IsoTime,
  language: Language,
  method: ConsentMethod,
  /** S3 key of the spoken confirmation. Absent when the typed fallback was used. */
  audioKey: z.string().optional(),
  categories: z.array(ConsentCategory).min(1),
  revokedAt: IsoTime.optional(),
});
export type Consent = z.infer<typeof Consent>;

export const TIME_ZONE = 'Asia/Kolkata';
const HourMinute = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/** ISO weekdays, 1 = Monday ... 7 = Sunday. Local times in `tz`, never bare. */
export const DrillWindow = z
  .object({
    days: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    start: HourMinute,
    end: HourMinute,
    tz: z.literal(TIME_ZONE),
  })
  .refine((w) => new Set(w.days).size === w.days.length, { message: 'days must be unique' })
  .refine((w) => toMinutes(w.end) - toMinutes(w.start) >= 60, { message: 'window must be at least one hour' });
export type DrillWindow = z.infer<typeof DrillWindow>;

export const StoredWindow = z.object({
  memberId: Id,
  window: DrillWindow,
  updatedAt: IsoTime,
  updatedBy: z.enum(['learner', 'guardian']),
});
export type StoredWindow = z.infer<typeof StoredWindow>;

export const DEFAULT_WINDOW: DrillWindow = { days: [1, 2, 3, 4, 5], start: '11:00', end: '18:00', tz: TIME_ZONE };

export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/**
 * A drill's life:
 *
 *   scheduled ──(the ring Lambda fires)──▶ due ──(a session token is minted)──▶ session_pending
 *   session_pending ──(the agent claims it, once)──▶ in_progress ──(the call ends)──▶ ended
 *   ended ──(the scoring pipeline finished)──▶ scored
 *   ended ──(redaction, the judge or the rubric failed)──▶ score_failed
 *   due | session_pending ──(nobody answered in 30 minutes)──▶ missed
 *   scheduled | due | session_pending ──(consent revoked, paused, declined)──▶ cancelled
 *
 * Every transition is a conditional update that names the state it expects to find. Never a blind
 * write: a scheduler firing a second after a cancellation must not resurrect the drill.
 *
 * `cancelled` is the kill switch reaching a drill that never rang; `missed` is a drill that rang
 * and was not answered. The difference is the learner's, not ours — a missed drill counts against
 * the weekly cap because their phone did ring, a cancelled one does not because nobody was called.
 * The only transition the agent performs is `session_pending` to `in_progress`, and it is a
 * conditional write, which is what makes a session token single use.
 *
 * `scored` and `score_failed` are terminal and reachable only from `ended`, written by the
 * scoring state machine's `finish` task. They are two outcomes of the same pipeline, not a good
 * one and a bad one: `score_failed` means the machine could not read the call, never that the
 * learner did badly. A drill that is `ended` and not yet either is simply still being scored.
 */
export const DrillState = z.enum([
  'scheduled',
  'due',
  'session_pending',
  'in_progress',
  'ended',
  'scored',
  'score_failed',
  'cancelled',
  'missed',
]);
export type DrillState = z.infer<typeof DrillState>;

export const DrillEndReason = z.enum([
  'completed',
  'safe_word',
  'is_this_real',
  'distress',
  'tripwire',
  'timeout',
  'hangup',
  'model_ended',
  'error',
]);
export type DrillEndReason = z.infer<typeof DrillEndReason>;

/**
 * What the drill row keeps about a red flag: which one, and where. Never the quote. The quote is
 * transcript text, and a guardian may not read a transcript (PRD F7 AC2), so it stays in the S3
 * object that only the scoring pipeline opens.
 */
export const RedFlagMark = z.object({
  id: z.string().min(1).max(40),
  stage: z.string().min(1).max(4),
  seq: z.number().int().nonnegative(),
});
export type RedFlagMark = z.infer<typeof RedFlagMark>;

export const Drill = z.object({
  drillId: Id,
  memberId: Id,
  householdId: Id,
  scenarioId: z.string().min(1).max(64),
  language: Language,
  state: DrillState,
  /** Also the timestamp inside the sort key, so it addresses the row. */
  scheduledAt: IsoTime,
  createdAt: IsoTime,
  updatedAt: IsoTime,
  createdBy: z.enum(['guardian', 'learner', 'scheduler']),
  maxSeconds: z.number().int().min(10).max(900),

  /** Set while a session token is outstanding; the agent's claim removes both. */
  sessionJti: z.string().optional(),
  sessionExpiresAt: z.number().int().optional(),

  /** When the ring Lambda flipped `scheduled` to `due`. */
  dueAt: IsoTime.optional(),
  /**
   * Epoch seconds, thirty minutes after `dueAt`: the moment an unanswered drill becomes `missed`.
   * Deliberately NOT the table's `ttl` attribute, which would delete the row instead of expiring
   * the ring.
   */
  dueExpiresAt: z.number().int().optional(),

  startedAt: IsoTime.optional(),
  endedAt: IsoTime.optional(),
  endReason: DrillEndReason.optional(),
  endSource: z.string().max(60).optional(),
  finalStage: z.string().max(4).optional(),
  durationSeconds: z.number().nonnegative().optional(),
  redFlags: z.array(RedFlagMark).optional(),
  scenarioVersion: z.number().int().optional(),
  voice: z.string().max(40).optional(),
  promptVersions: z.record(z.string(), z.string()).optional(),
  /** S3 keys written by the agent. The web app never reads their contents in Phase 3. */
  transcriptKey: z.string().max(256).optional(),
  audioKey: z.string().max(256).optional(),
});
export type Drill = z.infer<typeof Drill>;

/**
 * The scoring Lambdas run on stdlib and boto3 with no pydantic, so they build the item by hand
 * and write `{"S": ""}` for a field they had no value for rather than leaving the attribute out
 * (see `services/scoring/scoring_service/finish.py`). An empty string is therefore the pipeline's
 * way of saying "absent", and it has to parse as absent here — otherwise one blank version string
 * would throw on read and take the learner's whole debrief down with it.
 */
function blankIsAbsent<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => (value === '' ? undefined : value), schema.optional());
}

export const ScoreBand = z.enum(['safe', 'wobbly', 'at_risk']);
export type ScoreBand = z.infer<typeof ScoreBand>;

export const ScoreStatus = z.enum(['scored', 'score_failed']);
export type ScoreStatus = z.infer<typeof ScoreStatus>;

/**
 * One thing the judge model was asked to classify, and the line it read it from. The evidence is
 * a quote from the *guardrail-redacted* transcript, and it belongs to the learner alone.
 */
export const JudgeMark = z.object({
  fired: z.boolean(),
  evidence: z.string().max(2000).optional(),
});
export type JudgeMark = z.infer<typeof JudgeMark>;

/**
 * The scoring pipeline's verdict on one drill: `pk = DRILL#<drillId>`, `sk = SCORE`.
 *
 * The web app **only ever reads** this row. Every field on it is written by the Step Functions
 * tasks in `services/scoring`, which is why nothing here is validated as strictly as the rows the
 * app writes itself: a field the pipeline forgot should cost the learner a missing line on their
 * debrief, not a 500 that hides the whole thing. Only the four fields that decide what the screen
 * shows at all are required.
 *
 * `turningPoint`, `debriefText` and every `evidence` string are transcript quotes. They are shown
 * to the learner and to nobody else, ever (PRD F7 AC2). `toGuardianBand` in `lib/debrief.ts` is
 * the only thing that turns this row into something a guardian may see.
 *
 * The pipeline also writes `redactedKey`, the S3 key of the redacted transcript. It is
 * deliberately not declared here, so zod strips it on read and the key for the transcript object
 * never reaches a route handler, a page or a browser — the same reasoning that keeps
 * `transcriptKey` out of `DrillView`.
 *
 * No `ttl`: PRD 8.6 keeps scores.
 */
export const Score = z.object({
  drillId: Id,
  memberId: Id,
  householdId: Id,
  status: ScoreStatus,
  createdAt: IsoTime,

  scheduledAt: blankIsAbsent(IsoTime),
  language: blankIsAbsent(Language),

  /** Both absent when `score_failed`. Never guess either of them (PRD F5 AC5). */
  score: z.number().int().min(0).max(100).optional(),
  band: blankIsAbsent(ScoreBand),

  flags: z.record(z.string(), JudgeMark).optional(),
  credits: z.record(z.string(), JudgeMark).optional(),

  turningPoint: blankIsAbsent(z.string().max(2000)),
  debriefText: blankIsAbsent(z.string().max(4000)),
  /** `debrief/<drillId>.mp3`. Absent when Polly failed; the score still stands. */
  debriefAudioKey: blankIsAbsent(z.string().max(256)),
  debriefVoiceId: blankIsAbsent(z.string().max(40)),

  rubricVersion: blankIsAbsent(z.string().max(40)),
  judgePromptVersion: blankIsAbsent(z.string().max(40)),
  debriefPromptVersion: blankIsAbsent(z.string().max(40)),
  judgeModelId: blankIsAbsent(z.string().max(120)),
  debriefModelId: blankIsAbsent(z.string().max(120)),
  guardrailId: blankIsAbsent(z.string().max(64)),
  guardrailVersion: blankIsAbsent(z.string().max(16)),
  failureReason: blankIsAbsent(z.string().max(400)),
});
export type Score = z.infer<typeof Score>;

/** One drill per learner per seven days (PRD F3 AC3). */
export const DRILL_COOLDOWN_DAYS = 7;
/** PRD section 7: a six minute hard cap, enforced by a timer in the agent, never by a prompt. */
export const DRILL_MAX_SECONDS = 360;
/** How long a ringing drill waits for an answer before it counts as missed (Phase 4 task 6). */
export const DRILL_DUE_MINUTES = 30;
/**
 * "Ring now" is a demo control, and a nervous demo operator must not be able to spam a parent.
 * Cancelled drills do not count against the weekly cap, so without this a decline could be
 * followed immediately by another ring.
 */
export const RING_NOW_COOLDOWN_MINUTES = 10;
/** Lifecycle event rows are an audit trail, not debug logging, but they do not live forever. */
export const EVENT_TTL_DAYS = 30;
