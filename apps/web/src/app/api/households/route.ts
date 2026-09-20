import { z } from 'zod';
import { config } from '@/lib/config';
import { createHousehold } from '@/lib/households';
import { assertSameOrigin, handle, json, parseBody } from '@/lib/http';
import { requireGuardian } from '@/lib/session';

const Body = z.object({ name: z.string().trim().min(1).max(80) });

export async function POST(request: Request) {
  return handle('households.create', async () => {
    assertSameOrigin(request, config.appUrl(new URL(request.url).origin));
    const guardian = await requireGuardian();
    const { name } = await parseBody(request, Body);
    const { household, created } = await createHousehold(guardian, name);
    return json({ householdId: household.householdId, created }, created ? 201 : 200);
  });
}
