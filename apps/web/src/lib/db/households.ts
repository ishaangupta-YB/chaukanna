import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, isConditionFailure, keys, table } from './client';
import { Household } from './models';

/** Conditional create. Returns false if the household already exists (double tap). */
export async function putHousehold(household: Household): Promise<boolean> {
  const item = Household.parse(household);
  try {
    await ddb().send(
      new PutCommand({
        TableName: table(),
        Item: { ...keys.household(item.householdId), entity: 'Household', ...item },
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
    return true;
  } catch (error) {
    if (isConditionFailure(error)) return false;
    throw error;
  }
}

export async function getHousehold(householdId: string): Promise<Household | null> {
  const out = await ddb().send(
    new GetCommand({ TableName: table(), Key: keys.household(householdId), ConsistentRead: true }),
  );
  return out.Item ? Household.parse(out.Item) : null;
}

/**
 * Remembers the guardian's Google address so the ring Lambda has somewhere to send the nudge.
 * Written on every sign-in rather than once, because a guardian can change the address on their
 * Google account and the stale one would bounce silently.
 *
 * Conditional on the household existing, so this can never create a half-formed row.
 */
export async function setHouseholdOwnerEmail(householdId: string, email: string): Promise<void> {
  await ddb().send(
    new UpdateCommand({
      TableName: table(),
      Key: keys.household(householdId),
      UpdateExpression: 'SET ownerEmail = :email',
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeValues: { ':email': email },
    }),
  );
}
