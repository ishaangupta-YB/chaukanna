import { z } from 'zod';
import { deriveKey, nowSeconds, sha256Hex, sign, verify } from './signing';

/**
 * Learner invite tokens.
 * token   = base64url(payload) + "." + base64url(hmacSHA256(payload, key))
 * payload = { m: memberId, h: householdId, exp: epochSeconds }
 * sha256(token) is stored on the member row as inviteHash. Accepting clears it, so the token
 * is single use; see lib/invites.ts for the double tap grace window.
 */

export const INVITE_TTL_SECONDS = 72 * 60 * 60;

const InvitePayload = z.object({
  m: z.string().min(1).max(64),
  h: z.string().min(1).max(64),
  exp: z.number().int().positive(),
});
export type InvitePayload = z.infer<typeof InvitePayload>;

export interface IssuedInvite {
  token: string;
  tokenHash: string;
  expiresAt: number;
}

export function issueInvite(
  masterKey: string,
  memberId: string,
  householdId: string,
  now = nowSeconds(),
): IssuedInvite {
  const expiresAt = now + INVITE_TTL_SECONDS;
  const token = sign({ m: memberId, h: householdId, exp: expiresAt }, deriveKey(masterKey, 'invite'));
  return { token, tokenHash: hashInvite(token), expiresAt };
}

export type InviteCheck =
  | { ok: true; payload: InvitePayload; tokenHash: string }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' };

/** Verifies signature and expiry only. The single use check needs the member row. */
export function checkInvite(masterKey: string, token: string, now = nowSeconds()): InviteCheck {
  if (token.length > 512) return { ok: false, reason: 'malformed' };
  const raw = verify(token, deriveKey(masterKey, 'invite'));
  if (raw === null) return { ok: false, reason: 'bad_signature' };
  const parsed = InvitePayload.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'malformed' };
  if (parsed.data.exp <= now) return { ok: false, reason: 'expired' };
  return { ok: true, payload: parsed.data, tokenHash: hashInvite(token) };
}

export function hashInvite(token: string): string {
  return sha256Hex(token);
}
