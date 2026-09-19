import { DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { ddb, table } from './client';

/** Proves the runtime role can reach the table. Used by /api/health only. */
export async function describeTable(): Promise<{ table: string | undefined; status: string | undefined }> {
  const out = await ddb().send(new DescribeTableCommand({ TableName: table() }));
  return { table: out.Table?.TableName, status: out.Table?.TableStatus };
}
