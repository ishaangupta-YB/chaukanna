import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, keys, table } from './client';
import { StoredWindow } from './models';

export async function getWindow(memberId: string): Promise<StoredWindow | null> {
  const out = await ddb().send(new GetCommand({ TableName: table(), Key: keys.window(memberId), ConsistentRead: true }));
  return out.Item ? StoredWindow.parse(out.Item) : null;
}

/** There is exactly one current window per member, so an overwrite is the intended write. */
export async function putWindow(stored: StoredWindow): Promise<void> {
  const item = StoredWindow.parse(stored);
  await ddb().send(
    new PutCommand({
      TableName: table(),
      Item: { ...keys.window(item.memberId), entity: 'Window', ...item },
    }),
  );
}
