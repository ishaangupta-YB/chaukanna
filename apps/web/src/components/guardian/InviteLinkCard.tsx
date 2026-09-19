'use client';

import QRCode from 'qrcode';
import { useEffect, useState } from 'react';

/** Copyable invite link plus a QR code, so the learner can scan it from the guardian's screen. */
export function InviteLinkCard({ url, name }: { url: string; name: string }) {
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    QRCode.toDataURL(url, { margin: 1, width: 280, errorCorrectionLevel: 'M' })
      .then(setQr)
      .catch(() => setQr(null));
  }, [url]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="flex flex-col gap-4 rounded-2xl border-2 border-emerald-700 bg-white p-5">
      <p className="font-semibold">Send this link to {name}. It works once and expires in 72 hours.</p>
      <div className="flex gap-2">
        <input readOnly value={url} className="min-h-12 flex-1 rounded-lg border border-stone-400 px-3 font-mono text-sm" />
        <button type="button" onClick={copy} className="min-h-12 rounded-lg bg-stone-900 px-4 font-semibold text-white">
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {qr && (
        // eslint-disable-next-line @next/next/no-img-element -- a data URL generated in the browser, nothing to optimise
        <img src={qr} alt={`QR code for ${name}'s invite link`} width={280} height={280} className="self-center" />
      )}
      <p className="text-sm text-stone-600">Open it on their own phone. Do not open it yourself, that uses it up.</p>
    </div>
  );
}
