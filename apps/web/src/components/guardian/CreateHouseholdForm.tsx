'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { callApi } from '@/components/api';

export function CreateHouseholdForm() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [state, setState] = useState<'idle' | 'working' | 'error'>('idle');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState('working');
    const res = await callApi('/api/households', 'POST', { name });
    if (res.ok) router.refresh();
    else setState('error');
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4 rounded-2xl border border-stone-300 bg-white p-5">
      <h2 className="text-xl font-bold">Create your household</h2>
      <label className="flex flex-col gap-2 font-semibold">
        Household name
        <input
          required
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Sharma family"
          className="min-h-12 rounded-lg border border-stone-400 px-3 text-lg font-normal"
        />
      </label>
      {state === 'error' && <p role="alert" className="text-red-800">Could not create the household. Try again.</p>}
      <button disabled={state === 'working'} className="min-h-12 rounded-lg bg-emerald-700 px-5 font-semibold text-white disabled:opacity-60">
        Create household
      </button>
    </form>
  );
}
