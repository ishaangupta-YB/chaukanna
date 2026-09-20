import { z } from 'zod';
import { resolveMember } from '@/lib/access';
import { config } from '@/lib/config';
import { DrillNotAllowed, ringNow } from '@/lib/drills';
import { AppError } from '@/lib/errors';
import { assertSameOrigin, handle, json, parseBody } from '@/lib/http';
import { currentPrincipals } from '@/lib/session';

/**
 * Creates a drill. Phase 3 supports `{ now: true }` only, the guardian's demo control from PRD
 * F3 AC4; Phase 4 adds the scheduled path, which writes the same row from an EventBridge target.
 *
 * Every rule lives in `lib/drills.ts` and runs here, on the server. A refusal says which rule
 * refused so the screen can explain it, and each reason is a state the caller can already see for
 * themselves, so it gives nothing away.
 */

const Body = z.object({ now: z.literal(true) });

const STATUS: Record<string, number> = {
  not_consented: 409,
  paused: 409,
  outside_window: 409,
  weekly_cap: 409,
  not_ready: 409,
};

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle('drills.create', async () => {
    assertSameOrigin(request, config.appUrl(new URL(request.url).origin));
    const { id } = await params;
    // Ring-now is the guardian's control, so a learner cannot summon their own practice call.
    const { member, actor } = await resolveMember(await currentPrincipals(), id, ['guardian']);
    await parseBody(request, Body);
    try {
      const drill = await ringNow(member, actor);
      return json({ drillId: drill.drillId, state: drill.state, scheduledAt: drill.scheduledAt }, 201);
    } catch (error) {
      if (error instanceof DrillNotAllowed) {
        throw new AppError(STATUS[error.refusal] ?? 409, error.refusal);
      }
      throw error;
    }
  });
}
