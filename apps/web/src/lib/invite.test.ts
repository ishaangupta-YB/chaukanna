import { describe, expect, it } from 'vitest';
import { checkInvite, hashInvite, INVITE_TTL_SECONDS, issueInvite } from './invite';
import { issueLearnerSession, readLearnerSession } from './learner-session';
import { deriveKey, sign } from './signing';

const MASTER = 'test-master-key-that-is-long-enough-000000';
const NOW = 1_800_000_000;

describe('invite tokens', () => {
  it('carries memberId and householdId and expires in 72 hours', () => {
    const invite = issueInvite(MASTER, 'aaaa1111', 'bbbb2222', NOW);
    expect(invite.expiresAt).toBe(NOW + 72 * 60 * 60);
    expect(INVITE_TTL_SECONDS).toBe(259200);
    const check = checkInvite(MASTER, invite.token, NOW + 10);
    expect(check).toEqual({
      ok: true,
      payload: { m: 'aaaa1111', h: 'bbbb2222', exp: invite.expiresAt },
      tokenHash: invite.tokenHash,
    });
  });

  it('stores only a hash of the token', () => {
    const invite = issueInvite(MASTER, 'aaaa1111', 'bbbb2222', NOW);
    expect(invite.tokenHash).toBe(hashInvite(invite.token));
    expect(invite.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(invite.tokenHash).not.toContain(invite.token);
  });

  it('is rejected at and after expiry', () => {
    const invite = issueInvite(MASTER, 'aaaa1111', 'bbbb2222', NOW);
    expect(checkInvite(MASTER, invite.token, invite.expiresAt)).toEqual({ ok: false, reason: 'expired' });
  });

  it('is rejected with a different signing key', () => {
    const invite = issueInvite(MASTER, 'aaaa1111', 'bbbb2222', NOW);
    expect(checkInvite('another-master-key-that-is-long-000000', invite.token, NOW)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('is rejected when a validly signed payload has the wrong shape', () => {
    const token = sign({ m: 'aaaa1111', exp: NOW + 100 }, deriveKey(MASTER, 'invite'));
    expect(checkInvite(MASTER, token, NOW)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('cannot be used as a learner session', () => {
    const invite = issueInvite(MASTER, 'aaaa1111', 'bbbb2222', NOW);
    expect(readLearnerSession(MASTER, invite.token, NOW)).toBeNull();
  });
});

describe('learner sessions', () => {
  it('round trips and expires', () => {
    const { value, maxAge } = issueLearnerSession(MASTER, 'aaaa1111', 'bbbb2222', NOW);
    expect(readLearnerSession(MASTER, value, NOW)).toEqual({ m: 'aaaa1111', h: 'bbbb2222', exp: NOW + maxAge });
    expect(readLearnerSession(MASTER, value, NOW + maxAge)).toBeNull();
  });

  it('cannot be used as an invite', () => {
    const { value } = issueLearnerSession(MASTER, 'aaaa1111', 'bbbb2222', NOW);
    expect(checkInvite(MASTER, value, NOW).ok).toBe(false);
  });
});
