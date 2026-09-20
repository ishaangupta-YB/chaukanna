import { resolveMember } from '@/lib/access';
import { agentSessionId, presignAgentSocket } from '@/lib/agentcore';
import { buildDrillResource, buildLearnerPrincipal, requireAuthz, VP_ACTIONS } from '@/lib/authz';
import { config } from '@/lib/config';
import { getDrill } from '@/lib/db';
import { drillSessionClaims, signDrillSessionToken } from '@/lib/drill-session';
import { DrillNotAllowed, claimDrillForSession, guardDrillStart } from '@/lib/drills';
import { AppError, notFound } from '@/lib/errors';
import { assertSameOrigin, handle, json } from '@/lib/http';
import { log } from '@/lib/log';
import { getInviteSigningKey } from '@/lib/secrets';
import { currentPrincipals, requireLearner } from '@/lib/session';
import { randomId } from '@/lib/signing';

/**
 * Everything the browser needs to take the call, and nothing it could have decided for itself.
 *
 * The four checks Phase 3 requires, all server side: the member is consented and not paused, the
 * drill is theirs and is due, the weekly cap is clear, and the moment is inside the window the
 * learner chose. Only then are two short lived things minted, each useless without the other:
 *
 * - `wsUrl`, a SigV4 presigned AgentCore URL, because a browser cannot sign a handshake
 * - `token`, the drill session token, sent as the first frame and claimed once by the agent
 *
 * The drill is looked up inside the caller's own member row, so an id belonging to another
 * household is a 404 and never a 403: ids cannot be probed.
 *
 * Taking the call is itself an authorized act. `TakeDrill` is permitted only to the member the
 * drill was created for, so the policy — not the lookup — is what stands between a learner
 * session and somebody else's practice call.
 */

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle('drills.session', async () => {
    assertSameOrigin(request, config.appUrl(new URL(request.url).origin));
    const learner = await requireLearner();
    const { member } = await resolveMember(await currentPrincipals(), learner.m, ['learner']);

    const { id } = await params;
    const drill = await getDrill(member.memberId, id);
    if (!drill) throw notFound();

    await requireAuthz(
      buildLearnerPrincipal(member.memberId, member.householdId, member.status),
      VP_ACTIONS.TAKE_DRILL,
      buildDrillResource(drill.drillId, drill.householdId, drill.memberId, member.transcriptSharing),
    );

    try {
      await guardDrillStart(member, drill, new Date());
    } catch (error) {
      if (error instanceof DrillNotAllowed) throw new AppError(409, error.refusal);
      throw error;
    }

    const now = new Date();
    const socket = await presignAgentSocket(agentSessionId(drill.drillId, randomId(8)), undefined, now);
    const jti = await claimDrillForSession(drill, Math.floor(Date.parse(socket.expiresAt) / 1000));
    const token = signDrillSessionToken(
      await getInviteSigningKey(),
      drillSessionClaims(drill, jti, Math.floor(now.getTime() / 1000)),
    );

    log.info('drill.session_minted', {
      householdId: member.householdId,
      memberId: member.memberId,
      drillId: drill.drillId,
    });
    return json({
      drillId: drill.drillId,
      wsUrl: socket.wsUrl,
      token,
      expiresAt: socket.expiresAt,
      maxSeconds: drill.maxSeconds,
      language: drill.language,
    });
  });
}
