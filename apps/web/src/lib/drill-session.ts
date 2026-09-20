import type { Drill } from './db';
import { deriveKey, nowSeconds, sign } from './signing';

/**
 * The token the browser carries to the agent. It is the only thing the agent trusts about a call:
 * which drill, which member, which language, how long it may run.
 *
 * The verifier is `apps/agent/chaukanna_agent/session_token.py`. The payload keys, the key
 * derivation and the encoding are a contract between the two files, pinned from both sides by
 * `fixtures/drill-session-token.json`.
 *
 * Its own signature is not what makes it safe to hand out. The drill row has to be waiting for
 * exactly this `j`, and the agent consumes that in a conditional write, so a token that leaks or
 * is opened twice buys nothing.
 */

/** Five minutes: long enough to grant the microphone, short enough to be worthless if it leaks. */
export const SESSION_TOKEN_TTL_SECONDS = 300;

export interface DrillSessionClaims {
  /** drillId */
  d: string;
  /** memberId */
  m: string;
  /** householdId */
  h: string;
  /** scheduledAt, the timestamp inside the drill row's sort key */
  t: string;
  /** language */
  l: 'hi-IN' | 'en-IN';
  /** scenarioId */
  s: string;
  /** maxSeconds */
  x: number;
  /** the single use claim id, matched against the drill row */
  j: string;
  /** expiry, epoch seconds */
  exp: number;
}

export function drillSessionClaims(drill: Drill, jti: string, issuedAt = nowSeconds()): DrillSessionClaims {
  return {
    d: drill.drillId,
    m: drill.memberId,
    h: drill.householdId,
    t: drill.scheduledAt,
    l: drill.language,
    s: drill.scenarioId,
    x: drill.maxSeconds,
    j: jti,
    exp: issuedAt + SESSION_TOKEN_TTL_SECONDS,
  };
}

export function signDrillSessionToken(masterKey: string, claims: DrillSessionClaims): string {
  return sign(claims, deriveKey(masterKey, 'drill-session'));
}
