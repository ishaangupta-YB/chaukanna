import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Who may cause a practice call to exist.
 *
 * The kill switch's fourth effect (phase 6 task 5) is that "the policy blocks new ones", and the
 * phase is explicit that a branch must not be allowed to pass for authorization. `lib/drills.ts`
 * has always refused a paused member, but a refusal written in an `if` is not something that can
 * be shown denying in a policy store, and it drifts the moment somebody reorders the guards.
 *
 * So what is under test here is the wiring rather than the decision — that `ScheduleDrill` is
 * asked about the right member, with the status the row actually carries, and that a deny stops
 * the drill being created at all.
 */

const session = vi.hoisted(() => ({ currentPrincipals: vi.fn() }));
const access = vi.hoisted(() => ({ resolveMember: vi.fn() }));
const drills = vi.hoisted(() => ({
  ringNow: vi.fn(),
  scheduleDrill: vi.fn(),
  DrillNotAllowed: class extends Error {
    constructor(readonly refusal: string) {
      super(refusal);
    }
  },
}));
// The decisions themselves are exercised against the deployed Cedar statements in
// `lib/authz.test.ts`. Here only the call, its arguments and its consequence matter.
const authz = vi.hoisted(() => ({ requireAuthz: vi.fn() }));

vi.mock('@/lib/session', () => session);
vi.mock('@/lib/access', () => access);
vi.mock('@/lib/drills', () => drills);
vi.mock('@/lib/authz', async (importOriginal) => ({ ...(await importOriginal<object>()), ...authz }));
vi.mock('@/lib/households', () => ({ householdIdForGuardian: () => '0123456789abcdef0123' }));

const { forbidden } = await import('@/lib/errors');
const { POST } = await import('./route');

const MEMBER = 'abcdef0123456789abcd';
const HOUSEHOLD = '0123456789abcdef0123';
const params = Promise.resolve({ id: MEMBER });

function request(body: unknown) {
  return new Request(`https://chaukanna.example/api/members/${MEMBER}/drills`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://chaukanna.example' },
    body: JSON.stringify(body),
  });
}

function member(status: string) {
  return { memberId: MEMBER, householdId: HOUSEHOLD, status, transcriptSharing: false };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.APP_URL = 'https://chaukanna.example';
  authz.requireAuthz.mockResolvedValue(undefined);
  session.currentPrincipals.mockResolvedValue({ guardian: { sub: 'guardian-sub-1' }, learner: null });
  drills.scheduleDrill.mockResolvedValue({ drillId: 'aaaaaaaabbbbbbbbcccc', state: 'scheduled', scheduledAt: '2026-09-21T08:00:00.000Z' });
  drills.ringNow.mockResolvedValue({ drillId: 'aaaaaaaabbbbbbbbcccc', state: 'due', scheduledAt: '2026-09-21T08:00:00.000Z' });
});

describe('POST /api/members/[id]/drills', () => {
  it('asks ScheduleDrill about the member, carrying the status the row holds', async () => {
    access.resolveMember.mockResolvedValue({ member: member('active'), actor: 'guardian' });

    const response = await POST(request({ schedule: true }), { params });

    expect(response.status).toBe(201);
    expect(authz.requireAuthz).toHaveBeenCalledOnce();
    const [principal, action, resource] = authz.requireAuthz.mock.calls[0];
    expect(action).toBe('ScheduleDrill');
    // The `forbid` reads `resource.status`, so the live status has to be what is sent. A
    // hardcoded "active" here would make the policy unable to ever deny.
    expect(resource).toMatchObject({ type: 'Member', id: MEMBER, attributes: { status: 'active', householdId: HOUSEHOLD } });
    expect(principal).toMatchObject({ type: 'Member', id: 'guardian-sub-1' });
  });

  it('sends a paused member’s status so the forbid can fire', async () => {
    access.resolveMember.mockResolvedValue({ member: member('paused'), actor: 'guardian' });
    authz.requireAuthz.mockRejectedValue(forbidden('authz_denied'));

    const response = await POST(request({ schedule: true }), { params });

    expect(authz.requireAuthz.mock.calls[0][2]).toMatchObject({ attributes: { status: 'paused' } });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: 'authz_denied' });
    // The point of the whole exercise: no drill row is written when policy says no.
    expect(drills.scheduleDrill).not.toHaveBeenCalled();
    expect(drills.ringNow).not.toHaveBeenCalled();
  });

  it('authorizes the "ring now" path too, not only the scheduled one', async () => {
    access.resolveMember.mockResolvedValue({ member: member('paused'), actor: 'guardian' });
    authz.requireAuthz.mockRejectedValue(forbidden('authz_denied'));

    expect((await POST(request({ now: true }), { params })).status).toBe(403);
    expect(drills.ringNow).not.toHaveBeenCalled();
  });

  it('decides before the body is even parsed, so a malformed request cannot probe the rules', async () => {
    access.resolveMember.mockResolvedValue({ member: member('paused'), actor: 'guardian' });
    authz.requireAuthz.mockRejectedValue(forbidden('authz_denied'));

    // `{}` matches neither arm of the union and would otherwise be a 400.
    expect((await POST(request({}), { params })).status).toBe(403);
  });

  it('defaults to deny when Verified Permissions cannot be reached', async () => {
    access.resolveMember.mockResolvedValue({ member: member('active'), actor: 'guardian' });
    authz.requireAuthz.mockRejectedValue(forbidden('authz_unavailable'));

    const response = await POST(request({ schedule: true }), { params });

    expect(response.status).toBe(403);
    expect(drills.scheduleDrill).not.toHaveBeenCalled();
  });
});
