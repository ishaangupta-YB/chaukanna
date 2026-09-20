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
 *   scheduled ──(its time arrives, Phase 4)──▶ due ──(a session token is minted)──▶ session_pending
 *   session_pending ──(the agent claims it, once)──▶ in_progress ──(the call ends)──▶ ended
 *
 * `cancelled` is the kill switch reaching a drill that never rang. The only transition the agent
 * performs is `session_pending` to `in_progress`, and it is a conditional write, which is what
 * makes a session token single use.
 */
export const DrillState = z.enum(['scheduled', 'due', 'session_pending', 'in_progress', 'ended', 'cancelled']);
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

/** One drill per learner per seven days (PRD F3 AC3). */
export const DRILL_COOLDOWN_DAYS = 7;
/** PRD section 7: a six minute hard cap, enforced by a timer in the agent, never by a prompt. */
export const DRILL_MAX_SECONDS = 360;
