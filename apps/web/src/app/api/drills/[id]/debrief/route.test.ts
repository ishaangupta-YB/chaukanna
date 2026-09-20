import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Who may read a debrief.
 *
 * The answer is the learner and nobody else, and it is worth a test of its own because this is
 * the one route in the app that returns transcript text. A guardian being able to reach it would
 * not look like a bug on any screen — it would just quietly break the promise the learner was
 * given when they said yes (PRD F7 AC2).
 */

const session = vi.hoisted(() => ({ requireLearner: vi.fn(), currentPrincipals: vi.fn() }));
const access = vi.hoisted(() => ({ resolveMember: vi.fn() }));
const db = vi.hoisted(() => ({ getDrill: vi.fn() }));
const debrief = vi.hoisted(() => ({ learnerDebrief: vi.fn() }));
// Verified Permissions is exercised in `lib/authz.test.ts`; here only the call has to happen.
const authz = vi.hoisted(() => ({ requireAuthz: vi.fn() }));

vi.mock('@/lib/session', () => session);
vi.mock('@/lib/access', () => access);
vi.mock('@/lib/db', () => db);
vi.mock('@/lib/debrief', () => debrief);
vi.mock('@/lib/authz', async (importOriginal) => ({ ...(await importOriginal<object>()), ...authz }));

const { unauthorized, notFound } = await import('@/lib/errors');
const { GET } = await import('./route');

const params = Promise.resolve({ id: 'aaaaaaaabbbbbbbbcccc' });
const request = new Request('https://chaukanna.example/api/drills/aaaaaaaabbbbbbbbcccc/debrief');

beforeEach(() => {
  vi.clearAllMocks();
  authz.requireAuthz.mockResolvedValue(undefined);
  session.currentPrincipals.mockResolvedValue({ guardian: null, learner: null });
});

describe('GET /api/drills/[id]/debrief', () => {
  it('refuses a guardian, whatever member they are signed in for', async () => {
    // A guardian has no learner cookie, so `requireLearner` is what turns them away — before any
    // member is resolved and before the score row is read at all.
    session.requireLearner.mockRejectedValue(unauthorized());

    const response = await GET(request, { params });

    expect(response.status).toBe(401);
    expect(access.resolveMember).not.toHaveBeenCalled();
    expect(db.getDrill).not.toHaveBeenCalled();
    expect(debrief.learnerDebrief).not.toHaveBeenCalled();
  });

  it('looks the drill up inside the learner’s own member row only', async () => {
    session.requireLearner.mockResolvedValue({ m: 'abcdef0123456789abcd', h: '0123456789abcdef0123', exp: 1 });
    access.resolveMember.mockResolvedValue({
      member: { memberId: 'abcdef0123456789abcd', householdId: '0123456789abcdef0123', status: 'active', transcriptSharing: false },
      actor: 'learner',
    });
    db.getDrill.mockResolvedValue({
      drillId: 'aaaaaaaabbbbbbbbcccc',
      memberId: 'abcdef0123456789abcd',
      householdId: '0123456789abcdef0123',
      state: 'scored',
    });
    debrief.learnerDebrief.mockResolvedValue({
      drillId: 'aaaaaaaabbbbbbbbcccc',
      status: 'scored',
      band: 'wobbly',
      turningPoint: 'Aapke naam par ek case darj hua hai.',
      flags: [],
      credits: [],
    });

    const response = await GET(request, { params });

    expect(response.status).toBe(200);
    // `['learner']` and not `['learner', 'guardian']`: the second lock on the same door.
    expect(access.resolveMember).toHaveBeenCalledWith(expect.anything(), 'abcdef0123456789abcd', ['learner']);
    expect(db.getDrill).toHaveBeenCalledWith('abcdef0123456789abcd', 'aaaaaaaabbbbbbbbcccc');
    // Transcript text is read only after policy says so, never on the strength of the cookie.
    expect(authz.requireAuthz).toHaveBeenCalledWith(expect.anything(), 'ViewTranscript', expect.anything());
    await expect(response.json()).resolves.toMatchObject({ status: 'scored', band: 'wobbly' });
  });

  it('is a 404 for a drill that is not in the learner’s history', async () => {
    session.requireLearner.mockResolvedValue({ m: 'abcdef0123456789abcd', h: '0123456789abcdef0123', exp: 1 });
    access.resolveMember.mockResolvedValue({ member: { memberId: 'abcdef0123456789abcd' }, actor: 'learner' });
    db.getDrill.mockResolvedValue(null);

    const response = await GET(request, { params });

    expect(response.status).toBe(404);
    expect(debrief.learnerDebrief).not.toHaveBeenCalled();
  });

  it('passes a drill with no debrief through as the 404 the lib raised', async () => {
    session.requireLearner.mockResolvedValue({ m: 'abcdef0123456789abcd', h: '0123456789abcdef0123', exp: 1 });
    access.resolveMember.mockResolvedValue({ member: { memberId: 'abcdef0123456789abcd' }, actor: 'learner' });
    db.getDrill.mockResolvedValue({
      drillId: 'aaaaaaaabbbbbbbbcccc',
      memberId: 'abcdef0123456789abcd',
      householdId: '0123456789abcdef0123',
      state: 'missed',
    });
    debrief.learnerDebrief.mockRejectedValue(notFound());

    expect((await GET(request, { params })).status).toBe(404);
  });
});
