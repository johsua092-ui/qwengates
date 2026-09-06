import { Hono } from 'hono';
import { generateEmail, getInbox, pollInbox } from '../services/tempEmail.ts';

export const tempEmailRouter = new Hono();

tempEmailRouter.get('/generate', async (c) => {
  try {
    const domain = c.req.query('domain') || '';
    const username = c.req.query('username') || '';
    const result = await generateEmail(domain, username);
    return c.json(result);
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

tempEmailRouter.get('/inbox', async (c) => {
  try {
    const target = c.req.query('target');
    if (!target) {
      return c.json({ success: false, error: 'target query param is required' }, 400);
    }
    const result = await getInbox(target);
    return c.json(result);
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

tempEmailRouter.get('/poll', async (c) => {
  try {
    const target = c.req.query('target');
    if (!target) {
      return c.json({ success: false, error: 'target query param is required' }, 400);
    }
    const intervalStr = c.req.query('interval');
    const maxAttemptsStr = c.req.query('maxAttempts');
    
    const intervalMs = intervalStr ? parseInt(intervalStr, 10) * 1000 : 5000;
    const maxAttempts = maxAttemptsStr ? parseInt(maxAttemptsStr, 10) : 10;

    const result = await pollInbox(target, { intervalMs, maxAttempts });
    return c.json(result);
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});
