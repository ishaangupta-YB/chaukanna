import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Compact signed tokens: base64url(payloadJson) + "." + base64url(hmacSHA256(payloadB64, key)).
 * Each token purpose uses its own key, derived from the master key, so an invite can never be
 * replayed as a learner session and vice versa.
 */

export type TokenPurpose = 'invite' | 'learner-session' | 'drill-session';

export function deriveKey(masterKey: string, purpose: TokenPurpose): Buffer {
  return createHmac('sha256', masterKey).update(`chaukanna:${purpose}:v1`).digest();
}

export function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

export function sign(payload: object, key: Buffer): string {
  const body = base64url(JSON.stringify(payload));
  const mac = createHmac('sha256', key).update(body).digest();
  return `${body}.${base64url(mac)}`;
}

/** Returns the parsed payload when the MAC is valid, otherwise null. Never throws. */
export function verify(token: string, key: Buffer): unknown {
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [body, macB64] = parts;
  const expected = createHmac('sha256', key).update(body).digest();
  const actual = Buffer.from(macB64, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function randomId(bytes = 10): string {
  return randomBytes(bytes).toString('hex');
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
