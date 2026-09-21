import { Hono } from 'hono';
import {
  clearOtp,
  extractOtpFromText,
  getAllActiveOtps,
  getOtp,
  storeOtp,
  waitForOtp,
} from '../services/otpService.ts';

export const otpRouter = new Hono();

/**
 * POST /api/otp
 * Ingest OTP from webhook (Cloudflare Email Worker, SMTP receiver, or script)
 * Body: { email, otp } OR { to, body, subject }
 */
otpRouter.post('/', async (c) => {
  try {
    const data = await c.req.json().catch(() => ({}));
    let email = data.email || data.to || data.recipient || '';
    let otp = data.otp || '';

    // If OTP is not directly provided, attempt to extract from body or raw text
    if (!otp) {
      const content = `${data.subject || ''}\n${data.body || ''}\n${data.text || ''}\n${data.raw || ''}`;
      const extracted = extractOtpFromText(content);
      if (extracted) {
        otp = extracted;
      }
    }

    if (!email || !otp) {
      return c.json(
        {
          success: false,
          error: 'Missing email/to or could not extract OTP code',
          received: { email, hasOtp: !!otp },
        },
        400,
      );
    }

    const entry = storeOtp(email, otp, data.source || 'webhook');
    return c.json({
      success: true,
      email: entry.email,
      otp: entry.otp,
      expiresAt: entry.expiresAt,
    });
  } catch (err: any) {
    return c.json({ success: false, error: err.message }, 500);
  }
});

/**
 * GET /api/otp
 * Check if OTP is available for an email
 */
otpRouter.get('/', (c) => {
  const email = c.req.query('email');
  if (!email) {
    // If no email query, return list of active OTPs (masked)
    const list = getAllActiveOtps().map((o) => ({
      email: o.email,
      otpMasked: o.otp.slice(0, 2) + '****',
      receivedAt: o.receivedAt,
      expiresAt: o.expiresAt,
    }));
    return c.json({ count: list.length, otps: list });
  }

  const otp = getOtp(email);
  if (otp) {
    return c.json({ success: true, email, otp });
  }

  return c.json({ success: false, waiting: true, message: 'OTP not yet received' }, 404);
});

/**
 * GET /api/otp/poll
 * Long-poll for OTP (waits up to `timeout` seconds)
 */
otpRouter.get('/poll', async (c) => {
  const email = c.req.query('email');
  if (!email) {
    return c.json({ success: false, error: 'email query parameter is required' }, 400);
  }

  const timeoutSec = Math.min(parseInt(c.req.query('timeout') || '30', 10), 120);
  const otp = await waitForOtp(email, timeoutSec * 1000);

  if (otp) {
    return c.json({ success: true, email, otp });
  }

  return c.json({ success: false, timeout: true, error: 'Timed out waiting for OTP' }, 408);
});

/**
 * DELETE /api/otp
 * Clear OTP for an email
 */
otpRouter.delete('/', (c) => {
  const email = c.req.query('email');
  if (!email) {
    return c.json({ success: false, error: 'email query parameter is required' }, 400);
  }

  const cleared = clearOtp(email);
  return c.json({ success: true, email, cleared });
});
