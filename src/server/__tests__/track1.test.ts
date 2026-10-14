import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, all, one } from '../infra/db.js';
import { FixedClock } from '../infra/clock.js';
import type { Ctx } from '../context.js';
import type { User } from '../../shared/types.js';
import * as identity from '../modules/identity.js';
import * as masterdata from '../modules/masterdata.js';
import * as matches from '../modules/matches.js';
import * as reservations from '../modules/reservations.js';
import { createDispatcher } from '../runtime.js';

let ctx: Ctx & { clock: FixedClock };
let office: User, lena: User, anna: User, erik: User, per: User;
let homeTeamId: string, hamTeamId: string, difTeamId: string, pitchId: string, smallPitchId: string;

// Tisdag 2026-10-13. Lördag 2026-11-07 ligger 25 dagar fram, efter sommartidens slut (CET, UTC+1).
function setup() {
  ctx = { db: openDb(':memory:'), clock: new FixedClock(new Date('2026-10-13T08:00:00Z')) };
  office = identity.createUser(ctx, { name: 'Kansli', email: 'k@x.se', role: 'OFFICE' });
  lena = identity.createUser(ctx, { name: 'Lena', email: 'lena@x.se', role: 'TEAM_LEADER' });
  anna = identity.createUser(ctx, { name: 'Anna', email: 'anna@x.se', role: 'TEAM_LEADER' });
  erik = identity.createUser(ctx, { name: 'Erik', email: 'erik@x.se', role: 'TEAM_LEADER' });
  per = identity.createUser(ctx, { name: 'Per', email: 'per@x.se', role: 'TEAM_LEADER' });
  const fac = masterdata.createFacility(ctx, office, { name: 'Skärsätra IP', address: 'Skärsätravägen 50' });
  pitchId = masterdata.createPitch(ctx, office, { facilityId: fac.id, name: 'Plan 2', surface: 'ARTIFICIAL_TURF', supportedFormats: ['7v7_LARGE'] }).id;
  smallPitchId = masterdata.createPitch(ctx, office, { facilityId: fac.id, name: 'Plan 3', surface: 'NATURAL_TURF', supportedFormats: ['5v5'] }).id;
  const home = identity.createTeam(ctx, lena, { isHomeClub: true, name: 'P2015', birthYear: 2015, category: 'BOYS' });
  identity.decideMembership(ctx, office, home.membership.id, true);
  homeTeamId = home.team.id;
  hamTeamId = identity.createTeam(ctx, anna, { isHomeClub: false, clubName: 'Hammarby IF', name: 'P2015', birthYear: 2015, category: 'BOYS' }).team.id;
  difTeamId = identity.createTeam(ctx, erik, { isHomeClub: false, clubName: 'DIF', name: 'P2016', birthYear: 2016, category: 'BOYS' }).team.id;
}

const input = (over: Partial<matches.CreateWeekendSlotInput> = {}): matches.CreateWeekendSlotInput => ({
  homeTeamId,
  phone: '+46701112233',
  date: '2026-11-07',
  startTime: '10:00',
  gameFormat: '7v7_LARGE',
  birthYear: 2015,
  category: 'BOYS',
  openToAdjacentBirthYears: true,
  matchLevel: 'MEDIUM',
  durationMinutes: 90,
  referee: 'HOME_ARRANGES',
  kitColorHome: 'Blå',
  ...over,
});

const dispatch = () => createDispatcher().dispatch(ctx);
const auditRows = (entityId: string) =>
  all<{ transition: string }>(ctx.db, `SELECT transition FROM audit_log WHERE entity_id = ? ORDER BY rowid`, entityId).map((r) => r.transition);
const reservationFor = (matchId: string) => reservations.getReservationForMatch(ctx, matchId)!;
const status = (matchId: string) => matches.getMatch(ctx, matchId)!.status;
const mailTo = (email: string, subjectLike: string) =>
  one<{ body: string; urgent: number }>(ctx.db, `SELECT body, urgent FROM email_outbox WHERE to_email = ? AND subject LIKE ?`, email, subjectLike);

/** Skapar en Spår 1-match och låter Process B ta emot förfrågan. */
function requested(over: Partial<matches.CreateWeekendSlotInput> = {}) {
  const m = matches.createWeekendSlotMatch(ctx, lena, input(over));
  dispatch();
  return { match: m, reservation: reservationFor(m.id) };
}

/** Kansliet tilldelar plan och Process A publicerar matchen. */
function published(over: Partial<matches.CreateWeekendSlotInput> = {}) {
  const { match, reservation } = requested(over);
  reservations.allocatePitch(ctx, office, reservation.id, { pitchId, startTime: '10:00', durationMinutes: 90 });
  dispatch();
  return { match: matches.getMatch(ctx, match.id)!, reservation: reservationFor(match.id) };
}

/** Hemmalaget väljer Hammarby och Process B låser bokningen. */
function accepted() {
  const { match } = published();
  const inq = matches.createInquiry(ctx, anna, match.id, { teamId: hamTeamId, phone: '+46701234567' });
  matches.selectOpponent(ctx, lena, match.id, inq.id);
  dispatch();
  return { match: matches.getMatch(ctx, match.id)!, reservation: reservationFor(match.id) };
}

beforeEach(setup);

describe('A1 / FR-A-101: skapa match i Spår 1', () => {
  it('AC-101.1: skapar RESERVATION_REQUESTED och skickar REQUEST_RESERVATION till Process B (B1)', () => {
    const m = matches.createWeekendSlotMatch(ctx, lena, input());
    expect(m.status).toBe('RESERVATION_REQUESTED');
    expect(m.origin).toBe('NEW_WEEKEND_SLOT');
    expect(m.venue.startTime).toBe('2026-11-07T09:00:00Z'); // önskat fönster, CET
    const ev = one<{ event_type: string; payload: string }>(ctx.db, `SELECT event_type, payload FROM outbox_events WHERE match_id = ?`, m.id)!;
    expect(ev.event_type).toBe('REQUEST_RESERVATION');
    expect(JSON.parse(ev.payload)).toMatchObject({
      sequence: 1,
      homeTeamId,
      clubName: 'IFK Lidingö',
      requestedDate: '2026-11-07',
      preferredTimeWindow: '10:00-11:30',
      timeZone: 'Europe/Stockholm',
      gameFormat: '7v7_LARGE',
    });
    expect(matches.listMarket(ctx, {})).toHaveLength(0); // AC-102.3

    dispatch();
    const res = reservationFor(m.id);
    expect(res.status).toBe('REQUESTED');
    // 1.4: 14 dagar före 2026-11-07 är 2026-10-24 kl 23:59:59 lokal tid (CEST).
    expect(res.deadlineAt).toBe('2026-10-24T21:59:59Z');
    expect(mailTo('k@x.se', 'Ny förfrågan om helgtid%')).toBeTruthy(); // notifiering #3
    expect(auditRows(res.id)).toEqual(['(start) -> REQUESTED (B1)']);
  });

  it('AC-101.2 / BR-01: vardag nekas', () => {
    expect(() => matches.createWeekendSlotMatch(ctx, lena, input({ date: '2026-11-06' }))).toThrow(
      'Träningsmatchtider tilldelas endast under helger',
    );
  });

  it('AC-101.4 / BR-06: minst 21 dagar i förväg, räknat i lokala kalenderdagar', () => {
    ctx.clock.set('2026-10-18T08:00:00Z'); // söndag
    expect(() => matches.createWeekendSlotMatch(ctx, lena, input({ date: '2026-11-07' }))).toThrow(
      'Helgtider måste begäras minst 21 dagar i förväg',
    );
    expect(matches.createWeekendSlotMatch(ctx, lena, input({ date: '2026-11-08' })).status).toBe('RESERVATION_REQUESTED');
  });

  it('AC-101.5: ledare utan godkänd koppling nekas', () => {
    identity.joinTeam(ctx, per, homeTeamId);
    expect(() => matches.createWeekendSlotMatch(ctx, per, input())).toThrow(/inte godkänd/);
  });

  it('önskad tid är starttid plus längd och måste sluta samma dag', () => {
    expect(() => matches.createWeekendSlotMatch(ctx, lena, input({ startTime: '23:30' }))).toThrow(/samma dag/);
    const m = matches.createWeekendSlotMatch(ctx, lena, input({ durationMinutes: 60 }));
    expect(m.venue.endTime).toBe('2026-11-07T10:00:00Z');
  });
});

describe('B2 / A3 / FR-B-201: kansliet tilldelar plan', () => {
  it('AC-201.2 / AC-102.1: tilldelning publicerar matchen med plan och tid', () => {
    const { match, reservation } = requested();
    const r = reservations.allocatePitch(ctx, office, reservation.id, { pitchId, startTime: '10:00', durationMinutes: 90 });
    expect(r.status).toBe('RESERVED');
    expect(status(match.id)).toBe('RESERVATION_REQUESTED'); // A ändras först när eventet levererats

    dispatch();
    const m = matches.getMatch(ctx, match.id)!;
    expect(m.status).toBe('PUBLISHED');
    expect(m.reservationId).toBe(reservation.id);
    expect(m.venue).toMatchObject({
      facilityName: 'Skärsätra IP',
      facilityAddress: 'Skärsätravägen 50',
      pitchName: 'Plan 2',
      surface: 'ARTIFICIAL_TURF',
      startTime: '2026-11-07T09:00:00Z',
      endTime: '2026-11-07T10:30:00Z',
    });
    expect(matches.listMarket(ctx, {}).map((x) => x.id)).toEqual([match.id]);
    expect(mailTo('lena@x.se', 'Plan tilldelad%')?.body).toContain('Välj motståndare senast'); // notifiering #4
    const payload = JSON.parse(
      one<{ payload: string }>(ctx.db, `SELECT payload FROM outbox_events WHERE event_type = 'RESERVATION_RESERVED'`)!.payload,
    );
    expect(payload).toMatchObject({ sequence: 2, reservationId: reservation.id, deadlineAt: '2026-10-24T21:59:59Z' });
    expect(auditRows(match.id)).toEqual(['(start) -> RESERVATION_REQUESTED (A1)', 'RESERVATION_REQUESTED -> PUBLISHED (A3)']);
  });

  it('utan angiven längd tilldelas samma längd som den önskade tiden', () => {
    const { reservation } = requested({ durationMinutes: 75 });
    const r = reservations.allocatePitch(ctx, office, reservation.id, { pitchId, startTime: '12:00' });
    expect(r.allocatedPitch).toMatchObject({ startTime: '2026-11-07T11:00:00Z', endTime: '2026-11-07T12:15:00Z' });
  });

  it('erbjuder bara planer som stödjer spelformen', () => {
    const { reservation } = requested();
    expect(() =>
      reservations.allocatePitch(ctx, office, reservation.id, { pitchId: smallPitchId, startTime: '10:00', durationMinutes: 90 }),
    ).toThrow(/stödjer inte/);
  });

  it('överlapp på samma plan och tid ger en varning som kan åsidosättas', () => {
    published();
    const second = requested({ startTime: '11:00', durationMinutes: 60 });
    const allocate = (overrideOverlap?: boolean) =>
      reservations.allocatePitch(ctx, office, second.reservation.id, { pitchId, startTime: '11:00', durationMinutes: 60, overrideOverlap });
    expect(() => allocate()).toThrow(/redan bokad/);
    expect(reservationFor(second.match.id).status).toBe('REQUESTED');
    expect(allocate(true).status).toBe('RESERVED');
    expect(auditRows(second.reservation.id)).toContain('REQUESTED -> RESERVED (B2, överlapp åsidosatt)');
  });

  it('en frigjord plantid ger ingen överlappsvarning', () => {
    const first = published();
    matches.cancelMatch(ctx, lena, first.match.id);
    dispatch();
    const second = requested();
    expect(reservations.allocatePitch(ctx, office, second.reservation.id, { pitchId, startTime: '10:00', durationMinutes: 90 }).status).toBe('RESERVED');
  });

  it('AC-201.3 / B4: ett ärende som hemmalaget avbokat kan inte tilldelas', () => {
    const { match, reservation } = requested();
    expect(matches.cancelMatch(ctx, lena, match.id).status).toBe('CANCELLED'); // A5
    dispatch();
    expect(reservationFor(match.id).status).toBe('WITHDRAWN_BY_HOME');
    expect(() => reservations.allocatePitch(ctx, office, reservation.id, { pitchId, startTime: '10:00', durationMinutes: 90 })).toThrow(
      /avbokat/,
    );
  });

  it('AC-105.2: sent RESERVATION_RESERVED till avbokad match ignoreras och planen frigörs', () => {
    const { match, reservation } = requested();
    matches.cancelMatch(ctx, lena, match.id); // RESERVATION_WITHDRAWN ligger kvar i outboxen
    reservations.allocatePitch(ctx, office, reservation.id, { pitchId, startTime: '10:00', durationMinutes: 90 });
    dispatch();
    expect(status(match.id)).toBe('CANCELLED');
    expect(auditRows(match.id)).toContain('IGNORED RESERVATION_RESERVED (status CANCELLED)');
    expect(reservationFor(match.id).status).toBe('WITHDRAWN_BY_HOME'); // B6
  });
});

describe('B3 / A4 / FR-B-204: kansliet avslår', () => {
  it('kräver orsak, högst 200 tecken', () => {
    const { reservation } = requested();
    expect(() => reservations.rejectRequest(ctx, office, reservation.id, ' ')).toThrow(/orsak/);
    expect(() => reservations.rejectRequest(ctx, office, reservation.id, 'x'.repeat(201))).toThrow(/200 tecken/);
  });

  it('matchen blir CANCELLED och hemmalaget ser orsaken', () => {
    const { match, reservation } = requested();
    const r = reservations.rejectRequest(ctx, office, reservation.id, 'Inga lediga planer för 7 mot 7 stor den helgen');
    expect(r.status).toBe('REJECTED_BY_OFFICE');
    dispatch();
    expect(status(match.id)).toBe('CANCELLED');
    expect(mailTo('lena@x.se', 'Förfrågan om helgtid avslogs%')?.body).toContain('Inga lediga planer'); // notifiering #5
    expect(matches.getMatchDetail(ctx, match.id, lena).reservation).toMatchObject({
      status: 'REJECTED_BY_OFFICE',
      decisionReason: 'Inga lediga planer för 7 mot 7 stor den helgen',
    });
    expect(() => reservations.allocatePitch(ctx, office, reservation.id, { pitchId, startTime: '10:00', durationMinutes: 90 })).toThrow(
      /redan hanterad/,
    );
  });
});

describe('B5 / B8 / FR-B-205: vald motståndare', () => {
  it('AC-205.1: RESERVATION_ACCEPTED låser bokningen med motståndarinfo', () => {
    const { match, reservation } = accepted();
    expect(match.status).toBe('MATCH_CONFIRMED');
    expect(reservation.status).toBe('ACCEPTED');
    expect(reservation.opponent).toEqual({ club: 'Hammarby IF', teamName: 'P2015', contactName: 'Anna', contactPhone: '+46701234567' });
  });

  it('AC-104.4 / AC-205.2 / BR-04: efter återbud skrivs motståndaren över utan statusändring', () => {
    const { match } = accepted();
    matches.withdrawAsOpponent(ctx, anna, match.id); // A7: inget event till B
    dispatch();
    expect(reservationFor(match.id).status).toBe('ACCEPTED');

    const inq = matches.createInquiry(ctx, erik, match.id, { teamId: difTeamId, phone: '+46705555555' });
    matches.selectOpponent(ctx, lena, match.id, inq.id);
    dispatch();
    const res = reservationFor(match.id);
    expect(res.status).toBe('ACCEPTED');
    expect(res.opponent?.club).toBe('DIF');
    expect(auditRows(res.id)).toEqual([
      '(start) -> REQUESTED (B1)',
      'REQUESTED -> RESERVED (B2)',
      'RESERVED -> ACCEPTED (B5)',
      'ACCEPTED -> ACCEPTED (B8)',
    ]);
  });
});

describe('B7 / A10 / FR-B-202: 14-dagarsregeln', () => {
  it('AC-202.1: påminnelse 18 dagar före matchdatum, en gång', () => {
    published();
    ctx.clock.set('2026-10-19T21:59:59Z');
    expect(reservations.runReservationDeadlines(ctx).reminders).toBe(0);
    ctx.clock.set('2026-10-19T22:00:00Z'); // 2026-10-20 00:00 lokal tid
    expect(reservations.runReservationDeadlines(ctx).reminders).toBe(1);
    expect(reservations.runReservationDeadlines(ctx).reminders).toBe(0);
    expect(mailTo('lena@x.se', 'Påminnelse: välj motståndare%')).toBeTruthy(); // notifiering #11
  });

  it('AC-202.1: ingen påminnelse om planen tilldelades efter påminnelsetidpunkten', () => {
    const { reservation } = requested();
    ctx.clock.set('2026-10-21T08:00:00Z');
    reservations.allocatePitch(ctx, office, reservation.id, { pitchId, startTime: '10:00', durationMinutes: 90 });
    ctx.clock.set('2026-10-22T08:00:00Z');
    expect(reservations.runReservationDeadlines(ctx).reminders).toBe(0);
  });

  it('AC-202.2: återkallas automatiskt efter fristen och matchen blir CANCELLED', () => {
    const { match } = published();
    matches.createInquiry(ctx, anna, match.id, { teamId: hamTeamId, phone: '+46701234567' });
    ctx.clock.set('2026-10-24T21:59:59Z');
    expect(reservations.runReservationDeadlines(ctx).revoked).toBe(0);
    ctx.clock.set('2026-10-24T22:00:00Z');
    expect(reservations.runReservationDeadlines(ctx).revoked).toBe(1);
    expect(reservationFor(match.id).status).toBe('REVOKED_BY_DEADLINE');

    dispatch();
    expect(status(match.id)).toBe('CANCELLED');
    expect(auditRows(match.id)).toContain('PUBLISHED -> CANCELLED (A10)');
    expect(mailTo('anna@x.se', 'Matchen är inställd%')).toBeTruthy(); // notifiering #12
    const payload = JSON.parse(
      one<{ payload: string }>(ctx.db, `SELECT payload FROM outbox_events WHERE event_type = 'RESERVATION_REVOKED'`)!.payload,
    );
    expect(payload.reason).toBe('DEADLINE_EXPIRED_14_DAYS');
  });

  it('BR-03: motståndare kan inte väljas efter fristen', () => {
    const { match } = published();
    const inq = matches.createInquiry(ctx, anna, match.id, { teamId: hamTeamId, phone: '+46701234567' });
    ctx.clock.set('2026-10-24T22:00:00Z');
    expect(matches.getMatchDetail(ctx, match.id, lena).allowed.select).toBe(false);
    expect(() => matches.selectOpponent(ctx, lena, match.id, inq.id)).toThrow(/14-dagarsfristen/);
  });

  it('BR-04: efter återbud räknas fristen inte om', () => {
    const { match } = accepted();
    matches.withdrawAsOpponent(ctx, anna, match.id);
    ctx.clock.set('2026-10-30T08:00:00Z');
    expect(reservations.runReservationDeadlines(ctx).revoked).toBe(0);
    const inq = matches.createInquiry(ctx, erik, match.id, { teamId: difTeamId, phone: '+46705555555' });
    expect(matches.selectOpponent(ctx, lena, match.id, inq.id).status).toBe('MATCH_CONFIRMED');
  });
});

describe('B10 / A11 / FR-B-206: kansliet ställer in', () => {
  it('AC-206.1: inställd accepterad bokning gör matchen CANCELLED med akut notis och orsak', () => {
    const { match, reservation } = accepted();
    expect(() => reservations.cancelByOffice(ctx, office, reservation.id, '')).toThrow(/orsak/);
    expect(reservations.cancelByOffice(ctx, office, reservation.id, 'Planen stängd på grund av tjäle').status).toBe('CANCELLED_BY_OFFICE');
    dispatch();
    expect(status(match.id)).toBe('CANCELLED');
    expect(auditRows(match.id)).toContain('MATCH_CONFIRMED -> CANCELLED (A11)');
    for (const email of ['lena@x.se', 'anna@x.se']) {
      const mail = mailTo(email, 'INSTÄLLD%');
      expect(mail?.urgent).toBe(1); // notifiering #13
      expect(mail?.body).toContain('tjäle');
    }
  });

  it('kan ställa in en RESERVED bokning, men inte en som redan är avslutad', () => {
    const { match, reservation } = published();
    reservations.cancelByOffice(ctx, office, reservation.id, 'Dubbelbokad');
    dispatch();
    expect(status(match.id)).toBe('CANCELLED');
    expect(() => reservations.cancelByOffice(ctx, office, reservation.id, 'Igen')).toThrow(/Bara reserverade/);
  });
});

describe('B11 / B12 / FR-B-203: livscykelavslut', () => {
  it('AC-203.1: MATCH_COMPLETED med reservationId går till både B och C', () => {
    const { match } = accepted();
    ctx.clock.set('2026-11-07T11:00:00Z');
    matches.confirmCompleted(ctx, lena, match.id);
    dispatch();
    expect(reservationFor(match.id).status).toBe('COMPLETED');
    expect(all(ctx.db, `SELECT * FROM fair_play_reviews WHERE match_id = ?`, match.id)).toHaveLength(2);
  });

  it('AC-203.3 / A14: ej bekräftad inom 48 h ger CLOSED_EXPIRED', () => {
    const { match } = accepted();
    ctx.clock.set('2026-11-09T10:30:01Z');
    matches.runMatchTimers(ctx);
    dispatch();
    expect(status(match.id)).toBe('EXPIRED');
    const reason = JSON.parse(one<{ payload: string }>(ctx.db, `SELECT payload FROM outbox_events WHERE event_type = 'MATCH_EXPIRED'`)!.payload).reason;
    expect(reason).toBe('NOT_CONFIRMED_WITHIN_48H');
    expect(reservationFor(match.id).status).toBe('CLOSED_EXPIRED');
  });

  it('A12 / AC-106.1: ingen ny motståndare efter återbud ger MATCH_EXPIRED (NO_OPPONENT_AT_START)', () => {
    const { match } = accepted();
    matches.withdrawAsOpponent(ctx, anna, match.id);
    ctx.clock.set('2026-11-07T09:00:00Z');
    matches.runMatchTimers(ctx);
    dispatch();
    expect(status(match.id)).toBe('EXPIRED');
    const reason = JSON.parse(one<{ payload: string }>(ctx.db, `SELECT payload FROM outbox_events WHERE event_type = 'MATCH_EXPIRED'`)!.payload).reason;
    expect(reason).toBe('NO_OPPONENT_AT_START');
    expect(reservationFor(match.id).status).toBe('CLOSED_EXPIRED');
  });

  it('A9 / B9: hemmalaget avbokar en bekräftad match och plantiden frigörs', () => {
    const { match } = accepted();
    matches.cancelMatch(ctx, lena, match.id);
    dispatch();
    expect(reservationFor(match.id).status).toBe('WITHDRAWN_BY_HOME');
    const payload = JSON.parse(
      one<{ payload: string }>(ctx.db, `SELECT payload FROM outbox_events WHERE event_type = 'RESERVATION_WITHDRAWN'`)!.payload,
    );
    expect(payload.reservationId).toBe(reservationFor(match.id).id);
  });
});

describe('4.0: ordning och idempotens för Spår 1', () => {
  it('sequence är strikt stigande per match över båda processerna', () => {
    const { match } = accepted();
    const seqs = all<{ sequence: number }>(ctx.db, `SELECT sequence FROM outbox_events WHERE match_id = ? ORDER BY sequence`, match.id).map(
      (r) => r.sequence,
    );
    expect(seqs).toEqual([1, 2, 3]);
    expect(all(ctx.db, `SELECT * FROM outbox_events WHERE processed_at IS NULL`)).toHaveLength(0);
  });

  it('ett redan behandlat event ger ingen ny reservation', () => {
    const { match } = requested();
    ctx.db.exec(`UPDATE outbox_events SET processed_at = NULL`);
    dispatch();
    expect(all(ctx.db, `SELECT * FROM reservations WHERE match_id = ?`, match.id)).toHaveLength(1);
  });
});
