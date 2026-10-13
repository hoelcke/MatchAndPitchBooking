import type { Ctx } from '../context.js';
import { newId, run } from './db.js';

export const SYSTEM_USER = 'system';

/**
 * NFR-05: varje statusövergång ger en rad. userId är pseudonymt (internt ID),
 * inga namn, e-postadresser eller telefonnummer.
 */
export function audit(
  ctx: Ctx,
  entry: { eventId?: string; userId: string; entityType: string; entityId: string; transition: string },
): string {
  const eventId = entry.eventId ?? newId('evt');
  run(
    ctx.db,
    `INSERT INTO audit_log (id, event_id, user_id, entity_type, entity_id, transition, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    newId('aud'),
    eventId,
    entry.userId,
    entry.entityType,
    entry.entityId,
    entry.transition,
    ctx.clock.nowIso(),
  );
  return eventId;
}
