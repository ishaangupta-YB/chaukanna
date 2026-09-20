'use client';

import { useState } from 'react';
import { callApi } from '@/components/api';
import { t, type Lang } from '@/lib/i18n';

/**
 * The learner's own decision about who may read what they said (PRD F7 AC2). Off until they turn
 * it on, reversible in one tap, and never presented as a setting a family member should ask for.
 *
 * The switch is a plain button rather than a checkbox on purpose: a 48px target that says what it
 * will do, at arm's length, beats a tick box that says what it is.
 */
export function SharingToggle({ lang, memberId, sharing }: { lang: Lang; memberId: string; sharing: boolean }) {
  const [on, setOn] = useState(sharing);
  const [state, setState] = useState<'idle' | 'working' | 'error'>('idle');

  async function toggle() {
    const next = !on;
    setState('working');
    const res = await callApi(`/api/members/${memberId}/sharing`, 'POST', { transcriptSharing: next });
    if (res.ok) {
      setOn(next);
      setState('idle');
    } else {
      setState('error');
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-xl font-semibold text-stone-700">{t(lang, 'homeSharingLabel')}</h2>
      <p role="status" className="text-xl">
        {t(lang, on ? 'homeSharingOn' : 'homeSharingOff')}
      </p>
      <button
        type="button"
        onClick={toggle}
        aria-pressed={on}
        disabled={state === 'working'}
        className="min-h-14 w-full rounded-2xl border-2 border-stone-500 bg-white px-5 py-4 text-xl font-semibold disabled:opacity-60"
      >
        {t(lang, on ? 'homeSharingStop' : 'homeSharingAllow')}
      </button>
      {!on && <p className="text-xl text-stone-600">{t(lang, 'homeSharingHelp')}</p>}
      {state === 'error' && (
        <p role="alert" className="text-xl text-red-800">
          {t(lang, 'errorGeneric')}
        </p>
      )}
    </section>
  );
}
