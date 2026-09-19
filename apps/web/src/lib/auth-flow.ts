import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { exchangeCode, safeNextPath, verifyGuardianToken } from './auth';
import { log } from './log';
import { nowSeconds } from './signing';

const OAuthState = z.object({ s: z.string().min(16), v: z.string().min(43), n: z.string() });

/** Seconds of cookie life kept below the ID token expiry, so a stale cookie is never sent. */
const COOKIE_EXPIRY_MARGIN_SECONDS = 60;

/**
 * Finishes the authorization code flow: checks state against the PKCE cookie, exchanges the
 * code, and verifies the ID token before it is ever stored. Throws on any mismatch.
 */
export async function completeLogin(
  appUrl: string,
  query: URLSearchParams,
  stateCookie: string | undefined,
): Promise<{ idToken: string; maxAge: number; next: string }> {
  const code = query.get('code');
  const state = query.get('state');
  if (!code || !state || !stateCookie) throw new Error('missing code, state or state cookie');

  const saved = OAuthState.parse(JSON.parse(Buffer.from(stateCookie, 'base64url').toString('utf8')));
  const a = Buffer.from(state);
  const b = Buffer.from(saved.s);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('state mismatch');

  const { idToken } = await exchangeCode(appUrl, code, saved.v);
  const guardian = await verifyGuardianToken(idToken);
  if (!guardian) throw new Error('id token failed verification');

  const exp = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8')).exp as number;
  const maxAge = Math.max(60, exp - nowSeconds() - COOKIE_EXPIRY_MARGIN_SECONDS);
  log.info('auth.guardian_signed_in');
  return { idToken, maxAge, next: safeNextPath(saved.n) };
}
