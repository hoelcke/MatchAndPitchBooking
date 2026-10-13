import type { Db } from './infra/db.js';
import type { Clock } from './infra/clock.js';

/** Det som alla tjänster behöver: databas och klocka. */
export interface Ctx {
  db: Db;
  clock: Clock;
}
