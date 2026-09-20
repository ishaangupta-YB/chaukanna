import { afterEach, describe, expect, it } from 'vitest';
import { POST } from './route';

/**
 * The demo route is an authentication bypass, so what is worth asserting here is that it does not
 * exist unless somebody turned it on, and that it is not reachable from another site. The seeding
 * itself needs DynamoDB and Secrets Manager and is checked by hand; the gates are checked here.
 *
 * Note: this file imports only `./route`. Importing another route segment's module from inside a
 * route folder tangles the dev server's chunk graph and makes both routes 500 at runtime.
 */

function post(headers?: Record<string, string>): Request {
  return new Request('http://localhost:3000/api/demo/start', { method: 'POST', headers });
}

const SAME_ORIGIN = { origin: 'http://localhost:3000' };

afterEach(() => {
  delete process.env.DEMO_MODE;
  delete process.env.APP_URL;
});

describe('POST /api/demo/start', () => {
  it('answers 404 unless DEMO_MODE is exactly "on"', async () => {
    for (const value of [undefined, 'off', 'true', '1', 'ON']) {
      if (value === undefined) delete process.env.DEMO_MODE;
      else process.env.DEMO_MODE = value;
      const response = await POST(post(SAME_ORIGIN));
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: 'not_found' });
    }
  });

  it('refuses a cross-site post even with DEMO_MODE on', async () => {
    process.env.DEMO_MODE = 'on';
    process.env.APP_URL = 'http://localhost:3000';
    const response = await POST(post({ origin: 'https://evil.example' }));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'origin_mismatch' });
  });

  it('refuses a cross-site form navigation, which carries fetch metadata and no Origin', async () => {
    process.env.DEMO_MODE = 'on';
    process.env.APP_URL = 'http://localhost:3000';
    for (const site of ['cross-site', 'same-site', 'none']) {
      const response = await POST(post({ 'sec-fetch-site': site }));
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({ error: 'origin_mismatch' });
    }
  });

  it('refuses a post carrying neither Origin nor fetch metadata', async () => {
    process.env.DEMO_MODE = 'on';
    process.env.APP_URL = 'http://localhost:3000';
    const response = await POST(post());
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'origin_missing' });
  });
});
