import { cookies } from 'next/headers';
import type { Principals } from './access';
import { GUARDIAN_COOKIE, verifyGuardianToken, type Guardian } from './auth';
import { config } from './config';
import { unauthorized } from './errors';
import { LEARNER_COOKIE, readLearnerSession, type LearnerSession } from './learner-session';
import { getInviteSigningKey } from './secrets';

/** Next.js glue: reads the session cookies. Verification itself lives in auth.ts and learner-session.ts. */

export async function currentGuardian(): Promise<Guardian | null> {
  const token = (await cookies()).get(GUARDIAN_COOKIE)?.value;
  return token ? verifyGuardianToken(token) : null;
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
