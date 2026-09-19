import Link from 'next/link';
import { notFound } from 'next/navigation';
import { guardianOrLogin } from '@/components/guardian/guardian-page';
import { WindowPicker } from '@/components/WindowPicker';
import { getMember } from '@/lib/db';
import { householdIdForGuardian } from '@/lib/households';
import { windowOrDefault } from '@/lib/members';

export const dynamic = 'force-dynamic';

export default async function MemberWindowPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const guardian = await guardianOrLogin(`/app/members/${id}/window`);
  const member = /^[a-f0-9]{8,64}$/.test(id) ? await getMember(householdIdForGuardian(guardian.sub), id) : null;
  if (!member) notFound();
  const { window } = await windowOrDefault(member.memberId);
  return (
    <>
      <Link href="/app" className="text-stone-700 underline">
        Back to dashboard
      </Link>
      <h1 className="text-2xl font-bold">When can {member.displayName} get a practice call?</h1>
      <p>Times are India Standard Time. One call at most per week, at a random moment inside this window.</p>
      <WindowPicker memberId={member.memberId} initial={window} lang="en" doneHref="/app" />
    </>
  );
}
