import { describe, expect, it } from 'vitest';
import { DEFAULT_WINDOW, TIME_ZONE, type Drill, type DrillWindow } from './db';
import { drillWithinCooldown, isInsideWindow, localTime } from './drills';

/**
 * The two rules that decide when a stranger's voice is allowed to ring an elderly person's phone.
 * Both are cheap to get subtly wrong and expensive to get wrong in public, so they are tested
 * against real instants rather than against a mocked clock.
 */

/** 11:30 IST on Monday 21 September 2026, which is 06:00 UTC. */
const MONDAY_1130_IST = new Date('2026-09-21T06:00:00Z');

function drill(overrides: Partial<Drill> = {}): Drill {
  return {
    drillId: 'aaaaaaaabbbbbbbbcccc',
    memberId: 'abcdef0123456789abcd',
    householdId: '0123456789abcdef0123',
    scenarioId: 'digital_arrest_v1',
    language: 'hi-IN',
    state: 'ended',
    scheduledAt: '2026-09-21T06:00:00.000Z',
    createdAt: '2026-09-21T06:00:00.000Z',
    updatedAt: '2026-09-21T06:00:00.000Z',
    createdBy: 'guardian',
    maxSeconds: 360,
    ...overrides,
  };
}

describe('localTime', () => {
  it('reads the wall clock in India, not the server', () => {
    // 06:00 UTC is 11:30 in Kolkata, and it is a Monday in both.
    expect(localTime(MONDAY_1130_IST, TIME_ZONE)).toEqual({ isoWeekday: 1, minutes: 11 * 60 + 30 });
  });

  it('puts Sunday at 7, the way the stored window numbers days', () => {
    expect(localTime(new Date('2026-09-20T06:00:00Z'), TIME_ZONE).isoWeekday).toBe(7);
  });

  it('rolls the day over at Indian midnight, not UTC midnight', () => {
    // 20:00 UTC on Sunday is already 01:30 on Monday in Kolkata.
    expect(localTime(new Date('2026-09-20T20:00:00Z'), TIME_ZONE)).toEqual({ isoWeekday: 1, minutes: 90 });
  });
});

describe('isInsideWindow', () => {
  it('accepts the middle of a chosen weekday', () => {
    expect(isInsideWindow(DEFAULT_WINDOW, MONDAY_1130_IST)).toBe(true);
  });

  it('refuses a day the learner did not choose', () => {
    // Sunday 11:30 IST, against the weekday default.
    expect(isInsideWindow(DEFAULT_WINDOW, new Date('2026-09-20T06:00:00Z'))).toBe(false);
  });

  it('refuses before the start and at the end', () => {
    // 10:59 IST, one minute early.
    expect(isInsideWindow(DEFAULT_WINDOW, new Date('2026-09-21T05:29:00Z'))).toBe(false);
    // 18:00 IST exactly: the end is exclusive, so a call cannot start on the boundary.
    expect(isInsideWindow(DEFAULT_WINDOW, new Date('2026-09-21T12:30:00Z'))).toBe(false);
    // 17:59 IST is still inside.
    expect(isInsideWindow(DEFAULT_WINDOW, new Date('2026-09-21T12:29:00Z'))).toBe(true);
  });

  it('accepts the first minute of the window', () => {
    expect(isInsideWindow(DEFAULT_WINDOW, new Date('2026-09-21T05:30:00Z'))).toBe(true);
  });

  it('refuses the small hours, which is the whole point of a window', () => {
    // 02:00 IST on a Monday: a weekday, but nobody agreed to this.
    expect(isInsideWindow(DEFAULT_WINDOW, new Date('2026-09-20T20:30:00Z'))).toBe(false);
  });

  it('handles a weekend window', () => {
    const weekend: DrillWindow = { days: [6, 7], start: '09:00', end: '12:00', tz: TIME_ZONE };
    expect(isInsideWindow(weekend, new Date('2026-09-20T04:00:00Z'))).toBe(true); // Sunday 09:30
    expect(isInsideWindow(weekend, MONDAY_1130_IST)).toBe(false);
  });
});

describe('drillWithinCooldown', () => {
  it('blocks a second call inside seven days', () => {
    const recent = drill({ createdAt: '2026-09-18T06:00:00.000Z' });
    expect(drillWithinCooldown([recent], MONDAY_1130_IST)).toBe(recent);
  });

  it('allows one after seven days', () => {
    expect(drillWithinCooldown([drill({ createdAt: '2026-09-13T06:00:00.000Z' })], MONDAY_1130_IST)).toBeNull();
  });

  it('counts a drill that ended badly, because the phone still rang', () => {
    const failed = drill({ createdAt: '2026-09-19T06:00:00.000Z', state: 'ended', endReason: 'error' });
    expect(drillWithinCooldown([failed], MONDAY_1130_IST)).toBe(failed);
  });

  it('counts one still in progress', () => {
    const live = drill({ createdAt: '2026-09-21T05:50:00.000Z', state: 'in_progress' });
    expect(drillWithinCooldown([live], MONDAY_1130_IST)).toBe(live);
  });

  it('does not count a cancelled drill, because nobody was called', () => {
    const cancelled = drill({ createdAt: '2026-09-20T06:00:00.000Z', state: 'cancelled' });
    expect(drillWithinCooldown([cancelled], MONDAY_1130_IST)).toBeNull();
  });

  it('ignores an empty history', () => {
    expect(drillWithinCooldown([], MONDAY_1130_IST)).toBeNull();
  });
});
