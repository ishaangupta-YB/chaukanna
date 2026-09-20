import { createHash, createHmac, generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { IDENTITY_PROVIDER, safeNextPath, startOAuth, verifyIdToken, type VerifyOptions } from './auth';

const ISSUER = 'https://cognito-idp.ap-south-1.amazonaws.com/ap-south-1_TEST';
const AUDIENCE = 'client123';
const NOW = 1_800_000_000;

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');

function jwt(claims: object, header: object = { alg: 'RS256', kid: 'k1' }, key: KeyObject = privateKey): string {
  const data = `${b64(header)}.${b64(claims)}`;
  return `${data}.${cryptoSign('RSA-SHA256', Buffer.from(data), key).toString('base64url')}`;
}

const goodClaims = {
  sub: 'guardian-sub',
  iss: ISSUER,
  aud: AUDIENCE,
  token_use: 'id',
  exp: NOW + 3600,
  iat: NOW - 10,
  email: 'g@example.com',
};

const opts: VerifyOptions = {
  issuer: ISSUER,
  audience: AUDIENCE,
  resolveKey: async (kid) => (kid === 'k1' ? publicKey : null),
  now: NOW,
};

describe('verifyIdToken', () => {
  it('accepts a valid Cognito ID token', async () => {
    // `demo: false`: a Cognito-verified guardian is never a demo one, whatever DEMO_MODE says.
    await expect(verifyIdToken(jwt(goodClaims), opts)).resolves.toEqual({
      sub: 'guardian-sub',
      email: 'g@example.com',
      demo: false,
    });
  });

  it('rejects a token signed by another key', async () => {
    await expect(verifyIdToken(jwt(goodClaims, undefined, other.privateKey), opts)).resolves.toBeNull();
  });

  it('rejects an unknown kid', async () => {
    await expect(verifyIdToken(jwt(goodClaims, { alg: 'RS256', kid: 'nope' }), opts)).resolves.toBeNull();
  });

  it('rejects alg none and HS256', async () => {
    const none = `${b64({ alg: 'none', kid: 'k1' })}.${b64(goodClaims)}.`;
    await expect(verifyIdToken(none, opts)).resolves.toBeNull();
    const data = `${b64({ alg: 'HS256', kid: 'k1' })}.${b64(goodClaims)}`;
    const hs = `${data}.${createHmac('sha256', 'secret').update(data).digest('base64url')}`;
    await expect(verifyIdToken(hs, opts)).resolves.toBeNull();
  });

  it.each([
    ['wrong issuer', { iss: 'https://evil.example.com' }],
    ['wrong audience', { aud: 'other-client' }],
    ['access token instead of id token', { token_use: 'access' }],
    ['expired', { exp: NOW - 120 }],
    ['issued in the future', { iat: NOW + 600 }],
  ])('rejects %s', async (_name, override) => {
    await expect(verifyIdToken(jwt({ ...goodClaims, ...override }), opts)).resolves.toBeNull();
  });

  it('rejects a tampered payload', async () => {
    const [h, , s] = jwt(goodClaims).split('.');
    await expect(verifyIdToken(`${h}.${b64({ ...goodClaims, sub: 'attacker' })}.${s}`, opts)).resolves.toBeNull();
  });

  it.each(['', 'a.b', 'a.b.c.d', '!!!.???.***'])('rejects malformed %j', async (bad) => {
    await expect(verifyIdToken(bad, opts)).resolves.toBeNull();
  });
});

describe('safeNextPath', () => {
  it.each([
    ['/app/invite', '/app/invite'],
    [null, '/app'],
    ['https://evil.example.com', '/app'],
    ['//evil.example.com', '/app'],
    ['/\\evil.example.com', '/app'],
  ])('%j -> %j', (input, expected) => {
    expect(safeNextPath(input)).toBe(expected);
  });
});

describe('startOAuth', () => {
  const APP_URL = 'http://localhost:3000';

  // `config` reads the environment lazily, so setting it here is enough; nothing here is a
  // secret and no value of ours appears in this file.
  beforeAll(() => {
    process.env.USER_POOL_CLIENT_ID = AUDIENCE;
    process.env.COGNITO_DOMAIN = 'chaukanna-test.auth.ap-south-1.amazoncognito.com';
  });

  function authorizeParams() {
    const { authorizeUrl } = startOAuth(APP_URL);
    const url = new URL(authorizeUrl);
    return { url, params: url.searchParams };
  }

  it('sends the guardian straight to Google, not the provider chooser', () => {
    expect(authorizeParams().params.get('identity_provider')).toBe(IDENTITY_PROVIDER);
  });

  it('asks for an authorization code with PKCE and the three scopes the pool allows', () => {
    const { params } = authorizeParams();
    expect(params.get('response_type')).toBe('code');
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('scope')).toBe('openid email profile');
    expect(params.get('redirect_uri')).toBe(`${APP_URL}/api/auth/callback`);
  });

  it('derives the challenge from the verifier it returns', () => {
    const { verifier, authorizeUrl } = startOAuth(APP_URL);
    const expected = createHash('sha256').update(verifier).digest('base64url');
    expect(new URL(authorizeUrl).searchParams.get('code_challenge')).toBe(expected);
  });

  it('never reuses a state or a verifier', () => {
    const a = startOAuth(APP_URL);
    const b = startOAuth(APP_URL);
    expect(a.state).not.toBe(b.state);
    expect(a.verifier).not.toBe(b.verifier);
  });
});
