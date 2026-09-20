import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { config } from '../config';

let doc: DynamoDBDocumentClient | null = null;

export function ddb(): DynamoDBDocumentClient {
  if (!doc) {
    doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: config.region }), {
      marshallOptions: { removeUndefinedValues: true },
    });
  }
  return doc;
}

export function table(): string {
  return config.tableName;
}

/** Key builders, the only place key formats are spelled out. */
export const keys = {
  household: (householdId: string) => ({ pk: `HH#${householdId}`, sk: 'META' }),
  member: (householdId: string, memberId: string) => ({ pk: `HH#${householdId}`, sk: `MEMBER#${memberId}` }),
  memberPrefix: 'MEMBER#',
  consent: (memberId: string, at: string) => ({ pk: `MEMBER#${memberId}`, sk: `CONSENT#${at}` }),
  consentPrefix: 'CONSENT#',
  memberPk: (memberId: string) => `MEMBER#${memberId}`,
  window: (memberId: string) => ({ pk: `MEMBER#${memberId}`, sk: 'WINDOW#current' }),
  /**
   * The scheduled time is inside the sort key, so drills come back newest first for free and the
   * agent can address a row from its session token alone. `chaukanna_agent/store.py` builds the
   * same two strings; change them together.
   */
  drill: (memberId: string, scheduledAt: string, drillId: string) => ({
    pk: `MEMBER#${memberId}`,
    sk: `DRILL#${scheduledAt}#${drillId}`,
  }),
  drillPrefix: 'DRILL#',
  drillEvents: (drillId: string) => `DRILL#${drillId}`,
  eventPrefix: 'EVT#',
};

/** GSI1 lets Phase 4's scheduler sweep drills by state without scanning. */
export const gsi1 = {
  state: (state: string) => `STATE#${state}`,
};

export function isConditionFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'ConditionalCheckFailedException' ||
      (error.name === 'TransactionCanceledException' && error.message.includes('ConditionalCheckFailed')))
  );
}
