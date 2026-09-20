'use client';

import Link from 'next/link';
import { t, type Lang, type MessageKey } from '@/lib/i18n';
import { useDrillSocket } from './useDrillSocket';

/**
 * The call screen: ringing, in the call, ended.
 *
 * It never pretends to be a real phone. The realism belongs to the conversation; the screen says
 * "practice" the whole way through and keeps the way out as the largest thing on it. Every state
 * has one obvious action and nothing to type into, because a drill has no collection surface of
 * any kind (PRD section 8.3).
 */

const REFUSAL_KEY: Record<string, MessageKey> = {
  microphone_denied: 'drillErrorMic',
  audio_unavailable: 'drillErrorAudio',
  connection_lost: 'drillErrorConnection',
  not_ready: 'drillErrorNotReady',
  drill_unavailable: 'drillErrorNotReady',
  outside_window: 'drillErrorOutsideWindow',
  weekly_cap: 'drillErrorWeeklyCap',
  not_consented: 'drillErrorNotConsented',
  paused: 'drillErrorNotConsented',
  drill_not_ready: 'drillErrorNotReady',
};

const ENDING_KEY: Record<string, MessageKey> = {
  hangup: 'drillEndedHangup',
  declined: 'drillEndedDeclined',
  safe_word: 'drillEndedStopped',
  tripwire: 'drillEndedStopped',
  is_this_real: 'drillEndedStopped',
  distress: 'drillEndedStopped',
};

function minutesAndSeconds(total: number): string {
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}

export function DrillCall({ drillId, lang }: { drillId: string; lang: Lang }) {
  const { state, answer, hangUp, decline } = useDrillSocket(drillId);

  if (state.phase === 'ended') {
    const key = state.endReason ? ENDING_KEY[state.endReason] : undefined;
    return (
      <section className="flex flex-col gap-6" aria-live="polite">
        <h1 className="text-3xl font-bold">{t(lang, 'drillEndedTitle')}</h1>
        {key && <p className="rounded-2xl bg-emerald-100 p-5 text-2xl font-semibold text-emerald-900">{t(lang, key)}</p>}
        <p className="text-stone-700">{t(lang, 'drillEndedBody')}</p>
        <Link
          href={`/me?lang=${lang}`}
          className="inline-flex min-h-16 items-center justify-center rounded-2xl bg-emerald-700 px-6 py-3 text-center text-2xl font-bold text-white"
        >
          {t(lang, 'drillBackHome')}
        </Link>
      </section>
    );
  }

  if (state.phase === 'failed') {
    const key = state.errorCode ? REFUSAL_KEY[state.errorCode] : undefined;
    return (
      <section className="flex flex-col gap-6" aria-live="assertive">
        <h1 className="text-3xl font-bold">{t(lang, 'drillEndedTitle')}</h1>
        <p role="alert" className="rounded-2xl bg-stone-200 p-5 text-2xl font-semibold text-stone-900">
          {t(lang, key ?? 'errorGeneric')}
        </p>
        <Link
          href={`/me?lang=${lang}`}
          className="inline-flex min-h-16 items-center justify-center rounded-2xl bg-emerald-700 px-6 py-3 text-center text-2xl font-bold text-white"
        >
          {t(lang, 'drillBackHome')}
        </Link>
      </section>
    );
  }

  if (state.phase === 'in_call') {
    return (
      <section className="flex flex-1 flex-col gap-6">
        <h1 className="text-3xl font-bold">{t(lang, 'drillInCall')}</h1>
        <p className="text-2xl">
          <span className="text-stone-700">{t(lang, 'drillTimeLeft')}: </span>
          <strong aria-live="off">{minutesAndSeconds(state.secondsLeft ?? 0)}</strong>
        </p>
        {state.safeWord && (
          <p className="rounded-2xl border-2 border-emerald-700 bg-emerald-50 p-5 text-xl font-semibold text-emerald-900">
            {t(lang, 'drillSafeWordHint', { word: state.safeWord })}
          </p>
        )}
        {/* The learner's own words, on the learner's own device, for the length of the call. */}
        <div className="min-h-24 rounded-2xl bg-stone-100 p-5">
          <p className="text-lg text-stone-600">{t(lang, 'drillYouSaid')}</p>
          <p aria-live="polite" className="text-2xl">
            {state.caption}
          </p>
        </div>
        <button
          type="button"
          onClick={hangUp}
          className="mt-auto min-h-20 w-full rounded-2xl bg-red-700 px-6 py-5 text-3xl font-bold text-white active:bg-red-800"
        >
          {t(lang, 'drillEnd')}
        </button>
      </section>
    );
  }

  const connecting = state.phase === 'connecting';
  return (
    <section className="flex flex-1 flex-col gap-6">
      <h1 className="text-3xl font-bold">{t(lang, 'drillRingingTitle')}</h1>
      <p className="text-2xl text-stone-700">{t(lang, 'drillRingingCaller')}</p>
      <p className="text-lg text-stone-600">{t(lang, 'drillHeadphones')}</p>
      <div className="mt-auto flex flex-col gap-3">
        <button
          type="button"
          onClick={() => void answer()}
          disabled={connecting}
          className="min-h-20 w-full rounded-2xl bg-emerald-700 px-6 py-5 text-3xl font-bold text-white active:bg-emerald-800 disabled:opacity-70"
        >
          {connecting ? t(lang, 'drillConnecting') : t(lang, 'drillAnswer')}
        </button>
        <button
          type="button"
          onClick={decline}
          disabled={connecting}
          className="min-h-14 w-full rounded-2xl border-2 border-stone-500 px-5 py-3 text-xl font-semibold disabled:opacity-70"
        >
          {t(lang, 'drillDecline')}
        </button>
      </div>
    </section>
  );
}
