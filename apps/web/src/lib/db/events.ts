import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, keys, table } from './client';
import { EVENT_TTL_DAYS } from './models';

/**
 * The lifecycle audit trail. Every state transition a drill goes through writes one of these,
 * because "why did my mother's phone ring at 3pm" is a question this product has to be able to
 * answer, and a log line in CloudWatch is not an answer a family can see.
 *
 * These rows share a partition with the agent's own in-call events, which `chaukanna_agent`
 * writes as `EVT#000000`, `EVT#000001` and so on. Ours are keyed by timestamp instead, and a
 * zero-padded integer can never collide with an ISO date, so the two writers never overwrite each
 * other. They do not interleave in sort order, which is fine: every row carries its own `at` and a
 * reader that cares about order sorts on that.
 */

export type DrillEventActor = 'guardian' | 'learner' | 'scheduler' | 'agent' | 'system';

export interface DrillEvent {
  drillId: string;
  memberId: string;
  householdId: string;
  /** Dotted and past tense: `drill.scheduled`, `drill.due`, `drill.cancelled`, `drill.missed`. */
  name: string;
  at: string;
  actor: DrillEventActor;
  /** Small scalars only. Never a transcript line, never a quote, never an email address. */
  detail?: Record<string, string | number | boolean>;
}

export async function putDrillEvent(event: DrillEvent): Promise<void> {
  const ttl = Math.floor(Date.parse(event.at) / 1000) + EVENT_TTL_DAYS * 24 * 60 * 60;
  await ddb().send(
    new PutCommand({
      TableName: table(),
      Item: {
        ...keys.lifecycleEvent(event.drillId, event.at, event.name),
        entity: 'DrillEvent',
        ...event,
        ttl,
      },
    }),
  );
}

/** Every event for one drill, oldest first. Used by the guardian's history in a later phase. */
export async function listDrillEvents(drillId: string, limit = 50): Promise<DrillEvent[]> {
  const out = await ddb().send(
    new QueryCommand({
      TableName: table(),
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': keys.drillEvents(drillId), ':prefix': keys.eventPrefix },
      Limit: limit,
    }),
  );
  return (out.Items ?? [])
    .filter((item) => item.entity === 'DrillEvent')
    .map((item) => item as unknown as DrillEvent)
    .sort((a, b) => a.at.localeCompare(b.at));
}
