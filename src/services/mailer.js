import { config } from '../config.js';

/**
 * Sends email through Resend (https://resend.com) when RESEND_API_KEY is set,
 * otherwise prints it to the console. Tests swap `mailer.transport` for an
 * in-memory outbox.
 */
export const mailer = {
  transport: null, // set by tests: async (message) => {}

  async send({ to, subject, html, text }) {
    const message = { from: config.emailFrom, to, subject, html, text };
    if (this.transport) return this.transport(message);
    if (!config.resendApiKey) {
      console.log(`\n✉️  [email, not sent – no RESEND_API_KEY] to ${to}: ${subject}\n${text}\n`);
      return;
    }
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.resendApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Resend ${res.status}: ${body.slice(0, 200)}`);
    }
  },
};

/** Fire-and-forget: an email problem must never break an order. */
export function sendInBackground(message) {
  mailer.send(message).catch((err) => console.error('Email failed:', err.message));
}
