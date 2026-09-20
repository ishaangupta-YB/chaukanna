import { QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, isConditionFailure, keys, table } from './client';
import { Consent } from './models';

/**
 * Writes the consent row and activates the member atomically. The consent row is keyed by its
 * timestamp and created conditionally, so replaying the same consent is a no-op (returns false).
 */
export async function putConsent(consent: Consent): Promise<boolean> {
  const item = Consent.parse(consent);
  try {
    await ddb().send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: table(),
              Item: { ...keys.consent(item.memberId, item.at), entity: 'Consent', ...item },
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
          {
            Update: {
              TableName: table(),
              Key: keys.member(item.householdId, item.memberId),
              UpdateExpression: 'SET #status = :active, consentAt = :at, updatedAt = :at REMOVE pausedAt',
              ConditionExpression: 'attribute_exists(pk)',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: { ':active': 'active', ':at': item.at },
            },
          },
        ],
      }),
    );
    return true;
  } catch (error) {
    if (isConditionFailure(error)) return false;
    throw error;
  }
}

export async function getLatestConsent(memberId: string): Promise<Consent | null> {
  const out = await ddb().send(
    new QueryCommand({
      TableName: table(),
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': keys.memberPk(memberId), ':prefix': keys.consentPrefix },
      ScanIndexForward: false,
      Limit: 1,
      ConsistentRead: true,
    }),
  );
  const item = out.Items?.[0];
  return item ? Consent.parse(item) : null;
}

/** Marks the consent revoked and the member revoked, together. */
export async function revokeConsent(consent: Consent, nowIso: string): Promise<void> {
  await ddb().send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: table(),
            Key: keys.consent(consent.memberId, consent.at),
            UpdateExpression: 'SET revokedAt = if_not_exists(revokedAt, :now)',
            ConditionExpression: 'attribute_exists(pk)',
            ExpressionAttributeValues: { ':now': nowIso },
          },
        },
        {
          Update: {
            TableName: table(),
            Key: keys.member(consent.householdId, consent.memberId),
            UpdateExpression: 'SET #status = :revoked, updatedAt = :now',
            ConditionExpression: 'attribute_exists(pk)',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: { ':revoked': 'revoked', ':now': nowIso },
          },
        },
      ],
    }),
  );
}
