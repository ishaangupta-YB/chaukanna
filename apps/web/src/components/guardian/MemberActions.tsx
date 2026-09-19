'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { callApi } from '@/components/api';
import { InviteLinkCard } from './InviteLinkCard';

/** New invite link and the guardian's own kill switch for one member. */
export function MemberActions({ memberId, name, canPause }: { memberId: string; name: string; canPause: boolean }) {
  const router = useRouter();
  const [link, setLink] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'working' | 'error'>('idle');

  async function reinvite() {
    setState('working');
    const res = await callApi<{ inviteUrl: string }>(`/api/members/${memberId}/invite`, 'POST');
    if (res.ok && res.data) {
      setLink(res.data.inviteUrl);
      setState('idle');
    } else setState('error');
  }

  async function pause() {
    setState('working');
    const res = await callApi(`/api/members/${memberId}/pause-all`, 'POST');
    if (res.ok) {
      setState('idle');
      router.refresh();
    } else setState('error');
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={reinvite} disabled={state === 'working'} className="min-h-11 rounded-lg border border-stone-400 px-4 font-semibold">
          New invite link
        </button>
        {canPause && (
          <button type="button" onClick={pause} disabled={state === 'working'} className="min-h-11 rounded-lg border border-red-700 px-4 font-semibold text-red-800">
            Stop all practice calls
          </button>
        )}
      </div>
      {state === 'error' && <p role="alert" className="text-red-800">That did not work. Try again.</p>}
      {link && <InviteLinkCard url={link} name={name} />}
    </div>
  );
}
