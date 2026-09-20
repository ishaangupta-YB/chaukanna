'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
// Types only. `lib/debrief.ts` reaches DynamoDB and S3, and a `import type` is erased, so the
// server's shapes can be shared with the browser without the SDK following them there.
import type { DebriefMark, DebriefView } from '@/lib/debrief';
import { DEBRIEF_RULE_KEYS, t, type Lang, type MessageKey } from '@/lib/i18n';

/**
 * The debrief screen.
 *
 * Four states, and the screen has to be kind in all four: still scoring, scored, scored with no
 * audio, and a pipeline that could not read the call. The last one shows the three rules and an
 * encouraging line and never a number — a guessed score would be worse than no score (PRD F5 AC5).
 *
 * Everything is on the screen in text as well as in sound. Plenty of learners will never turn
 * the volume on, and the phase file is explicit that the debrief cannot depend on audio.
 *
 * There is nothing to type into and nothing to submit here, in keeping with the rule that this
 * product never puts a collection surface in front of somebody who has just practised a scam
 * call. The helpline and the reporting site are written out as text, not as links.
 */

const POLL_MS = 3000;
/** PRD F5 AC4 promises a band within 60 seconds. Ninety is the point at which we stop waiting. */
const POLL_ATTEMPTS = 30;

const BAND_KEY: Record<NonNullable<DebriefView['band']>, MessageKey> = {
  safe: 'debriefBandSafe',
  wobbly: 'debriefBandWobbly',
  at_risk: 'debriefBandAtRisk',
};

const BAND_TONE: Record<NonNullable<DebriefView['band']>, string> = {
  safe: 'bg-emerald-100 text-emerald-900 border-emerald-700',
  wobbly: 'bg-amber-100 text-amber-900 border-amber-700',
  at_risk: 'bg-orange-100 text-orange-900 border-orange-700',
};

/** Rubric ids, from PRD section 9. An id we do not recognise still gets a kind sentence. */
const FLAG_KEY: Record<string, MessageKey> = {
  stayed_on_call: 'debriefFlagStayedOnCall',
  accepted_secrecy: 'debriefFlagAcceptedSecrecy',
  shared_identifier: 'debriefFlagSharedIdentifier',
  agreed_to_move_money: 'debriefFlagAgreedToMoveMoney',
  accepted_authority: 'debriefFlagAcceptedAuthority',
};

const CREDIT_KEY: Record<string, MessageKey> = {
  disconnected_early: 'debriefWentWellHangUp',
  independent_verify: 'debriefWentWellVerify',
  named_helpline: 'debriefWentWellHelpline',
};

/**
 * The one line on what they did well, which is always present. A credit the judge recognised is
 * better than the fallback, but the fallback is true of everyone who got this far.
 */
function wentWellKey(credits: DebriefMark[]): MessageKey {
  for (const credit of credits) {
    const key = CREDIT_KEY[credit.id];
    if (key) return key;
  }
  return 'debriefWentWellDefault';
}

const homeLink =
  'inline-flex min-h-16 items-center justify-center rounded-2xl bg-emerald-700 px-6 py-3 text-center text-2xl font-bold text-white';

export function Debrief({ lang, initial }: { lang: Lang; initial: DebriefView }) {
  const [view, setView] = useState(initial);
  const [gaveUp, setGaveUp] = useState(false);
  const [round, setRound] = useState(0);

  /** A failed poll is ignored: the next tick is three seconds away and the screen is unchanged. */
  const refresh = useCallback(async (): Promise<void> => {
    const response = await fetch(`/api/drills/${initial.drillId}/debrief`, { cache: 'no-store' });
    if (!response.ok) return;
    setView((await response.json()) as DebriefView);
  }, [initial.drillId]);

  useEffect(() => {
    if (view.status !== 'pending' || gaveUp) return;
    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      if (attempts > POLL_ATTEMPTS) {
        setGaveUp(true);
        return;
      }
      void refresh().catch(() => undefined);
    }, POLL_MS);
    return () => clearInterval(timer);
    // `round` changes when the learner asks us to look again, which restarts the wait.
  }, [view.status, gaveUp, refresh, round]);

  if (view.status === 'pending') {
    return (
      <section className="flex flex-col gap-6" aria-live="polite">
        <h1 className="text-3xl font-bold">{t(lang, 'debriefTitle')}</h1>
        <p className="rounded-2xl bg-stone-200 p-5 text-2xl font-semibold">
          {t(lang, gaveUp ? 'debriefSlow' : 'debriefWaiting')}
        </p>
        {!gaveUp && <p className="text-stone-700">{t(lang, 'debriefWaitingHint')}</p>}
        {gaveUp && (
          <button
            type="button"
            onClick={() => {
              setGaveUp(false);
              setRound((n) => n + 1);
              void refresh().catch(() => undefined);
            }}
            className="min-h-16 w-full rounded-2xl bg-emerald-700 px-6 py-3 text-2xl font-bold text-white"
          >
            {t(lang, 'debriefRetry')}
          </button>
        )}
        <Link href={`/me?lang=${lang}`} className={homeLink}>
          {t(lang, 'drillBackHome')}
        </Link>
      </section>
    );
  }

  const generic = view.status === 'score_failed';

  return (
    <section className="flex flex-col gap-6">
      <h1 className="text-3xl font-bold">{t(lang, 'debriefTitle')}</h1>

      {/* A band, worded as something that happened rather than as a mark out of ten. */}
      {view.band && (
        <p className={`self-start rounded-2xl border-2 px-5 py-3 text-2xl font-bold ${BAND_TONE[view.band]}`}>
          {t(lang, BAND_KEY[view.band])}
        </p>
      )}

      {view.audioUrl ? <PlayButton lang={lang} url={view.audioUrl} /> : null}

      {generic ? (
        <p className="rounded-2xl bg-stone-100 p-5 text-2xl">{t(lang, 'debriefGeneric')}</p>
      ) : (
        <>
          <section className="flex flex-col gap-2 rounded-2xl bg-emerald-50 p-5">
            <h2 className="text-xl font-semibold text-emerald-900">{t(lang, 'debriefWentWellLabel')}</h2>
            <p className="text-2xl text-emerald-900">{t(lang, wentWellKey(view.credits))}</p>
          </section>

          {!view.audioUrl && <p className="text-xl text-stone-600">{t(lang, 'debriefAudioMissing')}</p>}

          {view.debriefText && <p className="whitespace-pre-line text-2xl leading-relaxed">{view.debriefText}</p>}

          {view.turningPoint && (
            <section className="flex flex-col gap-3 rounded-2xl border-2 border-amber-700 bg-amber-50 p-5">
              <h2 className="text-xl font-semibold text-amber-900">{t(lang, 'debriefTurningPointLabel')}</h2>
              <blockquote className="text-2xl font-semibold text-amber-950">“{view.turningPoint}”</blockquote>
              <p className="text-xl text-amber-900">{t(lang, 'debriefTurningPointHint')}</p>
            </section>
          )}

          {view.flags.length > 0 && (
            <section className="flex flex-col gap-3">
              <h2 className="text-xl font-semibold text-stone-700">{t(lang, 'debriefNoticedLabel')}</h2>
              <ul className="flex flex-col gap-3">
                {view.flags.map((flag) => (
                  <li key={flag.id} className="rounded-2xl bg-stone-100 p-5">
                    <p className="text-xl font-semibold">{t(lang, FLAG_KEY[flag.id] ?? 'debriefFlagOther')}</p>
                    {flag.evidence && <p className="mt-2 text-xl text-stone-700">“{flag.evidence}”</p>}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      {/* Always last, always these three, always in this order (PRD F6 AC3). */}
      <section className="flex flex-col gap-3 rounded-2xl border-2 border-stone-400 p-5">
        <h2 className="text-xl font-bold">{t(lang, 'debriefRulesTitle')}</h2>
        <ol className="flex list-decimal flex-col gap-3 pl-6 text-2xl">
          {DEBRIEF_RULE_KEYS.map((key) => (
            <li key={key}>{t(lang, key)}</li>
          ))}
        </ol>
      </section>

      <Link href={`/me?lang=${lang}`} className={homeLink}>
        {t(lang, 'drillBackHome')}
      </Link>
    </section>
  );
}

/**
 * One big button for the spoken debrief. Not the browser's own audio control: its buttons are
 * roughly a fingertip wide, and this screen is read by people who find those hard to hit.
 */
function PlayButton({ lang, url }: { lang: Lang; url: string }) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [broken, setBroken] = useState(false);

  if (broken) return <p className="text-xl text-stone-600">{t(lang, 'debriefAudioMissing')}</p>;

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => {
          const element = audio.current;
          if (!element) return;
          if (element.paused) void element.play().catch(() => setBroken(true));
          else element.pause();
        }}
        className="min-h-20 w-full rounded-2xl bg-emerald-700 px-6 py-5 text-3xl font-bold text-white active:bg-emerald-800"
      >
        {t(lang, playing ? 'debriefPause' : 'debriefListen')}
      </button>
      <audio
        ref={audio}
        src={url}
        preload="none"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onError={() => setBroken(true)}
      />
    </div>
  );
}
