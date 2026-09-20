import type { Actor } from './access';
import {
  DRILL_COOLDOWN_DAYS,
  DRILL_MAX_SECONDS,
  Drill,
  TIME_ZONE,
  beginDrillSession,
  getLatestConsent,
  latestDrill,
  listDrills,
  putDrill,
  toMinutes,
  type DrillWindow,
  type Member,
} from './db';
import { conflict, forbidden } from './errors';
import { log } from './log';
import { windowOrDefault } from './members';
import { randomId } from './signing';

/**
 * Every rule that decides whether a drill may happen, in one file, run on the server and only on
 * the server. PRD section 7 asks for each of them twice: once when the drill is created and again
 * when the call is about to start, because minutes pass in between and consent can be withdrawn
 * in one tap.
 *
 * `guardNewDrill` and `guardDrillStart` are the two gates. Neither of them trusts anything the
 * browser sent.
 */

export const SCENARIO_ID = 'digital_arrest_v1';

export type DrillRefusal =
  | 'not_consented' // no consent row, or it was withdrawn
  | 'paused' // the kill switch is on
  | 'outside_window' // not inside the hours the learner chose
  | 'weekly_cap' // one drill per seven days
  | 'not_ready'; // the drill exists but is not due, or is already over

export class DrillNotAllowed extends Error {
  constructor(readonly refusal: DrillRefusal) {
    super(refusal);
    this.name = 'DrillNotAllowed';
  }
}

/**
 * The learner's local weekday and minute-of-day, in the window's own zone.
 *
 * `Intl` rather than a fixed +5:30 offset: the offset is right for India today, and the day it is
 * not, a drill would ring an hour outside the hours somebody agreed to.
 */
export function localTime(at: Date, timeZone: string = TIME_ZONE): { isoWeekday: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(at);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  return {
    isoWeekday: weekdays.indexOf(value('weekday')) + 1,
    minutes: Number(value('hour')) * 60 + Number(value('minute')),
  };
}

/** Inclusive of the start minute, exclusive of the end minute. */
export function isInsideWindow(window: DrillWindow, at: Date): boolean {
  const { isoWeekday, minutes } = localTime(at, window.tz);
  if (isoWeekday < 1 || !window.days.includes(isoWeekday)) return false;
  return minutes >= toMinutes(window.start) && minutes < toMinutes(window.end);
}

/**
 * A drill inside the cooldown blocks another one. Cancelled drills do not count: nobody was
 * called. Everything else does, including one that ended in an error, because the learner's phone
 * still rang.
 */
export function drillWithinCooldown(drills: Drill[], at: Date): Drill | null {
  const cutoff = at.getTime() - DRILL_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
  return (
    drills.find((drill) => drill.state !== 'cancelled' && Date.parse(drill.createdAt) > cutoff) ?? null
  );
}

async function assertConsented(member: Member): Promise<void> {
  if (member.status !== 'active') {
    throw new DrillNotAllowed(member.status === 'paused' ? 'paused' : 'not_consented');
  }
  const consent = await getLatestConsent(member.memberId);
  if (!consent || consent.revokedAt) throw new DrillNotAllowed('not_consented');
}

/** Gate one: may a drill be created for this member, right now? */
export async function guardNewDrill(member: Member, at: Date): Promise<void> {
  await assertConsented(member);
  const { window } = await windowOrDefault(member.memberId);
  if (!isInsideWindow(window, at)) throw new DrillNotAllowed('outside_window');
  const recent = drillWithinCooldown(await listDrills(member.memberId, 5), at);
  if (recent) throw new DrillNotAllowed('weekly_cap');
}

/**
 * Gate two: may *this* drill start a call, right now? The four checks Phase 3 asks for, in the
 * order that fails cheapest first. The cooldown ignores this drill itself, which is already in
 * the member's history by the time anybody answers it.
 */
export async function guardDrillStart(member: Member, drill: Drill, at: Date): Promise<void> {
  await assertConsented(member);
  if (drill.state !== 'due' && drill.state !== 'session_pending') throw new DrillNotAllowed('not_ready');
  const { window } = await windowOrDefault(member.memberId);
  if (!isInsideWindow(window, at)) throw new DrillNotAllowed('outside_window');
  const others = (await listDrills(member.memberId, 5)).filter((other) => other.drillId !== drill.drillId);
  if (drillWithinCooldown(others, at)) throw new DrillNotAllowed('weekly_cap');
}

/**
 * "Ring now", the guardian's control for a demo (PRD F3 AC4). It creates a drill that is already
 * due; nothing about the checks is relaxed because a human pressed the button.
 *
 * Phase 4 adds the other path into this table, an EventBridge schedule that fires at a random
 * time inside the window and creates the same row.
 */
export async function ringNow(member: Member, by: Actor, at: Date = new Date()): Promise<Drill> {
  if (by !== 'guardian') throw forbidden('ring_now_is_guardian_only');
  await guardNewDrill(member, at);

  const drill: Drill = {
    drillId: randomId(10),
    memberId: member.memberId,
    householdId: member.householdId,
    scenarioId: SCENARIO_ID,
    language: member.language,
    state: 'due',
    scheduledAt: at.toISOString(),
    createdAt: at.toISOString(),
    updatedAt: at.toISOString(),
    createdBy: by,
    maxSeconds: DRILL_MAX_SECONDS,
  };
  await putDrill(drill);
  log.info('drill.created', {
    householdId: member.householdId,
    memberId: member.memberId,
    drillId: drill.drillId,
    by,
    trigger: 'ring_now',
  });
  return drill;
}

/** Marks the drill as waiting for one particular session token. */
export async function claimDrillForSession(drill: Drill, expiresAt: number): Promise<string> {
  const jti = randomId(10);
  const moved = await beginDrillSession(drill, jti, expiresAt, new Date().toISOString());
  if (!moved) throw conflict('drill_not_ready');
  return jti;
}

/**
 * What a drill looks like to whoever is allowed to see it: a result, never a transcript.
 *
 * The S3 keys are deliberately absent. A guardian may not read a transcript unless the learner
 * shares it (PRD F7 AC2), and the surest way to keep that true is for the key never to leave the
 * table. Phase 6 turns the same rule into a Cedar decision.
 */
export interface DrillView {
  drillId: string;
  state: Drill['state'];
  language: Drill['language'];
  scheduledAt: string;
  startedAt?: string;
  endedAt?: string;
  endReason?: string;
  finalStage?: string;
  durationSeconds?: number;
  redFlagIds: string[];
}

export function toDrillView(drill: Drill): DrillView {
  return {
    drillId: drill.drillId,
    state: drill.state,
    language: drill.language,
    scheduledAt: drill.scheduledAt,
    startedAt: drill.startedAt,
    endedAt: drill.endedAt,
    endReason: drill.endReason,
    finalStage: drill.finalStage,
    durationSeconds: drill.durationSeconds,
    redFlagIds: (drill.redFlags ?? []).map((flag) => flag.id),
  };
}

/** The learner's most recent drill, for the "you have a call waiting" state on /me. */
export async function pendingDrill(memberId: string): Promise<Drill | null> {
  const drill = await latestDrill(memberId);
  if (!drill) return null;
  return drill.state === 'due' || drill.state === 'session_pending' ? drill : null;
}
