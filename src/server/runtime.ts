// Bakgrundsarbete: outbox-leverans, e-post och tidsstyrda övergångar.
import type { Ctx } from './context.js';
import { Dispatcher } from './infra/outbox.js';
import { deliverPendingEmails, type EmailSender } from './infra/email.js';
import { onMatchCompleted, runReviewDeadlines } from './modules/fairplay.js';
import * as matches from './modules/matches.js';
import * as reservations from './modules/reservations.js';

export function createDispatcher(): Dispatcher {
  return (
    new Dispatcher()
      .register('PROCESS_A', matches.onEvent)
      .register('PROCESS_B', reservations.onEvent)
      .register('PROCESS_C', (ctx, event) => (event.eventType === 'MATCH_COMPLETED' ? onMatchCompleted(ctx, event) : 'IGNORED'))
      // Lagprofilen räknas om av Process C i samma transaktion som publiceringen; eventet kvitteras här.
      .register('TEAM_PROFILE', () => 'HANDLED')
  );
}

export class Runtime {
  private timers: NodeJS.Timeout[] = [];
  private busy = false;

  constructor(
    private ctx: Ctx,
    private dispatcher: Dispatcher,
    private sender: EmailSender,
  ) {}

  /** Levererar outbox och e-post. Anropas efter varje ändrande request och periodiskt. */
  async flush(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      this.dispatcher.dispatch(this.ctx);
      await deliverPendingEmails(this.ctx, this.sender);
    } finally {
      this.busy = false;
    }
  }

  /** Tidsstyrda övergångar: utgång, påminnelser, 14-dagarsfristen och recensionsfrister. */
  async tick(): Promise<{ expired: number; reminders: number; revoked: number; reviewMatches: number }> {
    // Leverera väntande event först, så att t.ex. ett RESERVATION_ACCEPTED hinner fram före 14-dagarsfristen.
    await this.flush();
    const r = matches.runMatchTimers(this.ctx);
    const b = reservations.runReservationDeadlines(this.ctx);
    const reviewMatches = runReviewDeadlines(this.ctx);
    await this.flush();
    return { expired: r.expired, reminders: r.reminders + b.reminders, revoked: b.revoked, reviewMatches };
  }

  start(): void {
    // NFR-03: akut e-post inom 30 s, övrigt inom 60 s.
    this.timers.push(setInterval(() => void this.flush().catch(console.error), 5_000));
    this.timers.push(setInterval(() => void this.tick().catch(console.error), 30_000));
  }

  stop(): void {
    this.timers.forEach(clearInterval);
  }
}
