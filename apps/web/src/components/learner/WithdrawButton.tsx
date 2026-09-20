'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { callApi } from '@/components/api';
import { t, type Lang } from '@/lib/i18n';

/** Revokes consent (DELETE /api/members/[id]/consent). Phase 4 makes this cancel schedules too. */
export function WithdrawButton({ lang, memberId }: { lang: Lang; memberId: string }) {
  const router = useRouter();
  const [state, setState] = useState<'idle' | 'working' | 'error'>('idle');

  async function withdraw() {
    setState('working');
    const res = await callApi(`/api/members/${memberId}/consent`, 'DELETE');
    if (res.ok) router.refresh();
    else setState('error');
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={withdraw}
        disabled={state === 'working'}
        className="min-h-14 w-full rounded-2xl border-2 border-stone-500 bg-white px-5 py-4 text-xl font-semibold disabled:opacity-60"
      >
        {t(lang, 'homeWithdraw')}
      </button>
      {state === 'error' && (
        <p role="alert" className="text-lg text-red-800">
          {t(lang, 'errorGeneric')}
        </p>
      )}
    </div>
  );
}
