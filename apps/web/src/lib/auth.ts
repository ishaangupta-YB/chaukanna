import { createHash, createPublicKey, randomBytes, verify as cryptoVerify, type JsonWebKey, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import { config } from './config';
import { nowSeconds } from './signing';

/**
 * Guardian authentication against the Cognito user pool. Tokens are verified here with
 * node:crypto against the pool JWKS. No auth library, by design (CLAUDE.md).
 */

export const GUARDIAN_COOKIE = 'ck_guardian';
export const OAUTH_COOKIE = 'ck_oauth';
const CLOCK_SKEW_SECONDS = 60;
/** Minimum interval between JWKS fetches (5 minutes). Also used for proactive refresh interval. */
const JWKS_REFRESH_MIN_INTERVAL_MS = 5 * 60 * 1000;

export interface Guardian {
  sub: string;
  email: string | null;
  /**
   * True only for a judge demo session (see lib/demo.ts), which is an authentication bypass and
   * not a real account. Required rather than optional on purpose: every place that builds a
   * guardian has to say which kind it is, so a demo one can never be mistaken for a signed-in
   * person by omission.
   */
  demo: boolean;
}

const Header = z.object({ alg: z.literal('RS256'), kid: z.string().min(1) });
const IdClaims = z.object({
  sub: z.string().min(1),
  iss: z.string(),
  aud: z.string(),
  token_use: z.literal('id'),
  exp: z.number(),
  iat: z.number(),
  email: z.string().optional(),
});

export type KeyResolver = (kid: string) => Promise<KeyObject | null>;

export interface VerifyOptions {
  issuer: string;
  audience: string;
  resolveKey: KeyResolver;
  now?: number;
}

/** Returns the guardian on a valid Cognito ID token, otherwise null. Never throws on bad input. */
export async function verifyIdToken(token: string, opts: VerifyOptions): Promise<Guardian | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;

  const header = Header.safeParse(decodeJson(headerB64));
  if (!header.success) return null;

  const key = await opts.resolveKey(header.data.kid);
  if (!key) return null;

  const signedData = Buffer.from(`${headerB64}.${payloadB64}`);
  const signature = Buffer.from(sigB64, 'base64url');
  if (!cryptoVerify('RSA-SHA256', signedData, key, signature)) return null;

  const claims = IdClaims.safeParse(decodeJson(payloadB64));
  if (!claims.success) return null;
  const c = claims.data;
  const now = opts.now ?? nowSeconds();
  if (c.iss !== opts.issuer || c.aud !== opts.audience) return null;
  if (c.exp + CLOCK_SKEW_SECONDS <= now || c.iat - CLOCK_SKEW_SECONDS > now) return null;

  return { sub: c.sub, email: c.email ?? null, demo: false };
}

/**
 * Checks if a token has been revoked by looking up the household's revocation timestamp.
 * Returns the guardian if the token is valid and not revoked, otherwise null.
 */
export async function verifyGuardianTokenWithRevocation(
  token: string,
  getHousehold: (sub: string) => Promise<{ tokensRevokedAt?: number } | null>
): Promise<Guardian | null> {
  const guardian = await verifyGuardianToken(token);
  if (!guardian) return null;

  const household = await getHousehold(guardian.sub);
  if (household?.tokensRevokedAt) {
    // Decode token to get iat (issued at)
    const payloadB64 = token.split('.')[1];
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    const iat = payload.iat as number;
    if (iat && iat < household.tokensRevokedAt) {
      return null; // Token was issued before revocation
    }
  }
  return guardian;
}

function decodeJson(b64: string): unknown {
  try {
    return JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

// ---- Cognito specifics -------------------------------------------------------------------

export function cognitoIssuer(): string {
  return `https://cognito-idp.${config.region}.amazonaws.com/${config.userPoolId}`;
}

const Jwks = z.object({ keys: z.array(z.object({ kid: z.string() }).passthrough()) });
let jwksCache: Map<string, KeyObject> = new Map();
let jwksFetchedAt = 0;
let jwksRefreshPromise: Promise<void> | null = null;

/** Proactively refresh JWKS in the background. Returns a promise that resolves when refresh is done. */
async function refreshJwks(): Promise<void> {
  // If a refresh is already in progress, wait for it
  if (jwksRefreshPromise) {
    await jwksRefreshPromise;
    return;
  }

  // Check if we should skip refresh (too soon since last fetch)
  if (Date.now() - jwksFetchedAt < JWKS_REFRESH_MIN_INTERVAL_MS && jwksCache.size > 0) {
    return;
  }

  jwksRefreshPromise = (async () => {
    try {
      const res = await fetch(`${cognitoIssuer()}/.well-known/jwks.json`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`jwks fetch failed with ${res.status}`);
      const parsed = Jwks.parse(await res.json());
      const next = new Map<string, KeyObject>();
      for (const jwk of parsed.keys) {
        next.set(jwk.kid, createPublicKey({ key: jwk as JsonWebKey, format: 'jwk' }));
      }
      jwksCache = next;
      jwksFetchedAt = Date.now();
    } finally {
      jwksRefreshPromise = null;
    }
  })();

  await jwksRefreshPromise;
}

/** Start the proactive JWKS refresh timer. Call once at app startup. */
export function startJwksRefresh(): void {
  // Initial fetch
  refreshJwks().catch(() => {
    // Log but don't throw - initial fetch failure shouldn't crash the app
    console.warn('Initial JWKS fetch failed, will retry on first use');
  });

  // Periodic refresh
  setInterval(() => {
    refreshJwks().catch(() => {
      // Silently fail - next attempt will be at the next interval
      console.warn('Periodic JWKS refresh failed');
    });
  }, JWKS_REFRESH_MIN_INTERVAL_MS);
}

/** Pool JWKS, cached per process, refreshed proactively and on unknown kid. */
export const cognitoKeyResolver: KeyResolver = async (kid) => {
  const hit = jwksCache.get(kid);
  if (hit) return hit;

  // Unknown kid - trigger immediate refresh
  await refreshJwks();
  return jwksCache.get(kid) ?? null;
};

export function verifyGuardianToken(token: string): Promise<Guardian | null> {
  return verifyIdToken(token, {
    issuer: cognitoIssuer(),
    audience: config.userPoolClientId,
    resolveKey: cognitoKeyResolver,
  });
}

// ---- OAuth authorization code flow with PKCE ---------------------------------------------

export interface OAuthStart {
  state: string;
  verifier: string;
  authorizeUrl: string;
}

export function redirectUri(appUrl: string): string {
  return `${appUrl}/api/auth/callback`;
}

/**
 * The name of the Cognito identity provider guardians sign in with. The user pool client
 * supports this one and nothing else, so naming it here only skips the provider chooser that
 * managed login would otherwise show for a single button. It is not a security control: the
 * pool refuses every other provider regardless of what arrives on the query string.
 */
export const IDENTITY_PROVIDER = 'Google';

export function startOAuth(appUrl: string): OAuthStart {
  const state = randomBytes(16).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.userPoolClientId,
    redirect_uri: redirectUri(appUrl),
    scope: 'openid email profile',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    identity_provider: IDENTITY_PROVIDER,
  });
  return { state, verifier, authorizeUrl: `https://${config.cognitoDomain}/oauth2/authorize?${params}` };
}

const TokenResponse = z.object({ id_token: z.string(), expires_in: z.number() });

export async function exchangeCode(appUrl: string, code: string, verifier: string): Promise<{ idToken: string }> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: config.userPoolClientId,
    code,
    redirect_uri: redirectUri(appUrl),
    code_verifier: verifier,
  });
  const res = await fetch(`https://${config.cognitoDomain}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`token exchange failed with ${res.status}`);
  const parsed = TokenResponse.parse(await res.json());
  return { idToken: parsed.id_token };
}

export function logoutUrl(appUrl: string): string {
  const params = new URLSearchParams({ client_id: config.userPoolClientId, logout_uri: appUrl });
  return `https://${config.cognitoDomain}/logout?${params}`;
}

/** Only same-app relative paths are allowed as a post-login destination. */
export function safeNextPath(next: string | null | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/app';
  return next;
}

// Start proactive JWKS refresh on module load (once per process)
if (typeof window === 'undefined') {
  startJwksRefresh();
}
