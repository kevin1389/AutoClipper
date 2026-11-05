import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './env';

/**
 * Transactional email for account verification and password resets.
 *
 * Delivery uses Resend's HTTPS API (no SMTP, no SDK) when RESEND_API_KEY and
 * EMAIL_FROM are set. For automated tests, AC_MAIL_OUTBOX=1 writes messages to
 * a JSONL file under the data directory instead of contacting a provider. That
 * mode is opt-in by the operator and the outbox is never exposed over HTTP.
 */

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export type MailProvider = 'resend' | 'outbox' | 'none';

export interface MailDelivery {
  configured: boolean;
  provider: MailProvider;
  from: string | null;
  reason: string | null;
}

export function mailDelivery(): MailDelivery {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = (process.env.EMAIL_FROM ?? process.env.MAIL_FROM)?.trim();
  if (apiKey && from) {
    return { configured: true, provider: 'resend', from, reason: null };
  }
  if (process.env.AC_MAIL_OUTBOX === '1') {
    return {
      configured: true,
      provider: 'outbox',
      from: from || 'AutoClipper <no-reply@localhost>',
      reason: null,
    };
  }
  if (apiKey && !from) {
    return {
      configured: false,
      provider: 'none',
      from: null,
      reason: 'RESEND_API_KEY is set but EMAIL_FROM is missing.',
    };
  }
  return {
    configured: false,
    provider: 'none',
    from: null,
    reason: 'Email delivery is not configured on this deployment.',
  };
}

/** Sends a message, or returns false when no provider is configured. */
export async function sendMail(message: MailMessage): Promise<boolean> {
  const delivery = mailDelivery();
  if (!delivery.configured) return false;

  if (delivery.provider === 'outbox') {
    const dir = path.join(config().dataDir, 'mail-outbox');
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(
      path.join(dir, 'outbox.jsonl'),
      `${JSON.stringify({ ...message, from: delivery.from, sentAt: new Date().toISOString() })}\n`,
      'utf8',
    );
    console.log(`[mail:outbox] ${message.to} — ${message.subject}`);
    return true;
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.RESEND_API_KEY?.trim()}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: delivery.from,
      to: [message.to],
      subject: message.subject,
      text: message.text,
      html: message.html,
    }),
    signal: AbortSignal.timeout(12_000),
    cache: 'no-store',
  });

  if (!response.ok) {
    // The provider body can contain the recipient address, so only the status
    // is logged; the account flow itself stays usable and can resend.
    throw new Error(`Resend responded with HTTP ${response.status}`);
  }
  return true;
}

/** Delivery failures are logged without message bodies or tokens. */
export async function trySendMail(message: MailMessage): Promise<boolean> {
  try {
    return await sendMail(message);
  } catch (error) {
    console.error(`[mail] delivery to ${message.to} failed: ${(error as Error).message}`);
    return false;
  }
}
