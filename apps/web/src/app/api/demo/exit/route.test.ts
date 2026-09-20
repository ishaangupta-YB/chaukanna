import { afterEach, describe, expect, it } from 'vitest';
import { POST } from './route';

/** Imports only `./route`: see the note in ../start/route.test.ts. */

function post(headers?: Record<string, string>): Request {
  return new Request('http://localhost:3000/api/demo/exit', { method: 'POST', headers });
}

const SAME_ORIGIN = { origin: 'http://localhost:3000' };

afterEach(() => {
  delete process.env.DEMO_MODE;
  delete process.env.APP_URL;
});

describe('POST /api/demo/exit', () => {
  it('answers 404 unless DEMO_MODE is exactly "on"', async () => {
    for (const value of [undefined, 'off', 'true']) {
      if (value === undefined) delete process.env.DEMO_MODE;
      else process.env.DEMO_MODE = value;
      const response = await POST(post(SAME_ORIGIN));
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: 'not_found' });
    }
  });

  it('refuses a cross-site post', async () => {
    process.env.DEMO_MODE = 'on';
    process.env.APP_URL = 'http://localhost:3000';
    const response = await POST(post({ origin: 'https://evil.example' }));
    expect(response.status).toBe(403);
  });

  it('clears the demo cookie and sends the browser home', async () => {
    process.env.DEMO_MODE = 'on';
    process.env.APP_URL = 'http://localhost:3000';
    const response = await POST(post(SAME_ORIGIN));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('http://localhost:3000/');
    expect(response.headers.get('set-cookie')).toContain('ck_demo=');
    // An expiry in the past is how a delete reaches the browser.
    expect(response.headers.get('set-cookie')).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);
  });
});
