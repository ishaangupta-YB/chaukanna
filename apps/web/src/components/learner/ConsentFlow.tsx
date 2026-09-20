'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { callApi } from '@/components/api';
import { localeFromLang, t, TYPED_YES, type Lang } from '@/lib/i18n';

const RECORD_SECONDS = 4;
/** An ignored permission prompt must not strand the learner: fall back to typing after this. */
const MIC_PROMPT_TIMEOUT_MS = 12_000;
const CATEGORIES = ['practice_calls', 'call_audio_7_days', 'outcome_to_family'] as const;
/** Upload types the server accepts, in order of preference. Safari only produces audio/mp4. */
const RECORDER_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg'];

type Step = 'intro' | 'mic' | 'recording' | 'saving' | 'typed' | 'error';

function pickRecorderType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  return RECORDER_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) ?? null;
}

/** Resolves to a live stream, or null on denial, missing support, or an unanswered prompt. */
async function requestMic(): Promise<MediaStream | null> {
  if (!navigator.mediaDevices?.getUserMedia) return null;
  const request = navigator.mediaDevices.getUserMedia({ audio: true });
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), MIC_PROMPT_TIMEOUT_MS));
  const stream = await Promise.race([request.catch(() => null), timeout]);
  if (!stream) {
    // A late grant after the timeout must not leave the microphone open.
    request.then((late) => late.getTracks().forEach((track) => track.stop())).catch(() => undefined);
  }
  return stream;
}

function record(stream: MediaStream, mimeType: string, onTick: (left: number) => void): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const chunks: Blob[] = [];
    const recorder = new MediaRecorder(stream, { mimeType });
    recorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
    recorder.onerror = () => reject(new Error('recorder error'));
    recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType.split(';')[0] }));
    recorder.start();
    let left = RECORD_SECONDS;
    onTick(left);
    const timer = setInterval(() => {
      left -= 1;
      onTick(left);
      if (left <= 0) {
        clearInterval(timer);
        recorder.stop();
      }
    }, 1000);
  });
}

/**
 * One screen, one primary button. Mode "invite" accepts the signed link first; mode "resume" is
 * a learner who already has a session and is turning practice back on.
 */
export function ConsentFlow({ lang, token, memberId }: { lang: Lang; token?: string; memberId?: string }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>('intro');
  const [secondsLeft, setSecondsLeft] = useState(RECORD_SECONDS);
  const [typed, setTyped] = useState('');
  const [typedInvalid, setTypedInvalid] = useState(false);

  async function ensureMember(): Promise<string | null> {
    if (!token) return memberId ?? null;
    const res = await callApi<{ memberId: string }>(`/api/invites/${token}/accept`, 'POST');
    return res.ok && res.data ? res.data.memberId : null;
  }

  async function submitConsent(id: string, method: 'voice' | 'typed', audioKey?: string): Promise<boolean> {
    const res = await callApi(`/api/members/${id}/consent`, 'POST', {
      method,
      language: localeFromLang(lang),
      categories: CATEGORIES,
      audioKey,
    });
    return res.ok;
  }

  function finish() {
    router.push(`/me/window?first=1&lang=${lang}`);
  }

  async function startVoice() {
    const recorderType = pickRecorderType();
    setStep('mic');
    const stream = recorderType ? await requestMic() : null;
    if (!stream || !recorderType) {
      setStep('typed');
      return;
    }

    setStep('recording');
    const memberPromise = ensureMember();
    try {
      const blob = await record(stream, recorderType, setSecondsLeft);
      stream.getTracks().forEach((track) => track.stop());
      setStep('saving');
      const id = await memberPromise;
      if (!id || blob.size === 0) throw new Error('no member or empty recording');

      const upload = await callApi<{ key: string; uploadUrl: string; contentType: string }>(
        `/api/members/${id}/consent/upload-url`,
        'POST',
        { contentType: blob.type },
      );
      if (!upload.ok || !upload.data) throw new Error('upload url failed');
      const put = await fetch(upload.data.uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': upload.data.contentType },
        body: blob,
      });
      if (!put.ok) throw new Error('upload failed');
      if (!(await submitConsent(id, 'voice', upload.data.key))) throw new Error('consent failed');
      finish();
    } catch {
      stream.getTracks().forEach((track) => track.stop());
      setStep('error');
    }
  }

  async function confirmTyped() {
    if (!TYPED_YES.has(typed.trim().toLowerCase())) {
      setTypedInvalid(true);
      return;
    }
    setStep('saving');
    const id = await ensureMember();
    if (id && (await submitConsent(id, 'typed'))) finish();
    else setStep('error');
  }

  return (
    <section className="flex flex-col gap-6">
      <div className="rounded-2xl border-2 border-amber-300 bg-amber-50 p-5">
        <p className="text-xl text-stone-700">{t(lang, 'consentSayThis')}</p>
        <p className="mt-2 text-2xl font-bold">&ldquo;{t(lang, 'consentSentence')}&rdquo;</p>
      </div>

      {step === 'intro' && (
        <button
          type="button"
          onClick={startVoice}
          className="min-h-16 w-full rounded-2xl bg-emerald-700 px-6 py-5 text-2xl font-bold text-white shadow active:bg-emerald-800"
        >
          {t(lang, 'consentPrimary')}
        </button>
      )}

      {step === 'mic' && (
        <p role="status" aria-live="polite" className="rounded-2xl bg-stone-200 px-6 py-5 text-center text-xl font-semibold">
          {t(lang, 'consentMicAsk')}
        </p>
      )}

      {step === 'recording' && (
        <p role="status" aria-live="assertive" className="rounded-2xl bg-emerald-700 px-6 py-5 text-center text-2xl font-bold text-white">
          {t(lang, 'consentRecording', { seconds: secondsLeft })}
        </p>
      )}

      {step === 'saving' && (
        <p role="status" className="rounded-2xl bg-stone-200 px-6 py-5 text-center text-2xl font-semibold">
          {t(lang, 'consentSaving')}
        </p>
      )}

      {step === 'typed' && (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void confirmTyped();
          }}
        >
          <p className="text-xl">{t(lang, 'consentMicDenied')}</p>
          <label className="flex flex-col gap-2 text-xl font-semibold">
            {t(lang, 'consentTypedLabel')}
            <input
              value={typed}
              onChange={(e) => {
                setTyped(e.target.value);
                setTypedInvalid(false);
              }}
              autoComplete="off"
              className="min-h-14 rounded-xl border-2 border-stone-500 px-4 text-2xl"
            />
          </label>
          {typedInvalid && (
            <p role="alert" className="text-xl text-red-800">
              {t(lang, 'consentTypedInvalid')}
            </p>
          )}
          <button type="submit" className="min-h-16 rounded-2xl bg-emerald-700 px-6 py-4 text-2xl font-bold text-white">
            {t(lang, 'consentTypedConfirm')}
          </button>
        </form>
      )}

      {step === 'error' && (
        <div className="flex flex-col gap-4">
          <p role="alert" className="text-xl text-red-800">
            {t(lang, 'errorGeneric')}
          </p>
          <button
            type="button"
            onClick={() => setStep('intro')}
            className="min-h-16 rounded-2xl bg-emerald-700 px-6 py-4 text-2xl font-bold text-white"
          >
            {t(lang, 'consentPrimary')}
          </button>
        </div>
      )}
    </section>
  );
}
