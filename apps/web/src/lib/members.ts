import type { Actor } from './access';
import { DEFAULT_WINDOW, getWindow, pauseMember, putWindow, type DrillWindow, type Member } from './db';
import { log } from './log';

export async function setWindow(member: Member, window: DrillWindow, by: Actor): Promise<void> {
  await putWindow({ memberId: member.memberId, window, updatedAt: new Date().toISOString(), updatedBy: by });
  log.info('window.updated', { householdId: member.householdId, memberId: member.memberId, by });
}

/** The stored window, or the PRD default (weekdays 11:00 to 18:00 IST) when none is set. */
export async function windowOrDefault(memberId: string): Promise<{ window: DrillWindow; isDefault: boolean }> {
  const stored = await getWindow(memberId);
  return stored ? { window: stored.window, isDefault: false } : { window: DEFAULT_WINDOW, isDefault: true };
}

/**
 * Kill switch. Phase 1 sets the status only. Phase 4 adds cancelling pending schedules, and
 * every later check that starts a drill reads this status.
 */
export async function pauseAll(member: Member, by: Actor): Promise<void> {
  await pauseMember(member.householdId, member.memberId, new Date().toISOString());
  log.info('member.paused', { householdId: member.householdId, memberId: member.memberId, by });
}
