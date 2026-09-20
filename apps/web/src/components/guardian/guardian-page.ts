import { redirect } from 'next/navigation';
import type { Guardian } from '@/lib/auth';
import { currentGuardian } from '@/lib/session';

/** Server component guard: a signed-out guardian goes to managed login and comes back here. */
export async function guardianOrLogin(returnTo: string): Promise<Guardian> {
  const guardian = await currentGuardian();
  if (!guardian) redirect(`/api/auth/login?next=${encodeURIComponent(returnTo)}`);
  return guardian;
}
