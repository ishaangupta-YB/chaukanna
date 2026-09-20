import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_WINDOW, type Drill, type Member } from './db';

/**
 * The drill lifecycle: who may create a drill, what happens to one that is already in flight when
 * somebody withdraws, and what a drill nobody answered turns into.
 *
 * Every one of these is a rule about ringing a stranger's voice into an elderly person's house,
 * so the table and the scheduler are both faked here rather than reached: the point is the order
 * and the conditions, not AWS.
 */

const db = vi.hoisted(() => ({
  listDrills: vi.fn(),
  putDrill: vi.fn(),
  cancelDrill: vi.fn(),
  markDrillMissed: vi.fn(),
  putDrillEvent: vi.fn(),
  getLatestConsent: vi.fn(),
  getWindow: vi.fn(),
  latestDrill: vi.fn(),
}));
const scheduler = vi.hoisted(() => ({
  createDrillSchedule: vi.fn(),
  deleteDrillSchedule: vi.fn(),
}));

vi.mock('./db', async (importOriginal) => ({ ...(await importOriginal<object>()), ...db }));
vi.mock('./scheduler', () => scheduler);

const { cancelPendingDrills, guardDrillStart, ringNow, scheduleDrill, settleDrill } = await import('./drills');

/** Monday 21 September 2026, 09:00 IST: a weekday, before the default 11:00 window opens. */
const MONDAY_0900_IST = new Date('2026-09-21T03:30:00Z');

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
  db.listDrills.mockResolvedValue([]);
  db.putDrill.mockResolvedValue(undefined);
  db.putDrillEvent.mockResolvedValue(undefined);
  db.cancelDrill.mockResolvedValue(true);
  db.markDrillMissed.mockResolvedValue(true);
  db.getLatestConsent.mockResolvedValue({ memberId: 'abcdef0123456789abcd', at: '2026-09-01T00:00:00.000Z' });
  db.getWindow.mockResolvedValue(null); // falls back to the PRD default window
  scheduler.createDrillSchedule.mockResolvedValue('chaukanna-drill-aaaaaaaabbbbbbbbcccc');
  scheduler.deleteDrillSchedule.mockResolvedValue(true);
});

describe('scheduleDrill', () => {
  it('schedules from outside the window, for an instant inside it', async () => {
    // 09:00 on a Monday is outside 11:00-18:00, and that must not stop a drill being scheduled:
    // the window governs when the call happens, not when the guardian presses the button.
    const created = await scheduleDrill(member(), 'guardian', MONDAY_0900_IST);

    expect(created.state).toBe('scheduled');
    const ringAt = new Date(created.scheduledAt);
    expect(ringAt.getTime()).toBeGreaterThan(MONDAY_0900_IST.getTime());
    const { isInsideWindow } = await import('./drills');
    expect(isInsideWindow(DEFAULT_WINDOW, ringAt)).toBe(true);
  });

  it('creates the schedule with the chosen instant and the window timezone', async () => {
    const created = await scheduleDrill(member(), 'guardian', MONDAY_0900_IST);

    expect(scheduler.createDrillSchedule).toHaveBeenCalledWith({
      drillId: created.drillId,
      memberId: created.memberId,
      at: new Date(created.scheduledAt),
      timeZone: DEFAULT_WINDOW.tz,
    });
  });

  it('records the chosen instant in the audit trail, so nobody has to take it on trust', async () => {
    const created = await scheduleDrill(member(), 'guardian', MONDAY_0900_IST);

    const event = db.putDrillEvent.mock.calls.at(-1)?.[0];
    expect(event.name).toBe('drill.scheduled');
    expect(event.detail).toEqual({ ringAt: created.scheduledAt, tz: DEFAULT_WINDOW.tz });
  });

  it('undoes the row when the schedule cannot be created, so the week is not burned', async () => {
    scheduler.createDrillSchedule.mockRejectedValue(new Error('scheduler down'));

    await expect(scheduleDrill(member(), 'guardian', MONDAY_0900_IST)).rejects.toThrow('scheduler down');
    // Cancelled, not left behind: a cancelled drill does not count against the weekly cap.
    expect(db.cancelDrill).toHaveBeenCalledOnce();
    expect(db.cancelDrill.mock.calls[0][2]).toBe('schedule_failed');
  });

  it('refuses a paused member', async () => {
    await expect(scheduleDrill(member({ status: 'paused' }), 'guardian', MONDAY_0900_IST)).rejects.toThrow('paused');
    expect(db.putDrill).not.toHaveBeenCalled();
  });

  it('refuses when consent has been withdrawn', async () => {
    db.getLatestConsent.mockResolvedValue({ at: '2026-09-01T00:00:00.000Z', revokedAt: '2026-09-02T00:00:00.000Z' });
    await expect(scheduleDrill(member(), 'guardian', MONDAY_0900_IST)).rejects.toThrow('not_consented');
  });

  it('refuses a second drill inside the weekly cooldown', async () => {
    db.listDrills.mockResolvedValue([drill({ state: 'ended', createdAt: '2026-09-19T03:30:00.000Z' })]);
    await expect(scheduleDrill(member(), 'guardian', MONDAY_0900_IST)).rejects.toThrow('weekly_cap');
  });
});

describe('ringNow', () => {
  /** Inside the default window: Monday 12:00 IST. */
  const MONDAY_1200_IST = new Date('2026-09-21T06:30:00Z');

  it('rings a drill that is already due', async () => {
    const created = await ringNow(member(), 'guardian', MONDAY_1200_IST);
    expect(created.state).toBe('due');
    expect(created.dueExpiresAt).toBe(Math.floor(MONDAY_1200_IST.getTime() / 1000) + 30 * 60);
    expect(scheduler.createDrillSchedule).not.toHaveBeenCalled();
  });

  it('is the guardian’s control alone', async () => {
    await expect(ringNow(member(), 'learner', MONDAY_1200_IST)).rejects.toThrow('ring_now_is_guardian_only');
  });

  it('refuses outside the window, unlike scheduling', async () => {
    await expect(ringNow(member(), 'guardian', MONDAY_0900_IST)).rejects.toThrow('outside_window');
  });

  it('will not ring twice in ten minutes, even after a cancelled drill', async () => {
    // A cancelled drill does not count against the weekly cap, so without the rate limit a
    // declined call could be followed straight away by another one.
    db.listDrills.mockResolvedValue([
      drill({ state: 'cancelled', createdAt: new Date(MONDAY_1200_IST.getTime() - 60_000).toISOString() }),
    ]);
    await expect(ringNow(member(), 'guardian', MONDAY_1200_IST)).rejects.toThrow('ring_too_soon');
  });
});

describe('cancelPendingDrills', () => {
  it('cancels every drill that has not become a call, and deletes its schedule', async () => {
    db.listDrills.mockResolvedValue([drill({ state: 'scheduled' }), drill({ drillId: 'bbbbbbbbccccddddeeee', state: 'due' })]);

    expect(await cancelPendingDrills(member(), 'consent_withdrawn')).toBe(2);
    expect(scheduler.deleteDrillSchedule).toHaveBeenCalledTimes(2);
  });

  it('marks the row before it touches the schedule', async () => {
    // If the process dies between the two, the drill must already be cancelled: the ring Lambda
    // re-reads the row, so a schedule that survives rings nobody. The reverse order would leave a
    // live drill with no schedule to stop it.
    const order: string[] = [];
    db.listDrills.mockResolvedValue([drill({ state: 'due' })]);
    db.cancelDrill.mockImplementation(async () => {
      order.push('row');
      return true;
    });
    scheduler.deleteDrillSchedule.mockImplementation(async () => {
      order.push('schedule');
      return true;
    });

    await cancelPendingDrills(member(), 'paused');
    expect(order).toEqual(['row', 'schedule']);
  });

  it('leaves a call that is already under way to the agent', async () => {
    db.listDrills.mockResolvedValue([drill({ state: 'in_progress' }), drill({ drillId: 'ccccddddeeeeffff0000', state: 'ended' })]);

    expect(await cancelPendingDrills(member(), 'paused')).toBe(0);
    expect(db.cancelDrill).not.toHaveBeenCalled();
    expect(scheduler.deleteDrillSchedule).not.toHaveBeenCalled();
  });

  it('does not claim a cancellation the conditional write refused', async () => {
    db.listDrills.mockResolvedValue([drill({ state: 'due' })]);
    db.cancelDrill.mockResolvedValue(false); // the agent claimed it in the same instant

    expect(await cancelPendingDrills(member(), 'paused')).toBe(0);
    expect(db.putDrillEvent).not.toHaveBeenCalled();
  });
});

describe('settleDrill', () => {
  const expired = Math.floor(Date.now() / 1000) - 60;
  const live = Math.floor(Date.now() / 1000) + 600;

  it('turns a drill nobody answered into a missed one', async () => {
    const settled = await settleDrill(drill({ state: 'due', dueExpiresAt: expired }));
    expect(settled.state).toBe('missed');
    expect(db.putDrillEvent.mock.calls.at(-1)?.[0].name).toBe('drill.missed');
  });

  it('leaves a drill that is still ringing alone', async () => {
    const settled = await settleDrill(drill({ state: 'due', dueExpiresAt: live }));
    expect(settled.state).toBe('due');
    expect(db.markDrillMissed).not.toHaveBeenCalled();
  });

  it('lets the learner win the race when the conditional write refuses', async () => {
    db.markDrillMissed.mockResolvedValue(false);
    const settled = await settleDrill(drill({ state: 'session_pending', dueExpiresAt: expired }));
    expect(settled.state).toBe('session_pending');
  });

  it('never touches a drill that has no ring to expire', async () => {
    const settled = await settleDrill(drill({ state: 'scheduled' }));
    expect(settled.state).toBe('scheduled');
    expect(db.markDrillMissed).not.toHaveBeenCalled();
  });
});

describe('guardDrillStart', () => {
  const MONDAY_1200_IST = new Date('2026-09-21T06:30:00Z');

  it('refuses a ring that lapsed while nobody was looking', async () => {
    const lapsed = drill({ state: 'due', dueExpiresAt: Math.floor(Date.now() / 1000) - 60 });
    await expect(guardDrillStart(member(), lapsed, MONDAY_1200_IST)).rejects.toThrow('not_ready');
    expect(db.markDrillMissed).toHaveBeenCalledOnce();
  });

  it('lets a ring that is still live through', async () => {
    const live = drill({ state: 'due', dueExpiresAt: Math.floor(Date.now() / 1000) + 600 });
    await expect(guardDrillStart(member(), live, MONDAY_1200_IST)).resolves.toBeUndefined();
  });
});
