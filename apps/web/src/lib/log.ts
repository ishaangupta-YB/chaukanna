/**
 * One structured JSON line per meaningful event. Never pass names, emails, tokens, audio or
 * transcript text in `fields`: ids only. Drill events always carry `drillId`.
 */

type Level = 'info' | 'warn' | 'error';
type Fields = Record<string, string | number | boolean | null | undefined>;

function write(level: Level, event: string, fields: Fields = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  (level === 'info' ? process.stdout : process.stderr).write(`${line}\n`);
}

export const log = {
  info: (event: string, fields?: Fields) => write('info', event, fields),
  warn: (event: string, fields?: Fields) => write('warn', event, fields),
  error: (event: string, fields?: Fields) => write('error', event, fields),
};

/** Error name and message only. Stack traces and SDK payloads stay out of the log line. */
export function errorFields(error: unknown): Fields {
  if (error instanceof Error) return { errorName: error.name, errorMessage: error.message.slice(0, 300) };
  return { errorName: 'unknown' };
}
