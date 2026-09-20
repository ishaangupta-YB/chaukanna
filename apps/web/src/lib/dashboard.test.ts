import { describe, expect, it } from 'vitest';
import { bandPoints, flagLabel, learnerProgress, nextScheduled, weakestTactic } from './dashboard';
import type { Drill, Score, ScoreBand } from './db';

/**
 * The dashboard's arithmetic, without a table. Zero drills, one drill, a learner getting better,
 * a learner getting worse, and the tie break that decides which tactic gets named.
 */

function drill(id: string, at: string, overrides: Partial<Drill> = {}): Drill {
  return {
    drillId: id.padEnd(20, '0'),
    memberId: 'abcdef0123456789abcd',
    householdId: '0123456789abcdef0123',
    scenarioId: 'digital_arrest_v1',
    language: 'hi-IN',
    state: 'scored',
    scheduledAt: at,
    createdAt: at,
    updatedAt: at,
    endedAt: at,
    createdBy: 'guardian',
    maxSeconds: 360,
    ...overrides,
  };
}

function score(id: string, band: ScoreBand | undefined, flags: Record<string, boolean> = {}): Score {
  return {
    drillId: id.padEnd(20, '0'),
    memberId: 'abcdef0123456789abcd',
    householdId: '0123456789abcdef0123',
    status: band ? 'scored' : 'score_failed',
    createdAt: '2026-09-21T06:04:30.000Z',
    band,
    flags: Object.fromEntries(Object.entries(flags).map(([k, fired]) => [k, { fired }])),
  };
}

/** `listDrills` returns newest first; the trend has to put them back in order itself. */
function history(entries: readonly { id: string; at: string; band?: ScoreBand; flags?: Record<string, boolean> }[]) {
  const drills = entries.map((e) => drill(e.id, e.at)).reverse();
  const scores = new Map(entries.map((e) => [e.id.padEnd(20, '0'), score(e.id, e.band, e.flags)]));
  return { drills, scores };
}

describe('learnerProgress', () => {
  it('has nothing to show before the first drill', () => {
    const progress = learnerProgress([], new Map());
    expect(progress).toEqual({ points: [], steps: [], overall: null, weakest: null });
  });

  it('shows one band and no trend after one drill', () => {
    const { drills, scores } = history([{ id: 'a', at: '2026-09-01T06:00:00.000Z', band: 'wobbly' }]);
    const progress = learnerProgress(drills, scores);
    expect(progress.points.map((p) => p.band)).toEqual(['wobbly']);
    expect(progress.steps).toEqual([]);
    expect(progress.overall).toBeNull();
  });

  it('reads improvement oldest first', () => {
    const { drills, scores } = history([
      { id: 'a', at: '2026-09-01T06:00:00.000Z', band: 'at_risk' },
      { id: 'b', at: '2026-09-08T06:00:00.000Z', band: 'wobbly' },
      { id: 'c', at: '2026-09-15T06:00:00.000Z', band: 'safe' },
    ]);
    const progress = learnerProgress(drills, scores);
    expect(progress.points.map((p) => p.band)).toEqual(['at_risk', 'wobbly', 'safe']);
    expect(progress.steps.map((s) => s.direction)).toEqual(['better', 'better']);
    expect(progress.overall).toBe('better');
  });

  it('reads regression, and a flat step as neither', () => {
    const { drills, scores } = history([
      { id: 'a', at: '2026-09-01T06:00:00.000Z', band: 'safe' },
      { id: 'b', at: '2026-09-08T06:00:00.000Z', band: 'safe' },
      { id: 'c', at: '2026-09-15T06:00:00.000Z', band: 'at_risk' },
    ]);
    const progress = learnerProgress(drills, scores);
    expect(progress.steps.map((s) => s.direction)).toEqual(['same', 'worse']);
    expect(progress.overall).toBe('worse');
  });

  it('leaves out a drill the pipeline could not score rather than guessing a band', () => {
    const { drills, scores } = history([
      { id: 'a', at: '2026-09-01T06:00:00.000Z', band: 'at_risk' },
      { id: 'b', at: '2026-09-08T06:00:00.000Z' },
      { id: 'c', at: '2026-09-15T06:00:00.000Z', band: 'safe' },
    ]);
    expect(bandPoints(drills, scores).map((p) => p.drillId)).toEqual(['a'.padEnd(20, '0'), 'c'.padEnd(20, '0')]);
  });
});

describe('weakestTactic', () => {
  it('names the flag that fired most often', () => {
    const { drills, scores } = history([
      { id: 'a', at: '2026-09-01T06:00:00.000Z', band: 'at_risk', flags: { stayed_on_call: true, accepted_secrecy: true } },
      { id: 'b', at: '2026-09-08T06:00:00.000Z', band: 'wobbly', flags: { stayed_on_call: true, accepted_secrecy: false } },
    ]);
    expect(weakestTactic(drills, scores)).toEqual({ id: 'stayed_on_call', label: 'Stayed on the call', count: 2 });
  });

  it('breaks a tie on the most recent firing', () => {
    const { drills, scores } = history([
      { id: 'a', at: '2026-09-01T06:00:00.000Z', band: 'at_risk', flags: { accepted_secrecy: true } },
      { id: 'b', at: '2026-09-08T06:00:00.000Z', band: 'at_risk', flags: { shared_identifier: true } },
    ]);
    expect(weakestTactic(drills, scores)?.id).toBe('shared_identifier');
  });

  it('breaks a tie on the same day by id, so the sentence never wobbles', () => {
    const { drills, scores } = history([
      { id: 'a', at: '2026-09-01T06:00:00.000Z', band: 'at_risk', flags: { shared_identifier: true, accepted_secrecy: true } },
    ]);
    expect(weakestTactic(drills, scores)?.id).toBe('accepted_secrecy');
  });

  it('is nothing when no flag has ever fired', () => {
    const { drills, scores } = history([
      { id: 'a', at: '2026-09-01T06:00:00.000Z', band: 'safe', flags: { stayed_on_call: false } },
    ]);
    expect(weakestTactic(drills, scores)).toBeNull();
  });
});

describe('nextScheduled', () => {
  it('is the soonest call that has not rung', () => {
    const drills = [
      drill('c', '2026-10-01T06:00:00.000Z', { state: 'scheduled' }),
      drill('b', '2026-09-25T06:00:00.000Z', { state: 'scheduled' }),
      drill('a', '2026-09-01T06:00:00.000Z', { state: 'scored' }),
    ];
    expect(nextScheduled(drills)?.scheduledAt).toBe('2026-09-25T06:00:00.000Z');
  });

  it('is nothing when the only drills are over', () => {
    expect(nextScheduled([drill('a', '2026-09-01T06:00:00.000Z', { state: 'missed' })])).toBeNull();
  });
});

describe('flagLabel', () => {
  it('never puts a raw id on the screen', () => {
    expect(flagLabel('agreed_to_move_money')).toBe('Agreed to move money');
    expect(flagLabel('some_future_flag')).toBe('Some future flag');
  });
});
