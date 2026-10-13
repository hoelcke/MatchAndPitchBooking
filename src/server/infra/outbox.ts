// Intern outbox, idempotens och ordning per matchId (avsnitt 4.0, NFR-06).
import type { Ctx } from '../context.js';
import type { OutboxEvent } from '../../shared/types.js';
import { all, newId, one, run, tx } from './db.js';

export type ConsumerName = 'PROCESS_A' | 'PROCESS_B' | 'PROCESS_C' | 'TEAM_PROFILE';

/** Routing enligt tabellen i avsnitt 4.0. */
export function routeTargets(event: Pick<OutboxEvent, 'eventType' | 'payload'>): ConsumerName[] {
  const payload = (event.payload ?? {}) as { reservationId?: string };
  switch (event.eventType) {
    case 'REQUEST_RESERVATION':
    case 'RESERVATION_ACCEPTED':
    case 'RESERVATION_WITHDRAWN':
    case 'MATCH_EXPIRED':
      return ['PROCESS_B'];
    case 'RESERVATION_RESERVED':
    case 'RESERVATION_REJECTED':
    case 'RESERVATION_REVOKED':
    case 'RESERVATION_CANCELLED_BY_OFFICE':
      return ['PROCESS_A'];
    case 'MATCH_COMPLETED':
      // Spår 2 saknar reservationId och dirigeras bara till Process C.
      return payload.reservationId ? ['PROCESS_B', 'PROCESS_C'] : ['PROCESS_C'];
    case 'REVIEW_AGGREGATED':
      return ['TEAM_PROFILE'];
    default:
      return [];
  }
}

/**
 * Skriver ett event i outboxen. Måste anropas inne i samma transaktion som tillståndsändringen.
 * Gemensamma fält (eventId, sequence, occurredAt, matchId) läggs till här.
 */
export function emit<P extends object>(ctx: Ctx, eventType: string, matchId: string, payload: P): OutboxEvent {
  const last = one<{ seq: number | null }>(
    ctx.db,
    `SELECT MAX(sequence) AS seq FROM outbox_events WHERE match_id = ?`,
    matchId,
  );
  const sequence = (last?.seq ?? 0) + 1;
  const eventId = newId('evt');
  const occurredAt = ctx.clock.nowIso();
  const fullPayload = { eventId, sequence, occurredAt, matchId, ...payload };
  run(
    ctx.db,
    `INSERT INTO outbox_events (event_id, event_type, match_id, sequence, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    eventId,
    eventType,
    matchId,
    sequence,
    JSON.stringify(fullPayload),
    occurredAt,
  );
  return { eventId, eventType, matchId, sequence, payload: fullPayload, createdAt: occurredAt };
}

export type EventHandler = (ctx: Ctx, event: OutboxEvent) => 'HANDLED' | 'IGNORED';

/**
 * Levererar outbox-event till registrerade mottagare.
 * - Varje (mottagare, eventId) behandlas högst en gång (idempotens).
 * - Event för samma matchId behandlas i sekvensordning; misslyckas ett event
 *   väntar senare event för samma match hos den mottagaren.
 * - Mottagare som inte finns i denna version (t.ex. Process B i Spår 2-utkastet) hoppas över.
 */
export class Dispatcher {
  private handlers = new Map<ConsumerName, EventHandler>();

  register(consumer: ConsumerName, handler: EventHandler): this {
    this.handlers.set(consumer, handler);
    return this;
  }

  dispatch(ctx: Ctx): number {
    let delivered = 0;
    // Flera varv eftersom en mottagare kan skapa nya event (t.ex. C -> REVIEW_AGGREGATED).
    for (let round = 0; round < 10; round++) {
      const n = this.dispatchOnce(ctx);
      delivered += n;
      if (n === 0) break;
    }
    return delivered;
  }

  private dispatchOnce(ctx: Ctx): number {
    const rows = all<{ event_id: string; event_type: string; match_id: string; sequence: number; payload: string; created_at: string }>(
      ctx.db,
      `SELECT event_id, event_type, match_id, sequence, payload, created_at FROM outbox_events
       WHERE processed_at IS NULL ORDER BY match_id, sequence`,
    );
    const blocked = new Set<string>(); // `${consumer}:${matchId}`
    let delivered = 0;

    for (const row of rows) {
      const event: OutboxEvent = {
        eventId: row.event_id,
        eventType: row.event_type,
        matchId: row.match_id,
        sequence: row.sequence,
        payload: JSON.parse(row.payload),
        createdAt: row.created_at,
      };
      const targets = routeTargets(event).filter((t) => this.handlers.has(t));
      let allDone = true;

      for (const consumer of targets) {
        const key = `${consumer}:${event.matchId}`;
        if (blocked.has(key)) {
          allDone = false;
          continue;
        }
        const already = one(ctx.db, `SELECT 1 FROM processed_events WHERE consumer = ? AND event_id = ?`, consumer, event.eventId);
        if (already) continue;
        try {
          tx(ctx.db, () => {
            const outcome = this.handlers.get(consumer)!(ctx, event);
            run(
              ctx.db,
              `INSERT INTO processed_events (consumer, event_id, outcome, processed_at) VALUES (?, ?, ?, ?)`,
              consumer,
              event.eventId,
              outcome,
              ctx.clock.nowIso(),
            );
          });
          delivered++;
        } catch (err) {
          console.error(`[outbox] ${consumer} misslyckades med ${event.eventType} ${event.eventId}`, err);
          blocked.add(key);
          allDone = false;
        }
      }

      if (allDone) {
        run(ctx.db, `UPDATE outbox_events SET processed_at = ? WHERE event_id = ?`, ctx.clock.nowIso(), event.eventId);
      }
    }
    return delivered;
  }
}
