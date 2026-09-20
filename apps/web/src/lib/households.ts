import type { Guardian } from './auth';
import { getHousehold, putHousehold, setHouseholdOwnerEmail, type Household } from './db';
import { forbidden } from './errors';
import { log } from './log';
import { sha256Hex } from './signing';

/**
 * One household per guardian. The id is derived from the Cognito subject, so a double tap on
 * "create" hits the same key and the conditional write turns it into a no-op.
 */
export function householdIdForGuardian(sub: string): string {
  return sha256Hex(`household:${sub}`).slice(0, 20);
}

export async function createHousehold(guardian: Guardian, name: string): Promise<{ household: Household; created: boolean }> {
  const householdId = householdIdForGuardian(guardian.sub);
  const created = await putHousehold({
    householdId,
    ownerSub: guardian.sub,
    name,
    createdAt: new Date().toISOString(),
    ownerEmail: guardian.email ?? undefined,
  });
  const household = await getHousehold(householdId);
  if (!household || household.ownerSub !== guardian.sub) throw forbidden();
  if (created) log.info('household.created', { householdId });
  return { household, created };
}

export async function getGuardianHousehold(guardian: Guardian): Promise<Household | null> {
  const household = await getHousehold(householdIdForGuardian(guardian.sub));
  if (!household || household.ownerSub !== guardian.sub) return null;

  /*
   * Keep the stored address in step with the one Google just verified, so the drill nudge does
   * not go on being sent to an address the guardian has abandoned. Written only when it actually
   * differs, so an ordinary page load stays a read.
   */
  if (guardian.email && household.ownerEmail !== guardian.email) {
    await setHouseholdOwnerEmail(household.householdId, guardian.email);
    return { ...household, ownerEmail: guardian.email };
  }
  return household;
}

/** Default deny: the id in the URL must be the caller's own household. */
export async function requireOwnHousehold(guardian: Guardian, householdId: string): Promise<Household> {
  const household = await getGuardianHousehold(guardian);
  if (!household || household.householdId !== householdId) throw forbidden();
  return household;
}
