import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_WINDOW, TIME_ZONE, type DrillWindow } from './db';
import { isInsideWindow } from './drills';
import {
  nextWindowOccurrence,
  randomInstantInWindow,
  toSchedulerExpression,
  toSchedulerLocalTime,
} from './schedule';

/**
 * Scheduling decides when a stranger's voice rings an elderly person's phone, so every case here
 * is written as a real UTC instant with the Indian wall clock spelled out in a comment. A drill
 * that lands one day or five and a half hours off is not a test failure, it is a 3am phone call.
 */

/** The default window: Mon-Fri, 11:00-18:00 IST. In UTC that is 05:30-12:30. */
const WEEKDAYS = DEFAULT_WINDOW;
const MONDAY_ONLY: DrillWindow = { days: [1], start: '11:00', end: '18:00', tz: TIME_ZONE };

describe('nextWindowOccurrence', () => {
  it('waits for the start when the day has not reached the window yet', () => {
    // Monday 21 September 2026, 08:30 IST.
    const occurrence = nextWindowOccurrence(WEEKDAYS, new Date('2026-09-21T03:00:00Z'));
    expect(occurrence.start.toISOString()).toBe('2026-09-21T05:30:00.000Z'); // 11:00 IST
    expect(occurrence.end.toISOString()).toBe('2026-09-21T12:30:00.000Z'); // 18:00 IST
  });

  it('starts at `from` when `from` is already inside the window', () => {
    // Monday 11:30 IST. Scheduling for 11:00 would be scheduling for the past.
    const from = new Date('2026-09-21T06:00:00Z');
    const occurrence = nextWindowOccurrence(WEEKDAYS, from);
    expect(occurrence.start.toISOString()).toBe(from.toISOString());
    expect(occurrence.end.toISOString()).toBe('2026-09-21T12:30:00.000Z');
  });

  it('rolls to the next listed day once today\'s window is over', () => {
    // Monday 19:30 IST, an hour and a half after the window closed.
    const occurrence = nextWindowOccurrence(WEEKDAYS, new Date('2026-09-21T14:00:00Z'));
    expect(occurrence.start.toISOString()).toBe('2026-09-22T05:30:00.000Z'); // Tuesday 11:00 IST
  });

  it('treats the closing minute as gone, matching the exclusive end of isInsideWindow', () => {
    // Exactly 18:00 IST on Monday.
    const occurrence = nextWindowOccurrence(WEEKDAYS, new Date('2026-09-21T12:30:00Z'));
    expect(occurrence.start.toISOString()).toBe('2026-09-22T05:30:00.000Z');
  });

  it('skips the weekend to reach the next weekday', () => {
    // Saturday 19 September 2026, 11:30 IST: not a listed day at all.
    const occurrence = nextWindowOccurrence(WEEKDAYS, new Date('2026-09-19T06:00:00Z'));
    expect(occurrence.start.toISOString()).toBe('2026-09-21T05:30:00.000Z'); // Monday
  });

  it('waits a full week when the learner listed one weekday', () => {
    // Monday 19:30 IST, window already over, and the only listed day is Monday.
    const occurrence = nextWindowOccurrence(MONDAY_ONLY, new Date('2026-09-21T14:00:00Z'));
    expect(occurrence.start.toISOString()).toBe('2026-09-28T05:30:00.000Z');
  });

  it('crosses a month boundary', () => {
    // Wednesday 30 September 2026, 19:30 IST, with Wednesday the only listed day.
    const wednesday: DrillWindow = { ...MONDAY_ONLY, days: [3] };
    const occurrence = nextWindowOccurrence(wednesday, new Date('2026-09-30T14:00:00Z'));
    expect(occurrence.start.toISOString()).toBe('2026-10-07T05:30:00.000Z');
  });

  it('crosses a year boundary', () => {
    // Thursday 31 December 2026, 19:30 IST, with Thursday the only listed day.
    const thursday: DrillWindow = { ...MONDAY_ONLY, days: [4] };
    const occurrence = nextWindowOccurrence(thursday, new Date('2026-12-31T14:00:00Z'));
    expect(occurrence.start.toISOString()).toBe('2027-01-07T05:30:00.000Z');
  });

  it('rolls the Indian day over at Indian midnight, not UTC midnight', () => {
    // 20:00 UTC on Sunday is already 01:30 on Monday in Kolkata, so the window is later today.
    const occurrence = nextWindowOccurrence(WEEKDAYS, new Date('2026-09-20T20:00:00Z'));
    expect(occurrence.start.toISOString()).toBe('2026-09-21T05:30:00.000Z');
  });

  it('never returns an instant in the past', () => {
    const from = new Date('2026-09-21T12:29:59.500Z'); // half a second before 18:00 IST
    expect(nextWindowOccurrence(WEEKDAYS, from).start.getTime()).toBeGreaterThanOrEqual(from.getTime());
  });
});

describe('randomInstantInWindow', () => {
  it('always lands inside the window, over many real draws', () => {
    // Real crypto randomness, not the stub: the stub cannot catch an off-by-one at either edge.
    const from = new Date('2026-09-21T03:00:00Z');
    for (let i = 0; i < 200; i += 1) {
      const at = randomInstantInWindow(WEEKDAYS, from);
      expect(isInsideWindow(WEEKDAYS, at)).toBe(true);
      expect(at.getTime()).toBeGreaterThanOrEqual(from.getTime());
    }
  });

  it('stays inside a window it has to roll forward to', () => {
    const from = new Date('2026-09-19T06:00:00Z'); // Saturday, rolls to Monday
    for (let i = 0; i < 200; i += 1) {
      expect(isInsideWindow(WEEKDAYS, randomInstantInWindow(WEEKDAYS, from))).toBe(true);
    }
  });

  it('is exactly predictable when the draw is injected', () => {
    const from = new Date('2026-09-21T03:00:00Z');
    // 11:00 IST plus 3600 seconds.
    const at = randomInstantInWindow(WEEKDAYS, from, () => 3600);
    expect(at.toISOString()).toBe('2026-09-21T06:30:00.000Z');
  });

  it('offers the whole window to the draw, and nothing past its end', () => {
    const from = new Date('2026-09-21T03:00:00Z');
    const seen: Array<[number, number]> = [];
    randomInstantInWindow(WEEKDAYS, from, (min, max) => {
      seen.push([min, max]);
      return min;
    });
    // Seven hours of seconds, exclusive max, so the last choosable second is 17:59:59 IST.
    expect(seen).toEqual([[0, 7 * 60 * 60]]);
  });

  it('returns the start rather than throwing when under a second is left', () => {
    // 17:59:59.500 IST: the remaining span floors to zero seconds, and randomInt(0, 0) would throw.
    const from = new Date('2026-09-21T12:29:59.500Z');
    const at = randomInstantInWindow(WEEKDAYS, from, () => {
      throw new Error('randomInt must not be called for a degenerate span');
    });
    expect(at.toISOString()).toBe(from.toISOString());
  });
});

describe('toSchedulerExpression', () => {
  it('renders Indian wall clock for a known UTC instant', () => {
    expect(toSchedulerExpression(new Date('2026-09-20T05:30:00Z'), TIME_ZONE)).toBe('at(2026-09-20T11:00:00)');
  });

  it('carries no Z and no offset, because the schedule names its timezone separately', () => {
    const expression = toSchedulerExpression(new Date('2026-09-21T06:00:00Z'), TIME_ZONE);
    expect(expression).toBe('at(2026-09-21T11:30:00)');
    expect(expression).not.toContain('Z');
    expect(expression).not.toMatch(/[+-]\d{2}:\d{2}\)$/);
  });

  it('keeps seconds, which is the resolution the random draw uses', () => {
    expect(toSchedulerExpression(new Date('2026-09-21T06:00:07Z'), TIME_ZONE)).toBe('at(2026-09-21T11:30:07)');
  });

  it('renders Indian midnight as 00, never 24', () => {
    // 18:30 UTC is exactly 00:00 IST the next day, the one case `en-GB` likes to call hour 24.
    expect(toSchedulerExpression(new Date('2026-09-20T18:30:00Z'), TIME_ZONE)).toBe('at(2026-09-21T00:00:00)');
  });

  it('honours a zone that is behind UTC, so the maths is not IST-shaped by accident', () => {
    expect(toSchedulerExpression(new Date('2026-09-20T05:30:00Z'), 'America/New_York')).toBe(
      'at(2026-09-20T01:30:00)',
    );
  });
});

describe('toSchedulerLocalTime', () => {
  it('is the same value without the wrapper, for a caller that writes its own at(...)', () => {
    const at = new Date('2026-09-20T05:30:00Z');
    expect(toSchedulerLocalTime(at, TIME_ZONE)).toBe('2026-09-20T11:00:00');
    expect(toSchedulerExpression(at, TIME_ZONE)).toBe(`at(${toSchedulerLocalTime(at, TIME_ZONE)})`);
  });

  it('carries no Z and no offset either', () => {
    const local = toSchedulerLocalTime(new Date('2026-09-21T06:00:00Z'), TIME_ZONE);
    expect(local).not.toContain('Z');
    expect(local).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  });
});

describe('the host timezone', () => {
  const original = process.env.TZ;
  afterEach(() => {
    process.env.TZ = original;
  });

  it('changes nothing, because every calculation names its zone', () => {
    // All inputs and assertions are explicit UTC instants, so this is belt and braces over the
    // `Intl` calls: a host in Honolulu must schedule the identical drill.
    const from = new Date('2026-09-21T14:00:00Z');
    process.env.TZ = 'Pacific/Honolulu';
    const occurrence = nextWindowOccurrence(WEEKDAYS, from);
    expect(occurrence.start.toISOString()).toBe('2026-09-22T05:30:00.000Z');
    expect(toSchedulerExpression(occurrence.start, TIME_ZONE)).toBe('at(2026-09-22T11:00:00)');
  });
});
