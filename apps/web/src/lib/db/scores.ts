import { BatchGetCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, keys, table } from './client';
import { Score } from './models';

/**
 * Score rows, read only.
 *
 * The web app never writes one. `services/scoring` owns every field on it, and the app's job is
 * to show the right part of it to the right person: everything to the learner, the band and the
 * date to their guardian. Keeping the write path out of here is what makes that easy to audit —
 * there is no code in the app that could put a number on a drill.
 */

export async function getScore(drillId: string): Promise<Score | null> {
  const out = await ddb().send(
    new GetCommand({ TableName: table(), Key: keys.score(drillId), ConsistentRead: true }),
  );
  return out.Item ? Score.parse(out.Item) : null;
}

/** DynamoDB's own ceiling on one BatchGetItem. */
const BATCH_LIMIT = 100;

/** Whether a failure is "this role may not call that API" rather than "the table is unwell". */
function isAccessDenied(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name ?? '';
  return name === 'AccessDeniedException' || name === 'AccessDenied';
}

/**
 * One `GetItem` per drill, in parallel.
 *
 * `BatchGetItem` is a separate IAM action and is not implied by `GetItem`, so a least-privilege
 * role can be granted the one and not the other. That combination is invisible until a household
 * actually has a drill, and then it takes out the guardian dashboard and the audit log at once,
 * so the batch read falls back here rather than failing the screen. Both paths read the same
 * rows; only the number of requests differs.
 */
async function getScoresIndividually(drillIds: readonly string[]): Promise<Map<string, Score>> {
  const found = new Map<string, Score>();
  const rows = await Promise.all(drillIds.map((drillId) => getScore(drillId).catch(() => null)));
  for (const row of rows) if (row) found.set(row.drillId, row);
  return found;
}

/**
 * Scores for several drills at once, keyed by `drillId`. The guardian dashboard lists a handful
 * of drills per member and would otherwise do one round trip each.
 *
 * Ids with no score row are simply absent from the map — that is the normal answer for a drill
 * that is still being scored, was never answered, or was cancelled before it rang. A row that
 * fails to parse is dropped rather than thrown, because one malformed verdict must not blank out
 * the dashboard for the whole household. `UnprocessedKeys` is treated the same way and not
 * retried: at one drill per learner per week a throttled read is a band that appears on the next
 * refresh, and a retry loop here would be machinery for a load this product does not have.
 */
export async function listScores(drillIds: readonly string[]): Promise<Map<string, Score>> {
  const found = new Map<string, Score>();
  const unique = [...new Set(drillIds)];
  for (let i = 0; i < unique.length; i += BATCH_LIMIT) {
    const chunk = unique.slice(i, i + BATCH_LIMIT);
    let out;
    try {
      out = await ddb().send(
        new BatchGetCommand({
          RequestItems: { [table()]: { Keys: chunk.map((drillId) => keys.score(drillId)) } },
        }),
      );
    } catch (error) {
      if (!isAccessDenied(error)) throw error;
      for (const [drillId, score] of await getScoresIndividually(chunk)) found.set(drillId, score);
      continue;
    }
    for (const item of out.Responses?.[table()] ?? []) {
      const parsed = Score.safeParse(item);
      if (parsed.success) found.set(parsed.data.drillId, parsed.data);
    }
  }
  return found;
}
