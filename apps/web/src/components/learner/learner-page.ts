import { getMember, type Member } from '@/lib/db';
import { currentLearner } from '@/lib/session';

/** The signed-in learner's own member row, or null when there is no valid learner cookie. */
export async function loadLearnerMember(): Promise<Member | null> {
  const learner = await currentLearner();
  return learner ? getMember(learner.h, learner.m) : null;
}
