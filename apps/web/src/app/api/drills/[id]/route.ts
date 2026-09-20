import { resolveMember, type Actor, type Principals } from '@/lib/access';
import {
  buildDrillResource,
  buildGuardianPrincipal,
  buildLearnerPrincipal,
  requireAuthz,
  VP_ACTIONS,
  type VPPrincipal,
} from '@/lib/authz';
import { getDrill, type Member } from '@/lib/db';
import { settleDrill, toDrillView } from '@/lib/drills';
import { notFound } from '@/lib/errors';
import { householdIdForGuardian } from '@/lib/households';
import { handle, json } from '@/lib/http';
import { currentPrincipals } from '@/lib/session';

/**
 * One drill's outcome, for the learner or their guardian.
 *
 * What comes back is a result, never a transcript. `toDrillView` in `lib/drills.ts` decides what
 * that means, and the S3 keys are not part of it.
 */

/**
 * Which member's history to look in. A learner reads their own and cannot ask about anyone else.
 * A guardian has to name the member, and `resolveMember` still checks the household, so naming
 * someone else's member id is a 404 rather than a 403: ids cannot be probed.
 */
function memberIdFor(principals: Principals, request: Request): string {
  if (principals.learner) return principals.learner.m;
  const asked = new URL(request.url).searchParams.get('memberId');
  if (principals.guardian && asked) return asked;
  throw notFound();
}

/**
 * The Cedar principal for whoever is asking. A guardian is identified by their Cognito subject
 * and their own household; a learner is the member row itself.
 */
function principalFor(principals: Principals, actor: Actor, member: Member): VPPrincipal {
  if (actor === 'guardian' && principals.guardian) {
    return buildGuardianPrincipal(principals.guardian.sub, householdIdForGuardian(principals.guardian.sub));
  }
  return buildLearnerPrincipal(member.memberId, member.householdId, member.status);
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle('drills.get', async () => {
    const { id } = await params;
    const principals = await currentPrincipals();
    const { member, actor } = await resolveMember(principals, memberIdFor(principals, request), ['learner', 'guardian']);
    const drill = await getDrill(member.memberId, id);
    if (!drill) throw notFound();
    // Policy, not a branch: a band is an outcome, and Verified Permissions says who may read it.
    await requireAuthz(
      principalFor(principals, actor, member),
      VP_ACTIONS.VIEW_BAND,
      buildDrillResource(drill.drillId, drill.householdId, drill.memberId, member.transcriptSharing),
    );
    // A drill that rang and was never answered becomes `missed` here, on the read that noticed.
    return json({ drill: toDrillView(await settleDrill(drill)) });
  });
}
