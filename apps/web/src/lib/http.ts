import { z } from 'zod';
import { ConfigError } from './config';
import { AppError, badRequest, forbidden } from './errors';
import { errorFields, log } from './log';

export function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(data, { status, headers: { 'cache-control': 'no-store', ...headers } });
}

export async function parseBody<T extends z.ZodType>(request: Request, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw badRequest('invalid_json');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw badRequest('invalid_body');
  return parsed.data;
}

/**
 * Cookie-authenticated writes must come from our own pages. SameSite=Lax cookies already stop
 * cross-site posts; this is the second lock on the same door.
 */
export function assertSameOrigin(request: Request, appUrl: string): void {
  const origin = request.headers.get('origin');
  if (!origin) throw forbidden('origin_missing');
  const allowed = new Set([new URL(appUrl).origin, new URL(request.url).origin]);
  if (!allowed.has(origin)) throw forbidden('origin_mismatch');
}

/** Maps thrown errors to responses. Unknown errors are logged and become a bare 500. */
export async function handle(route: string, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof AppError) {
      if (error.status >= 500) log.error('http.error', { route, code: error.code });
      return json({ error: error.code }, error.status);
    }
    log.error('http.unhandled', { route, ...errorFields(error), config: error instanceof ConfigError });
    return json({ error: 'internal' }, 500);
  }
}
