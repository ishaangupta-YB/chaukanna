import { DynamoDBClient, DescribeTableCommand } from '@aws-sdk/client-dynamodb';

export const dynamic = 'force-dynamic';

export async function GET() {
  const tableName = process.env.TABLE_NAME || 'chaukanna';
  const region = process.env.AWS_REGION || 'ap-south-1';

  try {
    const client = new DynamoDBClient({ region });
    const out = await client.send(new DescribeTableCommand({ TableName: tableName }));

    return Response.json({
      ok: true,
      region,
      table: out.Table?.TableName,
      status: out.Table?.TableStatus,
    });
  } catch (error: unknown) {
    const err = error as { message?: string; name?: string };
    return Response.json(
      {
        ok: false,
        error: err.message || 'Failed to connect to DynamoDB',
        code: err.name,
        region,
        table: tableName,
      },
      { status: 500 }
    );
  }
}
