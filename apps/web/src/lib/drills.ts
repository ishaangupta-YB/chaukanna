import type { Actor } from './access';
import {
  DRILL_COOLDOWN_DAYS,
  DRILL_DUE_MINUTES,
  DRILL_MAX_SECONDS,
  Drill,
  RING_NOW_COOLDOWN_MINUTES,
  TIME_ZONE,
  beginDrillSession,
  cancelDrill,
  getLatestConsent,
  latestDrill,
  listDrills,
  markDrillMissed,
  putDrill,
  putDrillEvent,
  toMinutes,
  type DrillEventActor,
  type DrillWindow,
  type Member,
} from './db';
import { conflict, forbidden, tooManyRequests } from './errors';
import { log } from './log';
import { windowOrDefault } from './members';
import { randomInstantInWindow } from './schedule';
import { createDrillSchedule, deleteDrillSchedule } from './scheduler';
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

/**
 * Gate one: may a drill be created for this member, right now?
 *
 * `requireInsideWindow` is false for the scheduled path and true for "ring now". Scheduling at
 * 10:00 a drill that will ring at 14:20 is the whole point of Phase 4, so the window check there
 * belongs to the instant that was chosen, not to the moment somebody pressed the button. The ring
 * Lambda then checks it a third time, because hours pass and a learner can narrow their window in
 * between.
 */
export async function guardNewDrill(member: Member, at: Date, requireInsideWindow = true): Promise<void> {
  await assertConsented(member);
  const { window } = await windowOrDefault(member.memberId);
  if (requireInsideWindow && !isInsideWindow(window, at)) throw new DrillNotAllowed('outside_window');
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
  // A ring that lapsed while nobody was looking becomes `missed` here rather than starting a
  // call half an hour late. The conditional write in `beginDrillSession` would refuse it anyway;
  // this is what turns that into an answer the screen can explain.
  const current = await settleDrill(drill);
  if (current.state !== 'due' && current.state !== 'session_pending') throw new DrillNotAllowed('not_ready');
  const { window } = await windowOrDefault(member.memberId);
  if (!isInsideWindow(window, at)) throw new DrillNotAllowed('outside_window');
  const others = (await listDrills(member.memberId, 5)).filter((other) => other.drillId !== drill.drillId);
  if (drillWithinCooldown(others, at)) throw new DrillNotAllowed('weekly_cap');
}

/**
 * The audit trail and the log line, together, so that no transition can be written in one place
 * and forgotten in the other. The event row is a product feature: a family is entitled to see why
 * a phone rang, and a CloudWatch line is not something they can see.
 */
async function recordTransition(
  drill: Drill,
  name: string,
  actor: DrillEventActor,
  detail?: Record<string, string | number | boolean>,
): Promise<void> {
  const at = new Date().toISOString();
  await putDrillEvent({
    drillId: drill.drillId,
    memberId: drill.memberId,
    householdId: drill.householdId,
    name,
    at,
    actor,
    detail,
  });
  log.info(name, {
    householdId: drill.householdId,
    memberId: drill.memberId,
    drillId: drill.drillId,
    actor,
    ...detail,
  });
}

/**
 * "Ring now", the guardian's control for a demo (PRD F3 AC4). It creates a drill that is already
 * due; nothing about the checks is relaxed because a human pressed the button.
 *
 * The rate limit is not about load. A declined drill is `cancelled` and so does not count against
 * the weekly cap, which means without this a nervous demo operator could ring a parent over and
 * over. Ten minutes is long enough that the second press is a decision rather than a reflex.
 */
export async function ringNow(member: Member, by: Actor, at: Date = new Date()): Promise<Drill> {
  if (by !== 'guardian') throw forbidden('ring_now_is_guardian_only');
  const recent = await listDrills(member.memberId, 5);
  const cooldown = at.getTime() - RING_NOW_COOLDOWN_MINUTES * 60 * 1000;
  if (recent.some((other) => Date.parse(other.createdAt) > cooldown)) throw tooManyRequests('ring_too_soon');
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
    dueAt: at.toISOString(),
    dueExpiresAt: Math.floor(at.getTime() / 1000) + DRILL_DUE_MINUTES * 60,
  };
  await putDrill(drill);
  await recordTransition(drill, 'drill.due', 'guardian', { trigger: 'ring_now' });
  return drill;
}

/**
 * The scheduled path (PRD F3 AC2): a drill written now, to ring by itself at a uniformly random
 * instant inside the next occurrence of the learner's window.
 *
 * The chosen instant is stored, in the row and in its event, so that anybody — a judge, a
 * guardian, the learner — can check for themselves that it fell inside the hours they agreed to.
 * A random time nobody can audit is just an unexplained phone call.
 *
 * The window is deliberately not required to be open right now. Scheduling at 10:00 a drill that
 * rings at 14:20 is the whole point; the window is enforced against the instant that was chosen,
 * and again by the ring Lambda at the moment it fires, because a learner can narrow their window
 * in between.
 */
export async function scheduleDrill(member: Member, by: Actor, at: Date = new Date()): Promise<Drill> {
  await guardNewDrill(member, at, false);
  const { window } = await windowOrDefault(member.memberId);
  const ringAt = randomInstantInWindow(window, at);

  const drill: Drill = {
    drillId: randomId(10),
    memberId: member.memberId,
    householdId: member.householdId,
    scenarioId: SCENARIO_ID,
    language: member.language,
    state: 'scheduled',
    scheduledAt: ringAt.toISOString(),
    createdAt: at.toISOString(),
    updatedAt: at.toISOString(),
    createdBy: by,
    maxSeconds: DRILL_MAX_SECONDS,
  };
  await putDrill(drill);

  try {
    await createDrillSchedule({
      drillId: drill.drillId,
      memberId: drill.memberId,
      at: ringAt,
      timeZone: window.tz,
    });
  } catch (error) {
    // A drill row with no schedule behind it would never ring and would still burn the learner's
    // week. Undo it: cancelled drills do not count against the cap.
    await cancelDrill(drill, new Date().toISOString(), 'schedule_failed');
    await recordTransition(drill, 'drill.cancelled', 'system', { reason: 'schedule_failed' });
    throw error;
  }

  await recordTransition(drill, 'drill.scheduled', by, { ringAt: drill.scheduledAt, tz: window.tz });
  return drill;
}

/**
 * Stops every drill that has not become a call yet, and deletes the schedule behind each one
 * (PRD F2 AC4, within a minute). Called by the kill switch and by withdrawing consent.
 *
 * Deleting the schedule is the courtesy, not the guarantee. The guarantee is that the row is
 * `cancelled` and the ring Lambda re-reads the row before it rings anything, so a schedule that
 * fires a second after this ran is harmless. That ordering — row first, schedule second — is
 * deliberate: if the process dies between the two, the drill is still cancelled.
 */
export async function cancelPendingDrills(member: Member, source: string): Promise<number> {
  const drills = await listDrills(member.memberId, 20);
  const pending = drills.filter(
    (drill) => drill.state === 'scheduled' || drill.state === 'due' || drill.state === 'session_pending',
  );
  let cancelled = 0;
  for (const drill of pending) {
    if (!(await cancelDrill(drill, new Date().toISOString(), source))) continue;
    cancelled += 1;
    await recordTransition(drill, 'drill.cancelled', 'system', { reason: source });
    await deleteDrillSchedule(drill.drillId);
  }
  return cancelled;
}

/**
 * Turns a drill that rang and was never answered into a `missed` one, lazily, on read (phase file
 * task 6). A second scheduler to tidy up a row nobody is looking at would be machinery for its own
 * sake; at one drill per learner per week, the next read is soon enough.
 */
export async function settleDrill(drill: Drill): Promise<Drill> {
  const expired =
    (drill.state === 'due' || drill.state === 'session_pending') &&
    drill.dueExpiresAt !== undefined &&
    drill.dueExpiresAt * 1000 < Date.now();
  if (!expired) return drill;
  if (!(await markDrillMissed(drill, new Date().toISOString()))) return drill;
  const missed: Drill = { ...drill, state: 'missed' };
  await recordTransition(missed, 'drill.missed', 'system');
  return missed;
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
  const latest = await latestDrill(memberId);
  if (!latest) return null;
  const drill = await settleDrill(latest);
  return drill.state === 'due' || drill.state === 'session_pending' ? drill : null;
}
