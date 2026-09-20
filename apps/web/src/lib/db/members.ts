import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, isConditionFailure, keys, table } from './client';
import { Member } from './models';

export async function putMember(member: Member): Promise<void> {
  const item = Member.parse(member);
  await ddb().send(
    new PutCommand({
      TableName: table(),
      Item: { ...keys.member(item.householdId, item.memberId), entity: 'Member', ...item },
      ConditionExpression: 'attribute_not_exists(pk)',
    }),
  );
}

export async function getMember(householdId: string, memberId: string): Promise<Member | null> {
  const out = await ddb().send(
    new GetCommand({ TableName: table(), Key: keys.member(householdId, memberId), ConsistentRead: true }),
  );
  return out.Item ? Member.parse(out.Item) : null;
}

export async function listMembers(householdId: string): Promise<Member[]> {
  const out = await ddb().send(
    new QueryCommand({
      TableName: table(),
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': keys.household(householdId).pk, ':prefix': keys.memberPrefix },
      ConsistentRead: true,
    }),
  );
  return (out.Items ?? []).map((item) => Member.parse(item)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Single use: succeeds only while this exact invite hash is outstanding and unexpired, and
 * clears it in the same write. Returns false when the condition fails.
 */
export async function markInviteAccepted(
  householdId: string,
  memberId: string,
  tokenHash: string,
  nowIso: string,
  nowEpoch: number,
): Promise<boolean> {
  try {
    await ddb().send(
      new UpdateCommand({
        TableName: table(),
        Key: keys.member(householdId, memberId),
        UpdateExpression:
          'SET acceptedInviteHash = :hash, acceptedAt = :now, updatedAt = :now REMOVE inviteHash, inviteExpiresAt',
        ConditionExpression: 'attribute_exists(pk) AND inviteHash = :hash AND inviteExpiresAt > :epoch',
        ExpressionAttributeValues: { ':hash': tokenHash, ':now': nowIso, ':epoch': nowEpoch },
      }),
    );
    return true;
  } catch (error) {
    if (isConditionFailure(error)) return false;
    throw error;
  }
}

/** Kill switch. Idempotent: pausing a paused member just refreshes nothing but updatedAt. */
export async function pauseMember(householdId: string, memberId: string, nowIso: string): Promise<void> {
  await ddb().send(
    new UpdateCommand({
      TableName: table(),
      Key: keys.member(householdId, memberId),
      UpdateExpression: 'SET #status = :paused, pausedAt = if_not_exists(pausedAt, :now), updatedAt = :now',
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':paused': 'paused', ':now': nowIso },
    }),
  );
}

/** Replaces the outstanding invite. Any earlier link for this member stops working. */
export async function setInvite(
  householdId: string,
  memberId: string,
  tokenHash: string,
  expiresAt: number,
  nowIso: string,
): Promise<void> {
  await ddb().send(
    new UpdateCommand({
      TableName: table(),
      Key: keys.member(householdId, memberId),
      UpdateExpression: 'SET inviteHash = :hash, inviteExpiresAt = :exp, updatedAt = :now',
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeValues: { ':hash': tokenHash, ':exp': expiresAt, ':now': nowIso },
    }),
  );
}
