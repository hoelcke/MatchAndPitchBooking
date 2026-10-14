// Process B: Planbokning (avsnitt 3.2, FR-B-201–206). Kansliets kö för helgtider i Spår 1.
// Process B pratar med Process A bara via outbox-event (avsnitt 4.0).
import type { Ctx } from '../context.js';
import type {
  GameFormat,
  OutboxEvent,
  ReservationEntity,
  ReservationOpponent,
  ReservationStatus,
  Team,
  TeamCategory,
  User,
} from '../../shared/types.js';
import { addDaysToDate, addMinutes, formatDateTime, localToUtc, utcToLocal } from '../../shared/time.js';
import { all, newId, one, run, tx, type SqlParam } from '../infra/db.js';
import { audit, SYSTEM_USER } from '../infra/audit.js';
import { emit } from '../infra/outbox.js';
import { queueEmails } from '../infra/email.js';
import { AppError, badRequest, conflict, notFound } from '../infra/errors.js';
import { emailsByRole, getTeam, publicTeam, teamLeaderEmails } from './identity.js';
import { getPitchWithFacility } from './masterdata.js';

/** BR-03: motståndare ska vara vald senast 14 dagar före matchdatum kl 23:59:59. */
export const DEADLINE_DAYS = 14;
/** AC-202.1: påminnelse när det är 18 dagar kvar till matchdatum. */
export const REMINDER_DAYS = 18;
/** 4.3 / 4.7: orsaken är obligatorisk, högst 200 tecken. */
export const REASON_MAX_LENGTH = 200;

/** Reservationer som håller en plantid. Övriga lägen har frigjort den. */
const HOLDING: ReservationStatus[] = ['RESERVED', 'ACCEPTED'];

// ---------- Persistens ----------

interface ReservationRow {
  id: string;
  match_id: string;
  home_team_id: string;
  requested_date: string;
  time_window: string;
  game_format: GameFormat;
  birth_year: number;
  category: TeamCategory;
  facility_id: string | null;
  pitch_id: string | null;
  facility_name: string | null;
  pitch_name: string | null;
  start_time: string | null;
  end_time: string | null;
  opponent: string | null;
  status: ReservationStatus;
  decision_reason: string | null;
  deadline_at: string;
  reserved_at: string | null;
  created_at: string;
  updated_at: string;
}

const toReservation = (r: ReservationRow): ReservationEntity => ({
  id: r.id,
  matchId: r.match_id,
  homeTeamId: r.home_team_id,
  requestedDate: r.requested_date,
  timeWindow: r.time_window,
  gameFormat: r.game_format,
  birthYear: r.birth_year,
  category: r.category,
  allocatedPitch:
    r.pitch_id && r.start_time && r.end_time
      ? {
          facilityId: r.facility_id!,
          pitchId: r.pitch_id,
          facilityName: r.facility_name!,
          pitchName: r.pitch_name!,
          startTime: r.start_time,
          endTime: r.end_time,
        }
      : undefined,
  opponent: r.opponent ? JSON.parse(r.opponent) : undefined,
  status: r.status,
  decisionReason: r.decision_reason ?? undefined,
  deadlineAt: r.deadline_at,
  reservedAt: r.reserved_at ?? undefined,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function getReservation(ctx: Ctx, id: string): ReservationEntity | undefined {
  const r = one<ReservationRow>(ctx.db, `SELECT * FROM reservations WHERE id = ?`, id);
  return r && toReservation(r);
}

export function getReservationForMatch(ctx: Ctx, matchId: string): ReservationEntity | undefined {
  const r = one<ReservationRow>(ctx.db, `SELECT * FROM reservations WHERE match_id = ?`, matchId);
  return r && toReservation(r);
}

function requireReservation(ctx: Ctx, id: string): ReservationEntity {
  const r = getReservation(ctx, id);
  if (!r) throw notFound('Reservationen finns inte');
  return r;
}

/** Fristen i BR-03: matchdatum minus 14 dagar kl 23:59:59 Europe/Stockholm, lagrad i UTC. */
export function deadlineFor(requestedDate: string): string {
  return localToUtc(addDaysToDate(requestedDate, -DEADLINE_DAYS), '23:59:59');
}

/** AC-202.1: tidpunkten då det är 18 dagar kvar till matchdatum (lokal midnatt). */
export function reminderAtFor(requestedDate: string): string {
  return localToUtc(addDaysToDate(requestedDate, -REMINDER_DAYS), '00:00');
}

/**
 * BR-16: statusövergång med kontroll av förväntad nuvarande status i samma transaktion.
 * Skriver en rad i revisionsloggen (NFR-05).
 */
function transitionReservation(
  ctx: Ctx,
  res: ReservationEntity,
  from: ReservationStatus[],
  to: ReservationStatus,
  opts: { userId: string; rule: string; eventId?: string; set?: Record<string, SqlParam>; conflictMessage?: string },
): void {
  const set: Record<string, SqlParam> = { ...(opts.set ?? {}), status: to, updated_at: ctx.clock.nowIso() };
  const cols = Object.keys(set);
  const changed = from.includes(res.status)
    ? run(
        ctx.db,
        `UPDATE reservations SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ? AND status = ?`,
        ...cols.map((c) => set[c]),
        res.id,
        res.status,
      )
    : 0;
  if (changed !== 1) throw conflict(opts.conflictMessage ?? 'Reservationen har ändrats av någon annan. Ladda om sidan och försök igen.');
  audit(ctx, {
    eventId: opts.eventId,
    userId: opts.userId,
    entityType: 'Reservation',
    entityId: res.id,
    transition: `${res.status} -> ${to} (${opts.rule})`,
  });
}

/** Avsnitt 3: event som inte passar nuvarande läge ignoreras och loggas. */
function ignore(ctx: Ctx, event: OutboxEvent, entityId: string, status: string): 'IGNORED' {
  audit(ctx, {
    eventId: event.eventId,
    userId: SYSTEM_USER,
    entityType: 'Reservation',
    entityId,
    transition: `IGNORED ${event.eventType} (status ${status})`,
  });
  return 'IGNORED';
}

const teamName = (t: Team) => `${t.clubName} ${t.name}`;

function validateReason(reason: unknown): string {
  const r = String(reason ?? '').trim();
  if (!r) throw badRequest('Ange en orsak');
  if (r.length > REASON_MAX_LENGTH) throw badRequest(`Orsaken får vara högst ${REASON_MAX_LENGTH} tecken`);
  return r;
}

// ---------- Mottagning av event från Process A ----------

export function onEvent(ctx: Ctx, event: OutboxEvent): 'HANDLED' | 'IGNORED' {
  switch (event.eventType) {
    case 'REQUEST_RESERVATION':
      return onRequestReservation(ctx, event);
    case 'RESERVATION_ACCEPTED':
      return onAccepted(ctx, event);
    case 'RESERVATION_WITHDRAWN':
      return onWithdrawn(ctx, event);
    case 'MATCH_COMPLETED':
      return onClosed(ctx, event, 'COMPLETED', 'B11');
    case 'MATCH_EXPIRED':
      return onClosed(ctx, event, 'CLOSED_EXPIRED', 'B12');
    default:
      return 'IGNORED';
  }
}

interface RequestReservationPayload {
  homeTeamId: string;
  requestedDate: string;
  preferredTimeWindow: string;
  gameFormat: GameFormat;
  birthYear: number;
  category: TeamCategory;
}

/** B1: REQUEST_RESERVATION skapar ett ärende i kansliets kö. */
function onRequestReservation(ctx: Ctx, event: OutboxEvent): 'HANDLED' | 'IGNORED' {
  if (getReservationForMatch(ctx, event.matchId)) return 'IGNORED';
  const p = event.payload as RequestReservationPayload;
  const id = newId('res');
  const now = ctx.clock.nowIso();
  run(
    ctx.db,
    `INSERT INTO reservations (id, match_id, home_team_id, requested_date, time_window, game_format, birth_year,
       category, status, deadline_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'REQUESTED', ?, ?, ?)`,
    id,
    event.matchId,
    p.homeTeamId,
    p.requestedDate,
    p.preferredTimeWindow,
    p.gameFormat,
    p.birthYear,
    p.category,
    deadlineFor(p.requestedDate),
    now,
    now,
  );
  audit(ctx, { eventId: event.eventId, userId: SYSTEM_USER, entityType: 'Reservation', entityId: id, transition: '(start) -> REQUESTED (B1)' });
  const team = getTeam(ctx, p.homeTeamId);
  // Notifieringsmatris #3
  queueEmails(ctx, emailsByRole(ctx, 'OFFICE'), {
    subject: `Ny förfrågan om helgtid: ${team ? teamName(team) : ''} ${p.requestedDate}`,
    body: `${team ? teamName(team) : 'Ett lag'} önskar en plan ${p.requestedDate} kl ${p.preferredTimeWindow}. Hantera förfrågan i kansliets kö.`,
  });
  return 'HANDLED';
}

/** B5 / B8: motståndare vald. Från RESERVED låses bokningen, från ACCEPTED skrivs motståndaren över. */
function onAccepted(ctx: Ctx, event: OutboxEvent): 'HANDLED' | 'IGNORED' {
  const res = getReservationForMatch(ctx, event.matchId);
  if (!res) return 'IGNORED';
  if (!HOLDING.includes(res.status)) return ignore(ctx, event, res.id, res.status);
  const p = event.payload as { opponent: ReservationOpponent };
  transitionReservation(ctx, res, HOLDING, 'ACCEPTED', {
    userId: SYSTEM_USER,
    rule: res.status === 'RESERVED' ? 'B5' : 'B8',
    eventId: event.eventId,
    set: { opponent: JSON.stringify(p.opponent) },
  });
  return 'HANDLED';
}

/** B4 / B6 / B9: hemmalaget avbokar. Plantiden frigörs direkt. */
function onWithdrawn(ctx: Ctx, event: OutboxEvent): 'HANDLED' | 'IGNORED' {
  const res = getReservationForMatch(ctx, event.matchId);
  if (!res) return 'IGNORED';
  const rule = ({ REQUESTED: 'B4', RESERVED: 'B6', ACCEPTED: 'B9' } as Partial<Record<ReservationStatus, string>>)[res.status];
  if (!rule) return ignore(ctx, event, res.id, res.status);
  transitionReservation(ctx, res, ['REQUESTED', 'RESERVED', 'ACCEPTED'], 'WITHDRAWN_BY_HOME', {
    userId: SYSTEM_USER,
    rule,
    eventId: event.eventId,
  });
  return 'HANDLED';
}

/** B11 / B12: matchen genomförd eller utgången. Reservationen arkiveras. */
function onClosed(ctx: Ctx, event: OutboxEvent, to: ReservationStatus, rule: string): 'HANDLED' | 'IGNORED' {
  const res = getReservationForMatch(ctx, event.matchId);
  if (!res) return 'IGNORED';
  if (res.status !== 'ACCEPTED') return ignore(ctx, event, res.id, res.status);
  transitionReservation(ctx, res, ['ACCEPTED'], to, { userId: SYSTEM_USER, rule, eventId: event.eventId });
  return 'HANDLED';
}

// ---------- Kansliets åtgärder ----------

export interface AllocateInput {
  pitchId: string;
  startTime: string; // HH:mm lokalt på det begärda datumet
  /** Längd i minuter. Utelämnad: samma längd som den önskade tiden. */
  durationMinutes?: number;
  /** AC-201.2: överlapp ger en varning som kansliet kan åsidosätta. */
  overrideOverlap?: boolean;
}

export interface Overlap {
  reservationId: string;
  teamName: string;
  startTime: string;
  endTime: string;
}

/** Bokningar som håller samma plan under samma tid. */
function findOverlaps(ctx: Ctx, pitchId: string, startTime: string, endTime: string, excludeId: string): Overlap[] {
  const ph = HOLDING.map(() => '?').join(',');
  return all<ReservationRow>(
    ctx.db,
    `SELECT * FROM reservations WHERE pitch_id = ? AND status IN (${ph}) AND id != ? AND start_time < ? AND end_time > ?
     ORDER BY start_time`,
    pitchId,
    ...HOLDING,
    excludeId,
    endTime,
    startTime,
  ).map((r) => {
    const team = getTeam(ctx, r.home_team_id);
    return { reservationId: r.id, teamName: team ? teamName(team) : '', startTime: r.start_time!, endTime: r.end_time! };
  });
}

/** Längden på den önskade tiden i minuter, t.ex. 60 för "10:00-11:00". */
export function requestedMinutes(res: Pick<ReservationEntity, 'requestedDate' | 'timeWindow'>): number {
  const [from, to] = res.timeWindow.split('-');
  return (Date.parse(localToUtc(res.requestedDate, to)) - Date.parse(localToUtc(res.requestedDate, from))) / 60_000;
}

/** B2 / AC-201.2: kansliet tilldelar plan. */
export function allocatePitch(ctx: Ctx, user: User, reservationId: string, input: AllocateInput): ReservationEntity {
  return tx(ctx.db, () => {
    const res = requireReservation(ctx, reservationId);
    // AC-201.3: ett avbokat ärende kan inte tilldelas.
    if (res.status === 'WITHDRAWN_BY_HOME') throw conflict('Hemmalaget har avbokat förfrågan');
    if (res.status !== 'REQUESTED') throw conflict('Förfrågan är redan hanterad');

    const venue = getPitchWithFacility(ctx, String(input.pitchId ?? ''));
    if (!venue || !venue.pitch.active || !venue.facility.active) throw badRequest('Välj en aktiv plan ur listan');
    if (!venue.pitch.supportedFormats.includes(res.gameFormat)) throw badRequest('Planen stödjer inte den begärda spelformen');
    if (!/^\d{2}:\d{2}$/.test(input.startTime ?? '')) throw badRequest('Starttid måste anges');
    const durationMinutes = input.durationMinutes === undefined ? requestedMinutes(res) : Number(input.durationMinutes);
    if (!Number.isInteger(durationMinutes) || durationMinutes < 10 || durationMinutes > 180)
      throw badRequest('Längden måste vara 10–180 minuter');
    const startTime = localToUtc(res.requestedDate, input.startTime);
    const endTime = addMinutes(startTime, durationMinutes);
    if (utcToLocal(endTime).date !== res.requestedDate) throw badRequest('Tiden måste sluta samma dag');

    const overlaps = findOverlaps(ctx, venue.pitch.id, startTime, endTime, res.id);
    if (overlaps.length > 0 && !input.overrideOverlap) {
      const list = overlaps.map((o) => `${o.teamName} ${formatDateTime(o.startTime)}`).join(', ');
      throw new AppError(409, 'OVERLAP', `Planen är redan bokad under den tiden: ${list}`);
    }

    const event = emit(ctx, 'RESERVATION_RESERVED', res.matchId, {
      reservationId: res.id,
      facilityId: venue.facility.id,
      pitchId: venue.pitch.id,
      facilityName: venue.facility.name,
      pitchName: venue.pitch.name,
      startTime,
      endTime,
      deadlineAt: res.deadlineAt,
    });
    transitionReservation(ctx, res, ['REQUESTED'], 'RESERVED', {
      userId: user.id,
      rule: overlaps.length > 0 ? 'B2, överlapp åsidosatt' : 'B2',
      eventId: event.eventId,
      set: {
        facility_id: venue.facility.id,
        pitch_id: venue.pitch.id,
        facility_name: venue.facility.name,
        pitch_name: venue.pitch.name,
        start_time: startTime,
        end_time: endTime,
        reserved_at: ctx.clock.nowIso(),
      },
    });
    return getReservation(ctx, res.id)!;
  });
}

/** B3 / AC-204.1: kansliet avslår en förfrågan med orsak. */
export function rejectRequest(ctx: Ctx, user: User, reservationId: string, reason: string): ReservationEntity {
  const r = validateReason(reason);
  return tx(ctx.db, () => {
    const res = requireReservation(ctx, reservationId);
    if (res.status !== 'REQUESTED') throw conflict('Förfrågan är redan hanterad');
    const event = emit(ctx, 'RESERVATION_REJECTED', res.matchId, { reservationId: res.id, reason: r });
    transitionReservation(ctx, res, ['REQUESTED'], 'REJECTED_BY_OFFICE', {
      userId: user.id,
      rule: 'B3',
      eventId: event.eventId,
      set: { decision_reason: r },
    });
    return getReservation(ctx, res.id)!;
  });
}

/** B10 / AC-206.1: kansliet ställer in en reserverad eller accepterad bokning. */
export function cancelByOffice(ctx: Ctx, user: User, reservationId: string, reason: string): ReservationEntity {
  const r = validateReason(reason);
  return tx(ctx.db, () => {
    const res = requireReservation(ctx, reservationId);
    if (!HOLDING.includes(res.status)) throw conflict('Bara reserverade eller accepterade bokningar kan ställas in');
    const event = emit(ctx, 'RESERVATION_CANCELLED_BY_OFFICE', res.matchId, { reservationId: res.id, reason: r });
    transitionReservation(ctx, res, HOLDING, 'CANCELLED_BY_OFFICE', {
      userId: user.id,
      rule: 'B10',
      eventId: event.eventId,
      set: { decision_reason: r },
    });
    return getReservation(ctx, res.id)!;
  });
}

// ---------- Kansliets översikt (FR-B-201) ----------

export type ReservationView = ReservationEntity & { homeTeam: Team; reminderAt: string };

const toView = (ctx: Ctx, r: ReservationEntity): ReservationView => ({
  ...r,
  homeTeam: publicTeam(getTeam(ctx, r.homeTeamId)!),
  reminderAt: reminderAtFor(r.requestedDate),
});

export function listForOffice(ctx: Ctx): { queue: ReservationView[]; active: ReservationView[]; closed: ReservationView[] } {
  const rows = (sql: string) => all<ReservationRow>(ctx.db, sql).map((r) => toView(ctx, toReservation(r)));
  return {
    // AC-201.1: ärenden i REQUESTED sorterade på datum.
    queue: rows(`SELECT * FROM reservations WHERE status = 'REQUESTED' ORDER BY requested_date, time_window, created_at`),
    active: rows(`SELECT * FROM reservations WHERE status IN ('RESERVED','ACCEPTED') ORDER BY start_time`),
    closed: rows(
      `SELECT * FROM reservations WHERE status NOT IN ('REQUESTED','RESERVED','ACCEPTED') ORDER BY updated_at DESC LIMIT 50`,
    ),
  };
}

// ---------- Tidsstyrda övergångar (FR-B-202) ----------

/** Körs periodiskt av schemaläggaren. Varje reservation hanteras i en egen transaktion. */
export function runReservationDeadlines(ctx: Ctx): { revoked: number; reminders: number } {
  const now = ctx.clock.nowIso();
  let revoked = 0;
  let reminders = 0;

  // B7 / AC-202.2: ingen accept före fristen. Återkalla automatiskt och frigör plantiden.
  for (const r of all<ReservationRow>(ctx.db, `SELECT * FROM reservations WHERE status = 'RESERVED' AND deadline_at < ?`, now)) {
    const res = toReservation(r);
    try {
      tx(ctx.db, () => {
        const event = emit(ctx, 'RESERVATION_REVOKED', res.matchId, { reservationId: res.id, reason: 'DEADLINE_EXPIRED_14_DAYS' });
        transitionReservation(ctx, res, ['RESERVED'], 'REVOKED_BY_DEADLINE', { userId: SYSTEM_USER, rule: 'B7', eventId: event.eventId });
      });
      revoked++;
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
    }
  }

  // AC-202.1: påminnelse 18 dagar före matchdatum, bara om planen tilldelades före den tidpunkten.
  for (const r of all<ReservationRow>(ctx.db, `SELECT * FROM reservations WHERE status = 'RESERVED'`)) {
    const res = toReservation(r);
    const reminderAt = reminderAtFor(res.requestedDate);
    if (now < reminderAt || !res.reservedAt || res.reservedAt > reminderAt) continue;
    tx(ctx.db, () => {
      const inserted = run(
        ctx.db,
        `INSERT OR IGNORE INTO reminders_sent (match_id, kind, sent_at) VALUES (?, 'RESERVATION_DEADLINE', ?)`,
        res.matchId,
        now,
      );
      if (!inserted) return;
      // Notifieringsmatris #11
      queueEmails(ctx, teamLeaderEmails(ctx, res.homeTeamId), {
        subject: `Påminnelse: välj motståndare före ${formatDateTime(res.deadlineAt)}`,
        body: `Er helgtid ${res.allocatedPitch?.facilityName ?? ''} ${res.allocatedPitch?.pitchName ?? ''} ${res.requestedDate} har ingen vald motståndare än. Välj motståndare senast ${formatDateTime(res.deadlineAt)}, annars återkallas tiden automatiskt (14-dagarsregeln).`,
      });
      reminders++;
    });
  }

  return { revoked, reminders };
}
