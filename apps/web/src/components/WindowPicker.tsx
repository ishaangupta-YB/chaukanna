'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { callApi } from '@/components/api';
import { t, type Lang, type MessageKey } from '@/lib/i18n';

interface WindowValue {
  days: number[];
  start: string;
  end: string;
  tz: 'Asia/Kolkata';
}

const HOURS = Array.from({ length: 15 }, (_, i) => `${String(i + 7).padStart(2, '0')}:00`); // 07:00 .. 21:00

/** Weekly window picker shared by the learner (Hindi first) and the guardian. Times are IST. */
export function WindowPicker({
  memberId,
  initial,
  lang,
  doneHref,
}: {
  memberId: string;
  initial: WindowValue;
  lang: Lang;
  doneHref?: string;
}) {
  const router = useRouter();
  const [days, setDays] = useState<number[]>(initial.days);
  const [start, setStart] = useState(initial.start);
  const [end, setEnd] = useState(initial.end);
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'invalid' | 'error'>('idle');

  const hours = HOURS.includes(start) && HOURS.includes(end) ? HOURS : [...new Set([...HOURS, start, end])].sort();

  function toggle(day: number) {
    setState('idle');
    setDays((current) => (current.includes(day) ? current.filter((d) => d !== day) : [...current, day].sort()));
  }

  async function save() {
    if (days.length === 0 || end <= start || toMinutes(end) - toMinutes(start) < 60) {
      setState('invalid');
      return;
    }
    setState('saving');
    const res = await callApi(`/api/members/${memberId}/window`, 'PUT', { days, start, end, tz: 'Asia/Kolkata' });
    if (!res.ok) {
      setState(res.status === 400 ? 'invalid' : 'error');
      return;
    }
    setState('saved');
    if (doneHref) router.push(doneHref);
    else router.refresh();
  }

  return (
    <section className="flex flex-col gap-6">
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 font-semibold">{t(lang, 'windowDays')}</legend>
        <div className="grid grid-cols-4 gap-3 sm:grid-cols-7">
          {[1, 2, 3, 4, 5, 6, 7].map((day) => {
            const on = days.includes(day);
            return (
              <button
                key={day}
                type="button"
                aria-pressed={on}
                onClick={() => toggle(day)}
                className={`min-h-14 rounded-xl border-2 text-lg font-semibold ${
                  on ? 'border-emerald-800 bg-emerald-700 text-white' : 'border-stone-400 bg-white text-stone-800'
                }`}
              >
                {t(lang, `day${day}` as MessageKey)}
              </button>
            );
          })}
        </div>
      </fieldset>

      <div className="grid grid-cols-2 gap-4">
        <label className="flex flex-col gap-2 font-semibold">
          {t(lang, 'windowFrom')}
          <select
            value={start}
            onChange={(e) => {
              setStart(e.target.value);
              setState('idle');
            }}
            className="min-h-14 rounded-xl border-2 border-stone-500 bg-white px-3 text-xl"
          >
            {hours.map((h) => (
              <option key={h} value={h}>
                {h}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-2 font-semibold">
          {t(lang, 'windowTo')}
          <select
            value={end}
            onChange={(e) => {
              setEnd(e.target.value);
              setState('idle');
            }}
            className="min-h-14 rounded-xl border-2 border-stone-500 bg-white px-3 text-xl"
          >
            {hours.map((h) => (
              <option key={h} value={h}>
                {h}
              </option>
            ))}
          </select>
        </label>
      </div>

      <p className="text-lg text-stone-700">{t(lang, 'windowHelp')}</p>

      {state === 'invalid' && (
        <p role="alert" className="text-lg text-red-800">
          {t(lang, 'windowInvalid')}
        </p>
      )}
      {state === 'error' && (
        <p role="alert" className="text-lg text-red-800">
          {t(lang, 'errorGeneric')}
        </p>
      )}
      {state === 'saved' && (
        <p role="status" className="text-lg font-semibold text-emerald-800">
          {t(lang, 'windowSaved')}
        </p>
      )}

      <button
        type="button"
        onClick={save}
        disabled={state === 'saving'}
        className="min-h-16 rounded-2xl bg-emerald-700 px-6 py-4 text-2xl font-bold text-white disabled:opacity-60"
      >
        {t(lang, 'windowSave')}
      </button>
    </section>
  );
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}
