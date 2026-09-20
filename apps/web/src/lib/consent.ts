import {
  CONSENT_CATEGORIES,
  getLatestConsent,
  putConsent,
  revokeConsent,
  type ConsentCategory,
  type ConsentMethod,
  type Language,
  type Member,
} from './db';
import { badRequest, conflict } from './errors';
import { log } from './log';
import { objectSize, presignPut } from './s3';

/**
 * Recorded consent. The learner speaks one sentence, the browser uploads it straight to S3 with
 * a presigned PUT, then posts the key here. The key embeds the timestamp that becomes the
 * consent row's sort key, which makes a repeated post of the same recording a no-op.
 */

export const CONSENT_AUDIO_TYPES = {
  'audio/webm': 'webm',
  'audio/mp4': 'mp4',
  'audio/ogg': 'ogg',
} as const;
export type ConsentAudioType = keyof typeof CONSENT_AUDIO_TYPES;

const MAX_CONSENT_AUDIO_BYTES = 2 * 1024 * 1024;
/** A presigned upload older than this is not accepted as consent. */
const MAX_UPLOAD_AGE_MS = 15 * 60 * 1000;

export function consentAudioKey(memberId: string, at: string, type: ConsentAudioType): string {
  return `consent/${memberId}/${at}.${CONSENT_AUDIO_TYPES[type]}`;
}

/** Parses a key produced by consentAudioKey for this member, or returns null. */
export function parseConsentAudioKey(memberId: string, key: string): { at: string } | null {
  const match = /^consent\/([a-f0-9]+)\/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\.(webm|mp4|ogg)$/.exec(key);
  if (!match || match[1] !== memberId) return null;
  return { at: match[2] };
}

export async function createConsentUpload(
  member: Member,
  type: ConsentAudioType,
): Promise<{ key: string; uploadUrl: string; contentType: ConsentAudioType }> {
  const key = consentAudioKey(member.memberId, new Date().toISOString(), type);
  const uploadUrl = await presignPut(key, type);
  return { key, uploadUrl, contentType: type };
}

export interface ConsentInput {
  method: ConsentMethod;
  language: Language;
  categories: ConsentCategory[];
  audioKey?: string;
}

export async function recordConsent(member: Member, input: ConsentInput): Promise<{ at: string; replay: boolean }> {
  const missing = CONSENT_CATEGORIES.filter((c) => !input.categories.includes(c));
  if (missing.length > 0) throw badRequest('all_categories_required');

  let at: string;
  if (input.method === 'voice') {
    if (!input.audioKey) throw badRequest('audio_key_required');
    const parsed = parseConsentAudioKey(member.memberId, input.audioKey);
    if (!parsed) throw badRequest('audio_key_invalid');
    const age = Date.now() - Date.parse(parsed.at);
    if (age < -60_000 || age > MAX_UPLOAD_AGE_MS) throw badRequest('audio_key_stale');
    const size = await objectSize(input.audioKey);
    if (size === null) throw conflict('audio_not_uploaded');
    if (size === 0 || size > MAX_CONSENT_AUDIO_BYTES) throw badRequest('audio_size_invalid');
    at = parsed.at;
  } else {
    if (input.audioKey) throw badRequest('audio_key_unexpected');
    at = new Date().toISOString();
  }

  const created = await putConsent({
    memberId: member.memberId,
    householdId: member.householdId,
    at,
    language: input.language,
    method: input.method,
    audioKey: input.audioKey,
    categories: CONSENT_CATEGORIES,
  });
  log.info(created ? 'consent.recorded' : 'consent.replayed', {
    householdId: member.householdId,
    memberId: member.memberId,
    method: input.method,
  });
  return { at, replay: !created };
}

export async function withdrawConsent(member: Member): Promise<void> {
  const latest = await getLatestConsent(member.memberId);
  if (!latest) throw conflict('no_consent');
  await revokeConsent(latest, new Date().toISOString());
  log.info('consent.revoked', { householdId: member.householdId, memberId: member.memberId });
}
