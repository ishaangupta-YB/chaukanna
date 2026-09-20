import Link from 'next/link';
import { redirect } from 'next/navigation';
import { guardianOrLogin } from '@/components/guardian/guardian-page';
import { InviteForm } from '@/components/guardian/InviteForm';
import { getGuardianHousehold } from '@/lib/households';

export const dynamic = 'force-dynamic';

export default async function InvitePage() {
  const guardian = await guardianOrLogin('/app/invite');
  const household = await getGuardianHousehold(guardian);
  if (!household) redirect('/app');
  return (
    <>
      <Link href="/app" className="text-stone-700 underline">
        Back to dashboard
      </Link>
      <h1 className="text-2xl font-bold">Invite a family member</h1>
      <p>They will open the link on their own phone, hear what practice calls are, and say yes in their own voice. Nothing happens without that.</p>
      <InviteForm householdId={household.householdId} />
    </>
  );
}
