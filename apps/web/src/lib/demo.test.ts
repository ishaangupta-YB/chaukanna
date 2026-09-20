import { afterEach, describe, expect, it } from 'vitest';
import {
  assertDemoFormPost,
  DEMO_SESSION_TTL_SECONDS,
  DEMO_SUB_PREFIX,
  DEMO_WINDOW,
  demoGuardianFrom,
  isDemoSub,
  issueDemoSession,
  newDemoSub,
  readDemoSession,
} from './demo';
import { config } from './config';
import { DrillWindow } from './db';
import { householdIdForGuardian } from './households';
import { issueInvite } from './invite';
import { issueLearnerSession } from './learner-session';
import { cookieOptions } from './session';

const MASTER = 'test-master-key-that-is-long-enough-000000';
const NOW = 1_800_000_000;
const SUB = 'demo-0123456789abcdef';
const TOKEN = 'invite-token-placeholder';

function session(now = NOW) {
  return issueDemoSession(MASTER, SUB, TOKEN, now).value;
}

afterEach(() => {
  delete process.env.DEMO_MODE;
});

describe('DEMO_MODE', () => {
  it('is off unless the value is exactly "on"', () => {
    for (const value of [undefined, '', 'off', 'true', '1', 'yes', 'ON', 'On']) {
      if (value === undefined) delete process.env.DEMO_MODE;
      else process.env.DEMO_MODE = value;
      expect(config.demoMode).toBe(false);
    }
    process.env.DEMO_MODE = 'on';
    expect(config.demoMode).toBe(true);
  });
});

describe('demo session cookie', () => {
  it('round trips the subject, the invite token and an expiry two hours out', () => {
    expect(DEMO_SESSION_TTL_SECONDS).toBe(7200);
    const issued = issueDemoSession(MASTER, SUB, TOKEN, NOW);
    expect(issued.maxAge).toBe(DEMO_SESSION_TTL_SECONDS);
    expect(readDemoSession(MASTER, issued.value, NOW + 10)).toEqual({ s: SUB, i: TOKEN, exp: NOW + 7200 });
  });

  it('is rejected at and after expiry', () => {
    expect(readDemoSession(MASTER, session(), NOW + DEMO_SESSION_TTL_SECONDS)).toBeNull();
    expect(readDemoSession(MASTER, session(), NOW + DEMO_SESSION_TTL_SECONDS + 1)).toBeNull();
  });

  it('is rejected under a different master key', () => {
    expect(readDemoSession('another-master-key-that-is-long-000000', session(), NOW)).toBeNull();
  });

  it('is rejected when the payload is tampered with', () => {
    const [body, mac] = session().split('.');
    const forged = Buffer.from(JSON.stringify({ s: 'demo-ffffffffffffffff', i: TOKEN, exp: NOW + 7200 })).toString(
      'base64url',
    );
    expect(readDemoSession(MASTER, `${forged}.${mac}`, NOW)).toBeNull();
    expect(readDemoSession(MASTER, `${body}.${Buffer.from('nope').toString('base64url')}`, NOW)).toBeNull();
  });

  it('is rejected when it is malformed, empty or absurdly long', () => {
    for (const value of ['', '.', 'nodot', 'a.b.c', 'x'.repeat(2000)]) {
      expect(readDemoSession(MASTER, value, NOW)).toBeNull();
    }
  });

  it('cannot be forged out of an invite or a learner session signed with the same master key', () => {
    // Purpose separation: each token kind is signed under its own derived key.
    const invite = issueInvite(MASTER, 'aaaa1111', 'bbbb2222', NOW).token;
    const learner = issueLearnerSession(MASTER, 'aaaa1111', 'bbbb2222', NOW).value;
    expect(readDemoSession(MASTER, invite, NOW)).toBeNull();
    expect(readDemoSession(MASTER, learner, NOW)).toBeNull();
  });

  it('refuses to be signed for anything but a demo subject', () => {
    for (const sub of ['guardian-sub', 'demo-', 'demo-xyz', 'demo-0123456789ABCDEF', '']) {
      expect(() => issueDemoSession(MASTER, sub, TOKEN, NOW)).toThrow();
    }
  });
});

describe('demoGuardianFrom', () => {
  it('resolves a valid cookie to a guardian flagged demo, with no email', () => {
    expect(demoGuardianFrom(MASTER, session(), true, NOW)).toEqual({ sub: SUB, email: null, demo: true });
  });

  it('returns null for a perfectly valid cookie when DEMO_MODE is off', () => {
    // The property that matters most: a cookie that leaks out of a demo deployment is inert.
    expect(demoGuardianFrom(MASTER, session(), false, NOW)).toBeNull();
  });

  it('defaults its gate to the live DEMO_MODE', () => {
    const value = session();
    delete process.env.DEMO_MODE;
    expect(demoGuardianFrom(MASTER, value, undefined, NOW)).toBeNull();
    process.env.DEMO_MODE = 'on';
    expect(demoGuardianFrom(MASTER, value, undefined, NOW)).not.toBeNull();
  });

  it('returns null for a missing, expired or tampered cookie even when enabled', () => {
    expect(demoGuardianFrom(MASTER, undefined, true, NOW)).toBeNull();
    expect(demoGuardianFrom(MASTER, session(), true, NOW + DEMO_SESSION_TTL_SECONDS)).toBeNull();
    expect(demoGuardianFrom(MASTER, `${session()}x`, true, NOW)).toBeNull();
  });
});

describe('demo identity', () => {
  it('mints a fresh random subject every time', () => {
    const subs = new Set(Array.from({ length: 200 }, newDemoSub));
    expect(subs.size).toBe(200);
    for (const sub of subs) {
      expect(sub.startsWith(DEMO_SUB_PREFIX)).toBe(true);
      expect(isDemoSub(sub)).toBe(true);
    }
  });

  it('cannot reach a household it did not create', () => {
    /*
     * A household id is sha256("household:" + sub), so a demo subject addresses keys no Cognito
     * subject can produce and no other demo subject shares. getGuardianHousehold then checks
     * ownerSub as well, so even a collision would not hand over the row.
     */
    const a = newDemoSub();
    const b = newDemoSub();
    expect(householdIdForGuardian(a)).not.toBe(householdIdForGuardian(b));
    expect(householdIdForGuardian(a)).not.toBe(householdIdForGuardian('a-real-cognito-sub'));
    expect(householdIdForGuardian(a)).toBe(householdIdForGuardian(a));
  });

  it('does not accept a real Cognito subject as a demo one', () => {
    expect(isDemoSub('b1e2c3d4-1111-2222-3333-444455556666')).toBe(false);
    expect(isDemoSub('demo')).toBe(false);
  });
});

describe('demo seed data', () => {
  it('opens a window the drill rules accept, every day', () => {
    expect(DrillWindow.parse(DEMO_WINDOW)).toEqual(DEMO_WINDOW);
    expect(DEMO_WINDOW.days).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});

describe('assertDemoFormPost', () => {
  const APP = 'http://localhost:3000';
  const req = (headers: Record<string, string>) =>
    new Request('http://localhost:3000/api/demo/start', { method: 'POST', headers });

  it('accepts a same-origin form navigation, which may carry no Origin at all', () => {
    expect(() => assertDemoFormPost(req({ 'sec-fetch-site': 'same-origin' }), APP)).not.toThrow();
  });

  it('accepts a same-origin fetch, which carries both', () => {
    expect(() => assertDemoFormPost(req({ origin: APP, 'sec-fetch-site': 'same-origin' }), APP)).not.toThrow();
  });

  it('refuses every other fetch metadata value, including a typed URL', () => {
    for (const site of ['cross-site', 'same-site', 'none']) {
      // Note: even with a forged matching Origin, fetch metadata wins — a page cannot set it.
      expect(() => assertDemoFormPost(req({ origin: APP, 'sec-fetch-site': site }), APP)).toThrow();
    }
  });

  it('falls back to the Origin check when there is no fetch metadata', () => {
    expect(() => assertDemoFormPost(req({ origin: APP }), APP)).not.toThrow();
    expect(() => assertDemoFormPost(req({ origin: 'https://evil.example' }), APP)).toThrow();
    expect(() => assertDemoFormPost(req({}), APP)).toThrow();
  });
});

describe('cookie options', () => {
  it('are httpOnly and SameSite=Lax, like every other session cookie here', () => {
    const options = cookieOptions(DEMO_SESSION_TTL_SECONDS);
    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe('lax');
    expect(options.path).toBe('/');
    expect(options.maxAge).toBe(DEMO_SESSION_TTL_SECONDS);
  });
});
