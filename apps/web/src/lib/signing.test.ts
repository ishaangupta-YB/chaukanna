import { describe, expect, it } from 'vitest';
import { deriveKey, sign, verify } from './signing';

const MASTER = 'test-master-key-that-is-long-enough-000000';

describe('signed tokens', () => {
  const key = deriveKey(MASTER, 'invite');

  it('round trips a payload', () => {
    const token = sign({ m: 'abc', n: 1 }, key);
    expect(verify(token, key)).toEqual({ m: 'abc', n: 1 });
  });

  it('rejects a tampered payload', () => {
    const token = sign({ m: 'abc' }, key);
    const [, mac] = token.split('.');
    const forged = `${Buffer.from(JSON.stringify({ m: 'xyz' })).toString('base64url')}.${mac}`;
    expect(verify(forged, key)).toBeNull();
  });

  it('rejects a tampered signature', () => {
    const token = sign({ m: 'abc' }, key);
    expect(verify(`${token.slice(0, -2)}AA`, key)).toBeNull();
  });

  it('rejects a token signed with a different master key', () => {
    const token = sign({ m: 'abc' }, deriveKey('another-master-key-that-is-long-000000', 'invite'));
    expect(verify(token, key)).toBeNull();
  });

  it('keeps purposes apart: an invite never verifies as a learner session', () => {
    const token = sign({ m: 'abc' }, key);
    expect(verify(token, deriveKey(MASTER, 'learner-session'))).toBeNull();
  });

  it.each(['', '.', 'a.', '.b', 'a.b.c', 'not-a-token'])('rejects malformed input %j', (bad) => {
    expect(verify(bad, key)).toBeNull();
  });
});
