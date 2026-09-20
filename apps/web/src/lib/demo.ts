import { createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Guardian } from './auth';
import { config } from './config';
import { CONSENT_CATEGORIES, getMember, putWindow, TIME_ZONE, type DrillWindow } from './db';
import { recordConsent } from './consent';
import { forbidden } from './errors';
import { createHousehold } from './households';
import { assertSameOrigin } from './http';
import { createLearner } from './invites';
import { log } from './log';
import { getInviteSigningKey } from './secrets';
import { nowSeconds, verify } from './signing';

/**
 * The judge demo session: a deliberate, narrow authentication bypass so a hackathon judge can be
 * inside a working guardian dashboard in one click, with no Google account and nobody's
 * credentials.
 *
 * It is built like a bypass, not like a feature:
 *
 * - It only exists while `DEMO_MODE=on`. With it off the routes are 404 and this module's
 *   `demoGuardianFrom` returns null for every input, so a cookie that escapes a demo deployment
 *   is inert on the deployment real families use.
 * - Every click mints a brand new random identity, so two judges never share a household and no
 *   judge is ever standing in a real guardian's data. The household id is
 *   `sha256("household:" + sub)` (lib/households.ts), so a `demo-…` sub addresses a key space a
 *   Cognito subject can never reach, and `getGuardianHousehold` additionally checks `ownerSub`.
 * - The cookie is an HMAC of the same shape as the learner session (lib/signing.ts), under a key
 *   of its own, short lived, httpOnly and SameSite=Lax like every other session here.
 * - Nothing it seeds is real: the household is named as a demo and its `ownerSub` begins with
 *   `demo-`, which is the flag a cleanup pass looks for.
 */

export const DEMO_COOKIE = 'ck_demo';
/** Long enough for a judging slot, short enough that a forgotten tab is not a standing key. */
export const DEMO_SESSION_TTL_SECONDS = 2 * 60 * 60;
/** The marker that makes every demo row identifiable, on the sub and so on the household. */
export const DEMO_SUB_PREFIX = 'demo-';
const DEMO_SUB = /^demo-[a-f0-9]{16}$/;

export const DEMO_HOUSEHOLD_NAME = 'Demo household (judge preview)';
export const DEMO_LEARNER_NAME = 'Maa (demo)';
/**
 * Wide open, every day, so "Ring now" works the moment the judge lands. A real learner picks
 * their own hours; this one exists for ninety seconds.
 */
export const DEMO_WINDOW: DrillWindow = { days: [1, 2, 3, 4, 5, 6, 7], start: '00:00', end: '23:59', tz: TIME_ZONE };

const DemoSession = z.object({
  /** The demo subject this cookie stands for. */
  s: z.string().regex(DEMO_SUB),
  /** The learner's invite token, so the dashboard can show the judge where to open the phone side. */
  i: z.string().min(1).max(512),
  exp: z.number().int().positive(),
});
export type DemoSession = z.infer<typeof DemoSession>;

/**
 * Same construction as `deriveKey` in lib/signing.ts, with a purpose string of its own so a demo
 * cookie can never be replayed as an invite or a learner session and vice versa. Spelled out here
 * rather than added to `TokenPurpose` because signing.ts is another owner's file this phase.
 */
function demoKey(masterKey: string): Buffer {
  return createHmac('sha256', masterKey).update('chaukanna:demo-session:v1').digest();
}

/**
 * Same job as `assertSameOrigin`: these are cookie-authenticated writes and must come from our
 * own pages. It exists separately because the demo entry point is a real `<form method="post">`
 * rather than a `fetch`, and a top-level form navigation does not carry an `Origin` header in
 * every browser — `assertSameOrigin` alone rejects an ordinary click in the ones that omit it.
 *
 * Fetch metadata is the standard answer. `Sec-Fetch-Site` is set by the browser, cannot be
 * written by a page, and says `same-origin` only when the request came from a page on this
 * origin. Anything else — `cross-site`, `same-site`, or `none` for a typed URL — is refused, and
 * a request with no fetch metadata at all falls back to the Origin check.
 */
export function assertDemoFormPost(request: Request, appUrl: string): void {
  const site = request.headers.get('sec-fetch-site');
  if (site === 'same-origin') return;
  if (site) throw forbidden('origin_mismatch');
  assertSameOrigin(request, appUrl);
}

export function newDemoSub(): string {
  return `${DEMO_SUB_PREFIX}${randomBytes(8).toString('hex')}`;
}

export function isDemoSub(sub: string): boolean {
  return DEMO_SUB.test(sub);
}

export function issueDemoSession(
  masterKey: string,
  sub: string,
  inviteToken: string,
  now = nowSeconds(),
): { value: string; maxAge: number } {
  if (!isDemoSub(sub)) throw new Error('refusing to sign a demo session for a non-demo subject');
  const payload: DemoSession = { s: sub, i: inviteToken, exp: now + DEMO_SESSION_TTL_SECONDS };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', demoKey(masterKey)).update(body).digest();
  return { value: `${body}.${Buffer.from(mac).toString('base64url')}`, maxAge: DEMO_SESSION_TTL_SECONDS };
}

/** The session a cookie value carries, or null. Never throws, and never checks `DEMO_MODE`. */
export function readDemoSession(masterKey: string, value: string, now = nowSeconds()): DemoSession | null {
  if (value.length > 1024) return null;
  const parsed = DemoSession.safeParse(verify(value, demoKey(masterKey)));
  if (!parsed.success || parsed.data.exp <= now) return null;
  return parsed.data;
}

/**
 * The guardian a demo cookie resolves to, or null.
 *
 * `enabled` defaults to the live `DEMO_MODE` and is the only gate that matters: with demo mode
 * off this returns null for a perfectly valid, perfectly signed cookie.
 */
export function demoGuardianFrom(
  masterKey: string,
  value: string | undefined,
  enabled = config.demoMode,
  now = nowSeconds(),
): Guardian | null {
  if (!enabled || !value) return null;
  const session = readDemoSession(masterKey, value, now);
  return session ? { sub: session.s, email: null, demo: true } : null;
}

export interface StartedDemo {
  guardian: Guardian;
  householdId: string;
  memberId: string;
  inviteUrl: string;
  session: { value: string; maxAge: number };
}

/**
 * Seeds one ready-to-demo household and returns the cookie to set. Everything goes through the
 * ordinary domain helpers — `createHousehold`, `createLearner`, `recordConsent`, `putWindow` —
 * so a demo household is an ordinary household in every respect except that nobody owns it.
 *
 * The learner is left with its invite outstanding on purpose: the judge accepts it on their own
 * phone, which is the whole second half of the demo.
 */
export async function startDemo(appUrl: string): Promise<StartedDemo> {
  const guardian: Guardian = { sub: newDemoSub(), email: null, demo: true };
  const { household } = await createHousehold(guardian, DEMO_HOUSEHOLD_NAME);

  const { memberId, inviteUrl } = await createLearner(
    guardian,
    household.householdId,
    { displayName: DEMO_LEARNER_NAME, language: 'hi-IN' },
    appUrl,
  );

  const member = await getMember(household.householdId, memberId);
  if (!member) throw new Error('demo learner vanished between write and read');

  await putWindow({
    memberId,
    window: DEMO_WINDOW,
    updatedAt: new Date().toISOString(),
    updatedBy: 'guardian',
  });
  // Typed, not spoken: a judge is not going to record a consent sentence, and a demo household
  // holds no real person's voice. This is what flips the member to `active`.
  await recordConsent(member, { method: 'typed', language: 'hi-IN', categories: [...CONSENT_CATEGORIES] });

  const inviteToken = inviteUrl.slice(inviteUrl.lastIndexOf('/') + 1);
  const session = issueDemoSession(await getInviteSigningKey(), guardian.sub, inviteToken);

  log.info('demo.started', { householdId: household.householdId, memberId });
  return { guardian, householdId: household.householdId, memberId, inviteUrl, session };
}
