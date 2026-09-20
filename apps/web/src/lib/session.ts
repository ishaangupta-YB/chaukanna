import { cookies } from 'next/headers';
import type { Principals } from './access';
import { GUARDIAN_COOKIE, verifyGuardianToken, type Guardian } from './auth';
import { config } from './config';
import { DEMO_COOKIE, demoGuardianFrom, readDemoSession, type DemoSession } from './demo';
import { unauthorized } from './errors';
import { LEARNER_COOKIE, readLearnerSession, type LearnerSession } from './learner-session';
import { getInviteSigningKey } from './secrets';

/** Next.js glue: reads the session cookies. Verification itself lives in auth.ts and learner-session.ts. */

/**
 * A Cognito ID token first, always. Only when that is absent or invalid, and only while
 * `DEMO_MODE=on`, does a signed judge demo cookie stand in — and the guardian it returns carries
 * `demo: true` so no caller can confuse the two. With demo mode off the second branch is not
 * reached at all and the demo cookie is never even read.
 */
export async function currentGuardian(): Promise<Guardian | null> {
  const jar = await cookies();
  const token = jar.get(GUARDIAN_COOKIE)?.value;
  const guardian = token ? await verifyGuardianToken(token) : null;
  if (guardian) return guardian;
  if (!config.demoMode) return null;
  const demo = jar.get(DEMO_COOKIE)?.value;
  if (!demo) return null;
  return demoGuardianFrom(await getInviteSigningKey(), demo);
}

/** The demo session behind the current request, or null. Null whenever `DEMO_MODE` is not on. */
export async function currentDemoSession(): Promise<DemoSession | null> {
  if (!config.demoMode) return null;
  const value = (await cookies()).get(DEMO_COOKIE)?.value;
  if (!value) return null;
  return readDemoSession(await getInviteSigningKey(), value);
}

export async function currentLearner(): Promise<LearnerSession | null> {
  const value = (await cookies()).get(LEARNER_COOKIE)?.value;
  if (!value) return null;
  return readLearnerSession(await getInviteSigningKey(), value);
}

export async function currentPrincipals(): Promise<Principals> {
  const [guardian, learner] = await Promise.all([currentGuardian(), currentLearner()]);
  return { guardian, learner };
}

export async function requireGuardian(): Promise<Guardian> {
  const guardian = await currentGuardian();
  if (!guardian) throw unauthorized();
  return guardian;
}

export async function requireLearner(): Promise<LearnerSession> {
  const learner = await currentLearner();
  if (!learner) throw unauthorized();
  return learner;
}

export function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'lax' as const,
    path: '/',
    maxAge,
  };
}
