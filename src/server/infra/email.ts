import type { Ctx } from '../context.js';
import { all, newId, run } from './db.js';

export interface Email {
  to: string;
  subject: string;
  body: string;
  /** NFR-03: akut notis ska vara accepterad av e-postleverantören inom 30 s. */
  urgent?: boolean;
}

/** Köar e-post i samma transaktion som tillståndsändringen som orsakar den. */
export function queueEmail(ctx: Ctx, email: Email): void {
  run(
    ctx.db,
    `INSERT INTO email_outbox (id, to_email, subject, body, urgent, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    newId('mail'),
    email.to,
    email.subject,
    email.body,
    email.urgent ? 1 : 0,
    ctx.clock.nowIso(),
  );
}

export function queueEmails(ctx: Ctx, recipients: string[], email: Omit<Email, 'to'>): void {
  for (const to of new Set(recipients)) queueEmail(ctx, { ...email, to });
}

export interface EmailSender {
  send(email: Email): Promise<void>;
}

/** Utvecklingsavsändare: loggar i stället för att skicka. Byts mot SMTP/API-leverantör i drift. */
export class ConsoleEmailSender implements EmailSender {
  async send(email: Email): Promise<void> {
    console.log(`[e-post${email.urgent ? ', AKUT' : ''}] till ${email.to}: ${email.subject}`);
  }
}

/** Skickar köad e-post, akuta först. */
export async function deliverPendingEmails(ctx: Ctx, sender: EmailSender): Promise<number> {
  const pending = all<{ id: string; to_email: string; subject: string; body: string; urgent: number }>(
    ctx.db,
    `SELECT id, to_email, subject, body, urgent FROM email_outbox WHERE sent_at IS NULL
     ORDER BY urgent DESC, created_at LIMIT 100`,
  );
  for (const m of pending) {
    await sender.send({ to: m.to_email, subject: m.subject, body: m.body, urgent: m.urgent === 1 });
    run(ctx.db, `UPDATE email_outbox SET sent_at = ? WHERE id = ?`, ctx.clock.nowIso(), m.id);
  }
  return pending.length;
}
