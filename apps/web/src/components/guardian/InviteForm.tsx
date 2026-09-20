'use client';

import { useState } from 'react';
import { callApi } from '@/components/api';
import { InviteLinkCard } from './InviteLinkCard';

export function InviteForm({ householdId }: { householdId: string }) {
  const [displayName, setDisplayName] = useState('');
  const [language, setLanguage] = useState<'hi-IN' | 'en-IN'>('hi-IN');
  const [state, setState] = useState<'idle' | 'working' | 'error'>('idle');
  const [invite, setInvite] = useState<{ url: string; name: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState('working');
    const res = await callApi<{ memberId: string; inviteUrl: string }>(`/api/households/${householdId}/members`, 'POST', {
      displayName,
      language,
    });
    if (res.ok && res.data) {
      setInvite({ url: res.data.inviteUrl, name: displayName });
      setState('idle');
    } else setState('error');
  }

  if (invite) return <InviteLinkCard url={invite.url} name={invite.name} />;

  return (
    <form onSubmit={submit} className="flex flex-col gap-4 rounded-2xl border border-stone-300 bg-white p-5">
      <label className="flex flex-col gap-2 font-semibold">
        What do they like to be called?
        <input
          required
          maxLength={60}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="Maa, Papa, Dadi…"
          className="min-h-12 rounded-lg border border-stone-400 px-3 text-lg font-normal"
        />
      </label>
      <fieldset className="flex flex-col gap-2">
        <legend className="font-semibold">Language for their practice calls</legend>
        {(
          [
            ['hi-IN', 'Hindi (हिंदी)'],
            ['en-IN', 'Indian English'],
          ] as const
        ).map(([value, label]) => (
          <label key={value} className="flex min-h-12 items-center gap-3 text-lg">
            <input type="radio" name="language" value={value} checked={language === value} onChange={() => setLanguage(value)} className="h-5 w-5" />
            {label}
          </label>
        ))}
      </fieldset>
      {state === 'error' && <p role="alert" className="text-red-800">Could not create the invite. Try again.</p>}
      <button disabled={state === 'working'} className="min-h-12 rounded-lg bg-emerald-700 px-5 font-semibold text-white disabled:opacity-60">
        Create invite link
      </button>
    </form>
  );
}
