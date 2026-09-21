import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { accountsRouter } from '../routes/accounts.ts';

describe('POST /api/accounts/bulk', () => {
  const app = new Hono();
  app.route('/api/accounts', accountsRouter);

  test('rejects empty payload with 400', async () => {
    const res = await app.request('/api/accounts/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain('Invalid payload');
  });

  test('rejects empty raw string with 400', async () => {
    const res = await app.request('/api/accounts/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: '   \n# just a comment\n' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain('No valid accounts found');
  });
});
