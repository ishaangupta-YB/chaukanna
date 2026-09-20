import { randomInt as cryptoRandomInt } from 'node:crypto';
import { toMinutes, type DrillWindow } from './db';

/**
 * The scheduling half of the window rules. `drills.ts` answers "may a call happen right now?";
 * this file answers "when should the next one be?", which is the same arithmetic run forwards.
 *
 * Two rules hold everywhere below:
 *
 *  - Every calendar decision goes through `Intl.DateTimeFormat` with an explicit `timeZone`. A
 *    fixed +05:30 is right for India today and wrong the day it is not, and a drill an hour
 *    outside the agreed hours is exactly the failure this product cannot have. India has no DST,
 *    but the code is written as if it did: the cost is one extra pass, the payoff is a class of
 *    bug that cannot happen.
 *  - A `Date` is always a UTC instant. Wall-clock strings exist only at the two boundaries, the
 *    stored `HH:MM` window and the EventBridge expression.
 *
 * Deliberately self-contained: `drills.ts` will import the schedule helpers, so importing its
 * `localTime` / `isInsideWindow` back would close an import cycle. The private helpers here do
 * the calendar maths that `localTime` does not expose (it returns weekday and minute-of-day, not
 * a Y-M-D the inverse conversion needs).
 */

interface CivilTime {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const CIVIL_FORMAT_OPTIONS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
};

/** The wall clock an observer in `timeZone` reads off at instant `at`. */
function civilTimeIn(at: Date, timeZone: string): CivilTime {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, ...CIVIL_FORMAT_OPTIONS }).formatToParts(at);
  const value = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value);
  // `en-GB` renders midnight as "24" in some engines; normalise it to the 0 the next day starts at.
  const hour = value('hour') % 24;
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour,
    minute: value('minute'),
    second: value('second'),
  };
}

/** How far `timeZone` runs ahead of UTC at instant `at`, in milliseconds. DST-aware by construction. */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const civil = civilTimeIn(at, timeZone);
  const asIfUtc = Date.UTC(civil.year, civil.month - 1, civil.day, civil.hour, civil.minute, civil.second);
  // `at` may carry milliseconds the formatter dropped; remove them so the difference is a pure offset.
  return asIfUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * The inverse of `civilTimeIn`: the UTC instant at which `timeZone` reads this wall clock.
 *
 * Two passes, because the offset that converts the answer is the offset *at* the answer, not at
 * the guess. One refinement is enough for every real zone; a DST jump moves the guess by at most
 * one offset step.
 */
function instantFromCivil(civil: CivilTime, timeZone: string): Date {
  const asIfUtc = Date.UTC(civil.year, civil.month - 1, civil.day, civil.hour, civil.minute, civil.second);
  const firstGuess = asIfUtc - zoneOffsetMs(new Date(asIfUtc), timeZone);
  return new Date(asIfUtc - zoneOffsetMs(new Date(firstGuess), timeZone));
}

/** ISO weekday (1 = Monday ... 7 = Sunday) of a civil date, with no timezone involved. */
function isoWeekdayOf(year: number, month: number, day: number): number {
  return ((new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7) + 1;
}

/** `dayOffset` days after a civil date, letting `Date.UTC` normalise month and year rollover. */
function addDays(civil: CivilTime, dayOffset: number): { year: number; month: number; day: number } {
  const shifted = new Date(Date.UTC(civil.year, civil.month - 1, civil.day + dayOffset));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

function atMinutesOfDay(
  date: { year: number; month: number; day: number },
  minutesOfDay: number,
  timeZone: string,
): Date {
  return instantFromCivil(
    {
      ...date,
      hour: Math.floor(minutesOfDay / 60),
      minute: minutesOfDay % 60,
      second: 0,
    },
    timeZone,
  );
}

/** A window can never be further away than a full week, so eight days is a generous ceiling. */
const SEARCH_DAYS = 8;

/**
 * The next occurrence of the learner's weekly window that still has time left in it.
 *
 * If `from` falls inside today's window the occurrence is today's and it starts at `from`: a drill
 * must never be scheduled for a moment that has already gone. Otherwise it is the next listed
 * weekday at `window.start`.
 */
export function nextWindowOccurrence(window: DrillWindow, from: Date): { start: Date; end: Date } {
  const startMinutes = toMinutes(window.start);
  const endMinutes = toMinutes(window.end);
  const today = civilTimeIn(from, window.tz);

  for (let dayOffset = 0; dayOffset < SEARCH_DAYS; dayOffset += 1) {
    const date = addDays(today, dayOffset);
    if (!window.days.includes(isoWeekdayOf(date.year, date.month, date.day))) continue;

    const end = atMinutesOfDay(date, endMinutes, window.tz);
    // The end is exclusive, matching `isInsideWindow`: a window ending exactly now is over.
    if (end.getTime() <= from.getTime()) continue;

    const start = atMinutesOfDay(date, startMinutes, window.tz);
    return { start: start.getTime() < from.getTime() ? new Date(from.getTime()) : start, end };
  }

  // Unreachable while `days` is non-empty, which the schema enforces. Throwing beats looping.
  throw new Error(`no window occurrence within ${SEARCH_DAYS} days for days [${window.days.join(',')}]`);
}

/**
 * A uniformly random instant inside `nextWindowOccurrence`, at whole-second resolution. Seconds
 * are finer than anything downstream cares about: EventBridge's `at()` expression is
 * second-granular and the window itself is stated in minutes.
 *
 * `randomInt` is injectable only so a test can pin the draw. The default is `node:crypto`, per the
 * Phase 4 code practices; `Math.random` is not acceptable for a value a judge will audit.
 */
export function randomInstantInWindow(
  window: DrillWindow,
  from: Date,
  randomInt: (min: number, max: number) => number = cryptoRandomInt,
): Date {
  const { start, end } = nextWindowOccurrence(window, from);
  const spanSeconds = Math.floor((end.getTime() - start.getTime()) / 1000);
  // Under a second left: `randomInt(0, 0)` throws, and there is nothing to choose between anyway.
  if (spanSeconds < 1) return new Date(start.getTime());
  return new Date(start.getTime() + randomInt(0, spanSeconds) * 1000);
}

/**
 * `YYYY-MM-DDTHH:MM:SS` on the wall clock in `timeZone` — the *inside* of an EventBridge Scheduler
 * `at(...)` expression, with no wrapper.
 *
 * No trailing `Z` and no offset, deliberately: the schedule carries its zone separately in
 * `ScheduleExpressionTimezone`, and a stray `Z` on a local time is the classic way to fire a drill
 * five and a half hours early. The name says `LocalTime`, not `Expression`, so the caller knows it
 * still has to write `at(...)` around it.
 */
export function toSchedulerLocalTime(at: Date, timeZone: string): string {
  const { year, month, day, hour, minute, second } = civilTimeIn(at, timeZone);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}`;
}

/**
 * The same value with its wrapper, ready to hand straight to `ScheduleExpression`. The name says
 * `Expression` because it returns the whole thing — never `at(${...})` this one again.
 */
export function toSchedulerExpression(at: Date, timeZone: string): string {
  return `at(${toSchedulerLocalTime(at, timeZone)})`;
}
