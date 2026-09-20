import { resolveMember, type Principals } from '@/lib/access';
import { getDrill } from '@/lib/db';
import { toDrillView } from '@/lib/drills';
import { notFound } from '@/lib/errors';
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

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle('drills.get', async () => {
    const { id } = await params;
    const principals = await currentPrincipals();
    const { member } = await resolveMember(principals, memberIdFor(principals, request), ['learner', 'guardian']);
    const drill = await getDrill(member.memberId, id);
    if (!drill) throw notFound();
    return json({ drill: toDrillView(drill) });
  });
}
