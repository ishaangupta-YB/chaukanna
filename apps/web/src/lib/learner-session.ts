import { z } from 'zod';
import { deriveKey, nowSeconds, sign, verify } from './signing';

/**
 * The learner never has an account. Accepting an invite sets this signed, httpOnly cookie on
 * their phone, bound to one member. Losing it means the guardian sends a fresh invite.
 */

export const LEARNER_COOKIE = 'ck_learner';
export const LEARNER_SESSION_TTL_SECONDS = 90 * 24 * 60 * 60;

const LearnerSession = z.object({
  m: z.string().min(1).max(64),
  h: z.string().min(1).max(64),
  exp: z.number().int().positive(),
});
export type LearnerSession = z.infer<typeof LearnerSession>;

export function issueLearnerSession(
  masterKey: string,
  memberId: string,
  householdId: string,
  now = nowSeconds(),
): { value: string; maxAge: number } {
  const value = sign(
    { m: memberId, h: householdId, exp: now + LEARNER_SESSION_TTL_SECONDS },
    deriveKey(masterKey, 'learner-session'),
  );
  return { value, maxAge: LEARNER_SESSION_TTL_SECONDS };
}

export function readLearnerSession(masterKey: string, value: string, now = nowSeconds()): LearnerSession | null {
  if (value.length > 512) return null;
  const parsed = LearnerSession.safeParse(verify(value, deriveKey(masterKey, 'learner-session')));
  if (!parsed.success || parsed.data.exp <= now) return null;
  return parsed.data;
}
