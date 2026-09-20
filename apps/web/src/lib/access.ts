import type { Guardian } from './auth';
import { getMember, type Member } from './db';
import { notFound, unauthorized } from './errors';
import { householdIdForGuardian } from './households';
import type { LearnerSession } from './learner-session';

/**
 * Phase 1 access rules, default deny. Phase 6 moves these decisions into Verified Permissions.
 * A guardian reaches members of their own household only. A learner reaches only themselves.
 * A member outside the caller's reach is reported as not found, never as forbidden, so ids
 * cannot be probed.
 */

export type Actor = 'guardian' | 'learner';

export interface Principals {
  guardian: Guardian | null;
  learner: LearnerSession | null;
}

export async function resolveMember(
  principals: Principals,
  memberId: string,
  allowed: readonly Actor[],
): Promise<{ member: Member; actor: Actor }> {
  if (allowed.includes('learner') && principals.learner && principals.learner.m === memberId) {
    const member = await getMember(principals.learner.h, memberId);
    if (member) return { member, actor: 'learner' };
  }
  if (allowed.includes('guardian') && principals.guardian) {
    const member = await getMember(householdIdForGuardian(principals.guardian.sub), memberId);
    if (member) return { member, actor: 'guardian' };
  }
  if (!principals.guardian && !principals.learner) throw unauthorized();
  throw notFound();
}
