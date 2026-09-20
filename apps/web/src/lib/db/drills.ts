import { PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, gsi1, isConditionFailure, keys, table } from './client';
import { Drill } from './models';

/**
 * Drill rows. The web app creates them and mints session tokens against them; the agent claims
 * one and writes the outcome. Both sides address the row by `memberId` plus `scheduledAt`, which
 * is why the scheduled time travels inside the session token.
 */

export async function putDrill(drill: Drill): Promise<void> {
  const item = Drill.parse(drill);
  await ddb().send(
    new PutCommand({
      TableName: table(),
      Item: {
        ...keys.drill(item.memberId, item.scheduledAt, item.drillId),
        entity: 'Drill',
        gsi1pk: gsi1.state(item.state),
        gsi1sk: item.scheduledAt,
        ...item,
      },
      ConditionExpression: 'attribute_not_exists(pk)',
    }),
  );
}

/** Newest first. A learner has one drill a week, so the default page is a long history. */
export async function listDrills(memberId: string, limit = 20): Promise<Drill[]> {
  const out = await ddb().send(
    new QueryCommand({
      TableName: table(),
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': keys.memberPk(memberId), ':prefix': keys.drillPrefix },
      ScanIndexForward: false,
      Limit: limit,
      ConsistentRead: true,
    }),
  );
  return (out.Items ?? []).map((item) => Drill.parse(item));
}

/**
 * A drill by id, for a member we have already authorised. There is no index on `drillId` and
 * there does not need to be: a learner's whole history is one short query, and looking within it
 * means an id from another household can never resolve.
 */
export async function getDrill(memberId: string, drillId: string): Promise<Drill | null> {
  const drills = await listDrills(memberId, 50);
  return drills.find((drill) => drill.drillId === drillId) ?? null;
}

export async function latestDrill(memberId: string): Promise<Drill | null> {
  const [drill] = await listDrills(memberId, 1);
  return drill ?? null;
}

/**
 * Moves the drill to `session_pending` and records which token may claim it. Re-minting is
 * allowed while it is still pending, because a learner whose first tap failed should be able to
 * tap again; each mint rotates the id, so the previous token stops working immediately.
 *
 * Once the agent has claimed the drill this fails, which is what stops a second call.
 */
export async function beginDrillSession(
  drill: Drill,
  jti: string,
  expiresAt: number,
  nowIso: string,
): Promise<boolean> {
  try {
    await ddb().send(
      new UpdateCommand({
        TableName: table(),
        Key: keys.drill(drill.memberId, drill.scheduledAt, drill.drillId),
        UpdateExpression:
          'SET #state = :pending, gsi1pk = :gsi1pk, sessionJti = :jti, sessionExpiresAt = :exp, updatedAt = :now',
        ConditionExpression: 'attribute_exists(pk) AND (#state = :due OR #state = :pending)',
        ExpressionAttributeNames: { '#state': 'state' },
        ExpressionAttributeValues: {
          ':pending': 'session_pending',
          ':due': 'due',
          ':gsi1pk': gsi1.state('session_pending'),
          ':jti': jti,
          ':exp': expiresAt,
          ':now': nowIso,
        },
      }),
    );
    return true;
  } catch (error) {
    if (isConditionFailure(error)) return false;
    throw error;
  }
}

/**
 * Closes a drill that never became a call: the kill switch reached it before it rang (PRD F2
 * AC4), the learner said "not now", or the microphone was refused and the browser gave up.
 *
 * `cancelled` rather than `ended`, and the difference matters to the learner. A cancelled drill
 * does not count against the one-a-week cap, because nobody was called. Fumbling a permission
 * prompt must not cost somebody their practice for seven days.
 *
 * A drill the agent has already claimed is not touched: from that point the agent owns how the
 * call ends and what gets written, and a browser must not be able to post an outcome.
 */
export async function cancelDrill(drill: Drill, nowIso: string, source: string): Promise<boolean> {
  try {
    await ddb().send(
      new UpdateCommand({
        TableName: table(),
        Key: keys.drill(drill.memberId, drill.scheduledAt, drill.drillId),
        UpdateExpression:
          'SET #state = :cancelled, gsi1pk = :gsi1pk, updatedAt = :now, endedAt = :now, ' +
          'endSource = :source REMOVE sessionJti, sessionExpiresAt',
        ConditionExpression:
          'attribute_exists(pk) AND (#state = :scheduled OR #state = :due OR #state = :pending)',
        ExpressionAttributeNames: { '#state': 'state' },
        ExpressionAttributeValues: {
          ':cancelled': 'cancelled',
          ':scheduled': 'scheduled',
          ':due': 'due',
          ':pending': 'session_pending',
          ':gsi1pk': gsi1.state('cancelled'),
          ':now': nowIso,
          ':source': source.slice(0, 60),
        },
      }),
    );
    return true;
  } catch (error) {
    if (isConditionFailure(error)) return false;
    throw error;
  }
}
