import { handle, json } from '@/lib/http';
import { readInvite } from '@/lib/invites';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  return handle('invites.read', async () => {
    const { token } = await params;
    const view = await readInvite(token);
    return json(view, view.state === 'invalid' ? 410 : 200);
  });
}
