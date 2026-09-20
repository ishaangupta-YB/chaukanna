'use client';

import { useState } from 'react';
import { callApi } from '@/components/api';
import { t, type Lang } from '@/lib/i18n';

/**
 * The kill switch, on every learner screen. One tap, no confirmation dialog: stopping must be
 * easier than starting. On the invite screen the learner has no session yet, so the invite is
 * accepted first, which is what binds the pause to the right person.
 */
export function StopAllButton({ lang, memberId, token }: { lang: Lang; memberId?: string; token?: string }) {
  const [state, setState] = useState<'idle' | 'working' | 'done' | 'error'>('idle');

  async function stop() {
    setState('working');
    let id = memberId;
    if (!id && token) {
      const accepted = await callApi<{ memberId: string }>(`/api/invites/${token}/accept`, 'POST');
      id = accepted.data?.memberId;
    }
    const res = id ? await callApi(`/api/members/${id}/pause-all`, 'POST') : { ok: false };
    setState(res.ok ? 'done' : 'error');
  }

  if (state === 'done') {
    return (
      <p role="status" className="rounded-2xl border-2 border-red-800 bg-red-50 p-5 text-xl font-semibold text-red-900">
        {t(lang, 'stopAllConfirm')}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={stop}
        disabled={state === 'working'}
        className="min-h-14 w-full rounded-2xl border-2 border-red-800 bg-white px-5 py-4 text-xl font-semibold text-red-800 active:bg-red-50 disabled:opacity-60"
      >
        {state === 'working' ? t(lang, 'stopping') : t(lang, 'stopAll')}
      </button>
      {state === 'error' && (
        <p role="alert" className="text-xl text-red-800">
          {t(lang, 'errorGeneric')}
        </p>
      )}
    </div>
  );
}
