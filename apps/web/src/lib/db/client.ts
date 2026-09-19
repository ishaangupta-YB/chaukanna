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
};

export function isConditionFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'ConditionalCheckFailedException' ||
      (error.name === 'TransactionCanceledException' && error.message.includes('ConditionalCheckFailed')))
  );
}
