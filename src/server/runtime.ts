// Bakgrundsarbete: outbox-leverans, e-post och tidsstyrda övergångar.
import type { Ctx } from './context.js';
import { Dispatcher } from './infra/outbox.js';
import { deliverPendingEmails, type EmailSender } from './infra/email.js';
import { onMatchCompleted } from './modules/fairplay.js';
import { runMatchTimers } from './modules/matches.js';
import { runReviewDeadlines } from './modules/fairplay.js';

export function createDispatcher(): Dispatcher {
  return (
    new Dispatcher()
      .register('PROCESS_C', (ctx, event) => (event.eventType === 'MATCH_COMPLETED' ? onMatchCompleted(ctx, event) : 'IGNORED'))
      // Lagprofilen räknas om av Process C i samma transaktion som publiceringen; eventet kvitteras här.
      .register('TEAM_PROFILE', () => 'HANDLED')
    // PROCESS_A (mottagning av B-event) och PROCESS_B registreras när Spår 1 implementeras.
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

  /** Tidsstyrda övergångar: utgång, påminnelser och recensionsfrister. */
  async tick(): Promise<{ expired: number; reminders: number; reviewMatches: number }> {
    const r = runMatchTimers(this.ctx);
    const reviewMatches = runReviewDeadlines(this.ctx);
    await this.flush();
    return { ...r, reviewMatches };
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
