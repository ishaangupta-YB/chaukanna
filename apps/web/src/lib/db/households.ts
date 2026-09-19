import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
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
