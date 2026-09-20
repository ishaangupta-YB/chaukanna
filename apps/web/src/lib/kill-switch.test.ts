import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Drill, Member } from './db';

/**
 * The kill switch, end to end (PRD F2 AC4, phase 6 task 5). One tap has to do four things, and
 * three of them are invisible to the person who tapped:
 *
 *   1. the member row says `status: paused`
 *   2. every EventBridge schedule behind a pending drill is deleted
 *   3. every pending drill row is `cancelled`
 *   4. the paused status is persisted under the attribute name `status`, because that is the
 *      attribute the Cedar `ScheduleDrill` forbid policy reads
 *
 * The table and Scheduler are faked, as in `lifecycle.test.ts`: what is under test is that all
 * four happen from one call, not that AWS works.
 */

const db = vi.hoisted(() => ({
  pauseMember: vi.fn(),
  listDrills: vi.fn(),
  cancelDrill: vi.fn(),
  putDrillEvent: vi.fn(),
  getWindow: vi.fn(),
}));
const scheduler = vi.hoisted(() => ({
  createDrillSchedule: vi.fn(),
  deleteDrillSchedule: vi.fn(),
}));

vi.mock('./db', async (importOriginal) => ({ ...(await importOriginal<object>()), ...db }));
vi.mock('./scheduler', () => scheduler);

const { pauseAll } = await import('./members');
const { cancelPendingDrills } = await import('./drills');

function member(overrides: Partial<Member> = {}): Member {
  return {
    memberId: 'abcdef0123456789abcd',
    householdId: '0123456789abcdef0123',
    displayName: 'Dadi',
    language: 'hi-IN',
    status: 'active',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    transcriptSharing: false,
    ...overrides,
  };
}

function drill(overrides: Partial<Drill> = {}): Drill {
  return {
    drillId: 'aaaaaaaabbbbbbbbcccc',
    memberId: 'abcdef0123456789abcd',
    householdId: '0123456789abcdef0123',
    scenarioId: 'digital_arrest_v1',
    language: 'hi-IN',
    state: 'scheduled',
    scheduledAt: '2026-09-21T08:00:00.000Z',
    createdAt: '2026-09-21T03:30:00.000Z',
    updatedAt: '2026-09-21T03:30:00.000Z',
    createdBy: 'guardian',
    maxSeconds: 360,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.pauseMember.mockResolvedValue(undefined);
  db.listDrills.mockResolvedValue([]);
  db.cancelDrill.mockResolvedValue(true);
  db.putDrillEvent.mockResolvedValue(undefined);
  scheduler.deleteDrillSchedule.mockResolvedValue(true);
});

describe('the kill switch', () => {
  it('does all four things from one tap', async () => {
    const paused = member();
    db.listDrills.mockResolvedValue([
      drill({ state: 'scheduled' }),
      drill({ drillId: 'bbbbbbbbccccddddeeee', state: 'due' }),
    ]);

    // What `POST /api/members/[id]/pause-all` does, in its order.
    await pauseAll(paused, 'learner');
    const cancelled = await cancelPendingDrills(paused, 'paused');

    // 1. the member row is paused
    expect(db.pauseMember).toHaveBeenCalledOnce();
    expect(db.pauseMember).toHaveBeenCalledWith(paused.householdId, paused.memberId, expect.any(String));
    // 3. every pending drill row is cancelled
    expect(cancelled).toBe(2);
    expect(db.cancelDrill).toHaveBeenCalledTimes(2);
    expect(db.cancelDrill.mock.calls.map((call) => call[2])).toEqual(['paused', 'paused']);
    // 2. and its schedule is deleted
    expect(scheduler.deleteDrillSchedule.mock.calls.map((call) => call[0])).toEqual([
      'aaaaaaaabbbbbbbbcccc',
      'bbbbbbbbccccddddeeee',
    ]);
  });

  it('writes the paused status under the attribute name the Cedar policy reads', async () => {
    // `forbid(... ScheduleDrill ...) when { resource.status == "paused" }`. The policy reads
    // `status` on the Member row, so the update must name that attribute and that value. Renaming
    // either one here silently unblocks scheduling for a paused learner.
    const sent: { input: Record<string, unknown> }[] = [];
    vi.resetModules();
    vi.doMock('./db/client', () => ({
      ddb: () => ({ send: async (command: { input: Record<string, unknown> }) => void sent.push(command) }),
      table: () => 'chaukanna',
      keys: { member: (h: string, m: string) => ({ pk: `HOUSEHOLD#${h}`, sk: `MEMBER#${m}` }) },
      isConditionFailure: () => false,
    }));
    const { pauseMember } = await import('./db/members');

    await pauseMember('0123456789abcdef0123', 'abcdef0123456789abcd', '2026-09-21T03:30:00.000Z');

    expect(sent).toHaveLength(1);
    expect(sent[0].input.ExpressionAttributeNames).toMatchObject({ '#status': 'status' });
    expect(sent[0].input.ExpressionAttributeValues).toMatchObject({ ':paused': 'paused' });
    expect(String(sent[0].input.UpdateExpression)).toContain('#status = :paused');
    vi.doUnmock('./db/client');
  });

  it('pauses even when there is nothing pending to cancel', async () => {
    db.listDrills.mockResolvedValue([drill({ state: 'ended' })]);

    await pauseAll(member(), 'learner');
    expect(await cancelPendingDrills(member(), 'paused')).toBe(0);
    expect(db.pauseMember).toHaveBeenCalledOnce();
    expect(scheduler.deleteDrillSchedule).not.toHaveBeenCalled();
  });
});
