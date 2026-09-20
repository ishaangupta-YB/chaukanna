import type { Guardian } from './auth';
import { getMember, markInviteAccepted, putMember, setInvite, type Language, type Member } from './db';
import { gone, notFound } from './errors';
import { requireOwnHousehold } from './households';
import { checkInvite, issueInvite } from './invite';
import { issueLearnerSession } from './learner-session';
import { log } from './log';
import { getInviteSigningKey } from './secrets';
import { nowSeconds, randomId } from './signing';

/** A second accept with the same token inside this window is a double tap, not a replay. */
export const ACCEPT_GRACE_SECONDS = 10 * 60;

export function inviteUrl(appUrl: string, token: string): string {
  return `${appUrl}/join/${token}`;
}

export async function createLearner(
  guardian: Guardian,
  householdId: string,
  input: { displayName: string; language: Language },
  appUrl: string,
): Promise<{ memberId: string; inviteUrl: string }> {
  await requireOwnHousehold(guardian, householdId);
  const key = await getInviteSigningKey();
  const memberId = randomId();
  const invite = issueInvite(key, memberId, householdId);
  const now = new Date().toISOString();
  await putMember({
    memberId,
    householdId,
    displayName: input.displayName,
    language: input.language,
    status: 'invited',
    createdAt: now,
    updatedAt: now,
    inviteHash: invite.tokenHash,
    inviteExpiresAt: invite.expiresAt,
    transcriptSharing: false,
  });
  log.info('member.invited', { householdId, memberId });
  return { memberId, inviteUrl: inviteUrl(appUrl, invite.token) };
}

/** Replaces any outstanding invite for the member with a fresh 72 hour link. */
export async function reissueInvite(member: Member, appUrl: string): Promise<{ inviteUrl: string }> {
  const key = await getInviteSigningKey();
  const invite = issueInvite(key, member.memberId, member.householdId);
  await setInvite(member.householdId, member.memberId, invite.tokenHash, invite.expiresAt, new Date().toISOString());
  log.info('member.invite_reissued', { householdId: member.householdId, memberId: member.memberId });
  return { inviteUrl: inviteUrl(appUrl, invite.token) };
}

export type InviteView =
  | { state: 'open' | 'accepted'; memberId: string; displayName: string; language: Language }
  | { state: 'invalid' };

/** What the consent screen needs. Reveals nothing about why an invalid link is invalid. */
export async function readInvite(token: string): Promise<InviteView> {
  const key = await getInviteSigningKey();
  const check = checkInvite(key, token);
  if (!check.ok) return { state: 'invalid' };
  const member = await getMember(check.payload.h, check.payload.m);
  if (!member) return { state: 'invalid' };
  const view = { memberId: member.memberId, displayName: member.displayName, language: member.language };
  if (member.inviteHash === check.tokenHash && (member.inviteExpiresAt ?? 0) > nowSeconds()) {
    return { state: 'open', ...view };
  }
  if (member.acceptedInviteHash === check.tokenHash && withinGrace(member)) return { state: 'accepted', ...view };
  return { state: 'invalid' };
}

/**
 * Single use and idempotent: the first call clears the invite hash; a repeat of the same token
 * inside the grace window returns the same member and a fresh session cookie.
 */
export async function acceptInvite(token: string): Promise<{ member: Member; session: { value: string; maxAge: number } }> {
  const key = await getInviteSigningKey();
  const check = checkInvite(key, token);
  if (!check.ok) throw gone('invite_invalid');
  const { m: memberId, h: householdId } = check.payload;

  const first = await markInviteAccepted(householdId, memberId, check.tokenHash, new Date().toISOString(), nowSeconds());
  const member = await getMember(householdId, memberId);
  if (!member) throw notFound();
  if (!first && !(member.acceptedInviteHash === check.tokenHash && withinGrace(member))) {
    throw gone('invite_used');
  }

  if (first) log.info('member.invite_accepted', { householdId, memberId });
  return { member, session: issueLearnerSession(key, memberId, householdId) };
}

function withinGrace(member: Member): boolean {
  if (!member.acceptedAt) return false;
  return Date.now() - Date.parse(member.acceptedAt) <= ACCEPT_GRACE_SECONDS * 1000;
}
