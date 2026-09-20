'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { callApi } from '@/components/api';
import { InviteLinkCard } from './InviteLinkCard';

/**
 * Why a refusal is shown in full: every reason is a fact the guardian already knows or can see on
 * this page, and "nothing happened" would send them looking for a bug instead of at the window.
 */
const REFUSAL: Record<string, string> = {
  not_consented: 'They have not given consent yet, or have withdrawn it.',
  paused: 'Practice calls are stopped for them.',
  outside_window: 'It is outside the hours they chose. Change the hours, or wait.',
  weekly_cap: 'They have already had a practice call in the last seven days.',
  ring_too_soon: 'You rang them a few minutes ago. Give it ten minutes.',
};

/** New invite link, schedule, ring now, and the guardian's own kill switch for one member. */
export function MemberActions({
  memberId,
  name,
  canPause,
  canRing,
  canSchedule,
}: {
  memberId: string;
  name: string;
  canPause: boolean;
  canRing: boolean;
  canSchedule: boolean;
}) {
  const router = useRouter();
  const [link, setLink] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'working' | 'error'>('idle');

  /**
   * The two ways a drill comes into existence.
   *
   * `schedule` is the real one (PRD F3 AC2): it picks a random moment inside the learner's window
   * and the call arrives on its own. `now` is the demo control (PRD F3 AC4) and rings immediately.
   * Neither starts a call: the learner still has to open their own page and tap answer, and every
   * rule is checked again when they do.
   */
  async function createDrill(body: { now: true } | { schedule: true }) {
    setState('working');
    setRefusal(null);
    const res = await callApi<{ drillId: string; error?: string }>(`/api/members/${memberId}/drills`, 'POST', body);
    if (res.ok) {
      setState('idle');
      router.refresh();
      return;
    }
    const code = res.data?.error ?? '';
    setRefusal(REFUSAL[code] ?? null);
    setState(REFUSAL[code] ? 'idle' : 'error');
  }

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
        {canSchedule && (
          <button type="button" onClick={() => createDrill({ schedule: true })} disabled={state === 'working'} className="min-h-11 rounded-lg border border-emerald-700 bg-emerald-700 px-4 font-semibold text-white">
            Schedule a practice call
          </button>
        )}
        {canRing && (
          <button type="button" onClick={() => createDrill({ now: true })} disabled={state === 'working'} className="min-h-11 rounded-lg border border-emerald-700 px-4 font-semibold text-emerald-800">
            Ring now
          </button>
        )}
        {canPause && (
          <button type="button" onClick={pause} disabled={state === 'working'} className="min-h-11 rounded-lg border border-red-700 px-4 font-semibold text-red-800">
            Stop all practice calls
          </button>
        )}
      </div>
      {refusal && <p role="status" className="text-stone-700">{refusal}</p>}
      {state === 'error' && <p role="alert" className="text-red-800">That did not work. Try again.</p>}
      {link && <InviteLinkCard url={link} name={name} />}
    </div>
  );
}
