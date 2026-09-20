import { config } from '@/lib/config';
import { describeTable } from '@/lib/db';
import { json } from '@/lib/http';
import { errorFields, log } from '@/lib/log';

export const dynamic = 'force-dynamic';

/** { ok, region, table }. Fails loudly when the compute role or config is missing. */
export async function GET() {
  try {
    const { table, status } = await describeTable();
    return json({ ok: true, region: config.region, table, status });
  } catch (error) {
    log.error('health.failed', errorFields(error));
    return json({ ok: false, error: error instanceof Error ? error.name : 'unknown' }, 500);
  }
}
