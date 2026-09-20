import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Drill } from './db';
import { SESSION_TOKEN_TTL_SECONDS, drillSessionClaims, signDrillSessionToken } from './drill-session';
import { deriveKey, verify } from './signing';

/**
 * The other half of the contract in `apps/agent/tests/test_session_token.py`. Both tests read the
 * same committed fixture: this one proves we still produce that exact token, the Python one
 * proves the agent still accepts it.
 */

const VECTOR = JSON.parse(
  readFileSync(join(process.cwd(), '..', '..', 'fixtures', 'drill-session-token.json'), 'utf8'),
) as { masterKey: string; claims: ReturnType<typeof drillSessionClaims>; token: string };

const DRILL: Drill = {
  drillId: 'd1e2f3a4b5c6d7e8f9a0',
  memberId: 'abcdef0123456789abcd',
  householdId: '0123456789abcdef0123',
  scenarioId: 'digital_arrest_v1',
  language: 'hi-IN',
  state: 'due',
  scheduledAt: '2026-09-20T11:30:00.000Z',
  createdAt: '2026-09-20T11:30:00.000Z',
  updatedAt: '2026-09-20T11:30:00.000Z',
  createdBy: 'guardian',
  maxSeconds: 360,
};

describe('drill session token', () => {
  it('still produces the token the agent is tested against', () => {
    expect(signDrillSessionToken(VECTOR.masterKey, VECTOR.claims)).toBe(VECTOR.token);
  });

  it('builds its claims from the drill row, not from anything a browser sent', () => {
    const claims = drillSessionClaims(DRILL, '9f8e7d6c5b4a39281706', 1_800_000_000);
    expect(claims).toEqual({
      d: DRILL.drillId,
      m: DRILL.memberId,
      h: DRILL.householdId,
      t: DRILL.scheduledAt,
      l: DRILL.language,
      s: DRILL.scenarioId,
      x: DRILL.maxSeconds,
      j: '9f8e7d6c5b4a39281706',
      exp: 1_800_000_000 + SESSION_TOKEN_TTL_SECONDS,
    });
  });

  it('expires in five minutes', () => {
    expect(SESSION_TOKEN_TTL_SECONDS).toBe(300);
  });

  it('cannot be verified with the invite key', () => {
    // An invite link must never be replayable as permission to take a call, and the other way
    // round. Separate derived keys are what makes that true rather than hoped for.
    const token = signDrillSessionToken(VECTOR.masterKey, VECTOR.claims);
    expect(verify(token, deriveKey(VECTOR.masterKey, 'invite'))).toBeNull();
    expect(verify(token, deriveKey(VECTOR.masterKey, 'learner-session'))).toBeNull();
    expect(verify(token, deriveKey(VECTOR.masterKey, 'drill-session'))).not.toBeNull();
  });

  it('rejects a tampered claim', () => {
    const token = signDrillSessionToken(VECTOR.masterKey, VECTOR.claims);
    const [body, mac] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...VECTOR.claims, x: 900 })).toString('base64url');
    expect(forged).not.toBe(body);
    expect(verify(`${forged}.${mac}`, deriveKey(VECTOR.masterKey, 'drill-session'))).toBeNull();
  });
});
