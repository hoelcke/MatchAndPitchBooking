import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, all, one } from '../infra/db.js';
import { FixedClock } from '../infra/clock.js';
import type { Ctx } from '../context.js';
import type { User } from '../../shared/types.js';
import * as identity from '../modules/identity.js';
import * as masterdata from '../modules/masterdata.js';
import * as matches from '../modules/matches.js';
import * as fairplay from '../modules/fairplay.js';
import { createDispatcher } from '../runtime.js';
import { routeTargets } from '../infra/outbox.js';


let ctx: Ctx & { clock: FixedClock };
let office: User, lena: User, anna: User, erik: User, per: User;
let homeTeamId: string, hamTeamId: string, difTeamId: string, pitchId: string;

function setup() {
  ctx = { db: openDb(':memory:'), clock: new FixedClock(new Date('2026-10-13T08:00:00Z')) };
  office = identity.createUser(ctx, { name: 'Kansli', email: 'k@x.se', role: 'OFFICE' });
  lena = identity.createUser(ctx, { name: 'Lena', email: 'lena@x.se', role: 'TEAM_LEADER' });
  anna = identity.createUser(ctx, { name: 'Anna', email: 'anna@x.se', role: 'TEAM_LEADER' });
  erik = identity.createUser(ctx, { name: 'Erik', email: 'erik@x.se', role: 'TEAM_LEADER' });
  per = identity.createUser(ctx, { name: 'Per', email: 'per@x.se', role: 'TEAM_LEADER' });
  const fac = masterdata.createFacility(ctx, office, { name: 'Skärsätra IP', address: 'Skärsätravägen 50' });
  pitchId = masterdata.createPitch(ctx, office, { facilityId: fac.id, name: 'Plan 2', surface: 'ARTIFICIAL_TURF', supportedFormats: ['7v7_LARGE'] }).id;
  const home = identity.createTeam(ctx, lena, { isHomeClub: true, name: 'P2015', birthYear: 2015, category: 'BOYS' });
  identity.decideMembership(ctx, office, home.membership.id, true);
  homeTeamId = home.team.id;
  hamTeamId = identity.createTeam(ctx, anna, { isHomeClub: false, clubName: 'Hammarby IF', name: 'P2015', birthYear: 2015, category: 'BOYS' }).team.id;
  difTeamId = identity.createTeam(ctx, erik, { isHomeClub: false, clubName: 'DIF', name: 'P2016', birthYear: 2016, category: 'BOYS' }).team.id;
}

const input = (over: Partial<matches.CreateOwnSlotInput> = {}): matches.CreateOwnSlotInput => ({
  homeTeamId,
  phone: '+46701112233',
  pitchId,
  date: '2026-10-20',
  startTime: '17:30',
  gameFormat: '7v7_LARGE',
  birthYear: 2015,
  category: 'BOYS',
  openToAdjacentBirthYears: false,
  matchLevel: 'MEDIUM',
  durationMinutes: 75,
  referee: 'HOME_ARRANGES',
  kitColorHome: 'Blå',
  ...over,
});

const auditRows = (entityId: string) =>
  all<{ transition: string }>(ctx.db, `SELECT transition FROM audit_log WHERE entity_id = ?`, entityId).map((r) => r.transition);

beforeEach(setup);

describe('A2 / AC-101.3: skapa match i Spår 2', () => {
  it('publiceras direkt utan att Process B startas', () => {
    const m = matches.createOwnSlotMatch(ctx, lena, input());
    expect(m.status).toBe('PUBLISHED');
    expect(m.origin).toBe('OWN_TRAINING_SLOT');
    expect(m.reservationId).toBeUndefined();
    expect(m.venue.startTime).toBe('2026-10-20T15:30:00Z'); // CEST
    expect(m.venue.facilityName).toBe('Skärsätra IP');
    expect(all(ctx.db, `SELECT * FROM outbox_events`)).toHaveLength(0);
    expect(auditRows(m.id)).toEqual(['(start) -> PUBLISHED (A2)']);
  });

  it('nekar ledare vars koppling väntar på kansliet (AC-101.5)', () => {
    identity.joinTeam(ctx, per, homeTeamId);
    expect(() => matches.createOwnSlotMatch(ctx, per, input())).toThrow(/inte godkänd/);
  });

  it('nekar externa lag (BR-07)', () => {
    expect(() => matches.createOwnSlotMatch(ctx, anna, input({ homeTeamId: hamTeamId }))).toThrow(/IFK Lidingö/);
  });

  it('kräver telefonnummer (BR-17) och en längd som slutar samma dag', () => {
    expect(() => matches.createOwnSlotMatch(ctx, lena, input({ phone: '' }))).toThrow(/Telefonnummer/);
    expect(() => matches.createOwnSlotMatch(ctx, lena, input({ durationMinutes: 200 }))).toThrow(/10–180 minuter/);
    expect(() => matches.createOwnSlotMatch(ctx, lena, input({ startTime: '23:30', durationMinutes: 60 }))).toThrow(/samma dag/);
  });

  it('sluttiden är starttid plus längd', () => {
    const m = matches.createOwnSlotMatch(ctx, lena, input({ durationMinutes: 60 }));
    expect(m.venue.endTime).toBe('2026-10-20T16:30:00Z');
    expect(m.durationMinutes).toBe(60);
  });

  it('gör ingen överlappskontroll (BR-02)', () => {
    matches.createOwnSlotMatch(ctx, lena, input());
    expect(() => matches.createOwnSlotMatch(ctx, lena, input())).not.toThrow();
  });
});

describe('Börsen (AC-102.2/102.3)', () => {
  it('visar bara PUBLISHED utan kontaktuppgifter och filtrerar på födelseår enligt BR-09', () => {
    const m = matches.createOwnSlotMatch(ctx, lena, input({ openToAdjacentBirthYears: true }));
    matches.createOwnSlotMatch(ctx, lena, input({ birthYear: 2013 }));
    const list = matches.listMarket(ctx, { birthYear: 2016 });
    expect(list.map((x) => x.id)).toEqual([m.id]);
    expect(list[0]).not.toHaveProperty('homeContact');
    expect(matches.getMatchDetail(ctx, m.id, undefined).match.homeContact).toBeUndefined();
  });
});

describe('Intresseanmälan och val av motståndare', () => {
  it('BR-09: lag som inte matchar kan inte anmäla intresse', () => {
    const m = matches.createOwnSlotMatch(ctx, lena, input());
    expect(() => matches.createInquiry(ctx, erik, m.id, { teamId: difTeamId, phone: '+46705555555' })).toThrow(/matchar inte/);
  });

  it('A6: val gör matchen MATCH_CONFIRMED, avvisar övriga och delar kontaktuppgifter', () => {
    const m = matches.createOwnSlotMatch(ctx, lena, input({ openToAdjacentBirthYears: true }));
    const a = matches.createInquiry(ctx, anna, m.id, { teamId: hamTeamId, phone: '+46701234567' });
    const e = matches.createInquiry(ctx, erik, m.id, { teamId: difTeamId, phone: '+46705555555' });
    expect(matches.getMatch(ctx, m.id)!.inquiriesCount).toBe(2);

    const confirmed = matches.selectOpponent(ctx, lena, m.id, a.id);
    expect(confirmed.status).toBe('MATCH_CONFIRMED');
    expect(confirmed.awayTeamId).toBe(hamTeamId);
    expect(confirmed.selectedOpponent?.phone).toBe('+46701234567');
    expect(one<{ status: string }>(ctx.db, `SELECT status FROM inquiries WHERE id = ?`, e.id)!.status).toBe('REJECTED');

    const asAway = matches.getMatchDetail(ctx, m.id, anna);
    expect(asAway.match.homeContact?.phone).toBe('+46701112233');
    expect(() => matches.getMatchDetail(ctx, m.id, undefined)).toThrow(); // inte längre på börsen
    // Spår 2: inget RESERVATION_ACCEPTED
    expect(all(ctx.db, `SELECT * FROM outbox_events`)).toHaveLength(0);
  });

  it('AC-103.4 / BR-16: val av en tillbakadragen anmälan rullas tillbaka', () => {
    const m = matches.createOwnSlotMatch(ctx, lena, input());
    const a = matches.createInquiry(ctx, anna, m.id, { teamId: hamTeamId, phone: '+46701234567' });
    matches.withdrawInquiry(ctx, anna, a.id);
    expect(() => matches.selectOpponent(ctx, lena, m.id, a.id)).toThrow('Intresseanmälan har dragits tillbaka av motståndaren');
    expect(matches.getMatch(ctx, m.id)!.status).toBe('PUBLISHED');
    expect(matches.getMatch(ctx, m.id)!.inquiriesCount).toBe(0);
  });

  it('ett avvisat lag kan anmäla sig igen efter återbud (AC-103.1/104.2)', () => {
    const m = matches.createOwnSlotMatch(ctx, lena, input({ openToAdjacentBirthYears: true }));
    const a = matches.createInquiry(ctx, anna, m.id, { teamId: hamTeamId, phone: '+46701234567' });
    matches.createInquiry(ctx, erik, m.id, { teamId: difTeamId, phone: '+46705555555' });
    matches.selectOpponent(ctx, lena, m.id, a.id);

    const after = matches.withdrawAsOpponent(ctx, anna, m.id);
    expect(after.status).toBe('PUBLISHED');
    expect(after.isUrgent).toBe(true);
    expect(after.awayTeamId).toBeUndefined();
    expect(after.inquiriesCount).toBe(0); // avvisade återaktiveras inte
    const urgent = one<{ urgent: number }>(ctx.db, `SELECT urgent FROM email_outbox WHERE subject LIKE 'ÅTERBUD%'`);
    expect(urgent?.urgent).toBe(1);

    const again = matches.createInquiry(ctx, erik, m.id, { teamId: difTeamId, phone: '+46705555555' });
    expect(matches.selectOpponent(ctx, lena, m.id, again.id).isUrgent).toBe(false);
  });
});

describe('Avbokning och utgång', () => {
  it('A8: hemmalaget avbokar och aktiva sökande notifieras', () => {
    const m = matches.createOwnSlotMatch(ctx, lena, input());
    matches.createInquiry(ctx, anna, m.id, { teamId: hamTeamId, phone: '+46701234567' });
    expect(matches.cancelMatch(ctx, lena, m.id).status).toBe('CANCELLED');
    expect(one(ctx.db, `SELECT 1 FROM email_outbox WHERE to_email = 'anna@x.se' AND subject LIKE 'Matchen är avbokad%'`)).toBeTruthy();
    expect(() => matches.cancelMatch(ctx, lena, m.id)).toThrow();
  });

  it('A12: PUBLISHED utan motståndare vid starttid blir EXPIRED', () => {
    const m = matches.createOwnSlotMatch(ctx, lena, input());
    ctx.clock.set('2026-10-20T15:30:00Z');
    matches.runMatchTimers(ctx);
    expect(matches.getMatch(ctx, m.id)!.status).toBe('EXPIRED');
    expect(auditRows(m.id)).toContain('PUBLISHED -> EXPIRED (A12)');
  });

  it('A14: ingen bekräftelse inom 48 h ger EXPIRED, efter två påminnelser', () => {
    const m = matches.createOwnSlotMatch(ctx, lena, input());
    const a = matches.createInquiry(ctx, anna, m.id, { teamId: hamTeamId, phone: '+46701234567' });
    matches.selectOpponent(ctx, lena, m.id, a.id);
    ctx.clock.set('2026-10-20T16:45:00Z'); // sluttid
    expect(matches.runMatchTimers(ctx).reminders).toBe(1);
    ctx.clock.set('2026-10-21T16:45:00Z');
    expect(matches.runMatchTimers(ctx).reminders).toBe(1);
    ctx.clock.set('2026-10-22T16:45:00Z');
    matches.runMatchTimers(ctx);
    expect(matches.getMatch(ctx, m.id)!.status).toBe('MATCH_CONFIRMED'); // exakt 48 h: fortfarande inom fristen
    ctx.clock.set('2026-10-22T16:45:01Z');
    matches.runMatchTimers(ctx);
    expect(matches.getMatch(ctx, m.id)!.status).toBe('EXPIRED');
    expect(all(ctx.db, `SELECT * FROM fair_play_reviews`)).toHaveLength(0);
  });
});

describe('A13 + Process C: genomförd match och Fair Play', () => {
  function completedMatch() {
    const m = matches.createOwnSlotMatch(ctx, lena, input());
    const a = matches.createInquiry(ctx, anna, m.id, { teamId: hamTeamId, phone: '+46701234567' });
    matches.selectOpponent(ctx, lena, m.id, a.id);
    expect(() => matches.confirmCompleted(ctx, lena, m.id)).toThrow(/efter sluttid/);
    ctx.clock.set('2026-10-20T18:00:00Z');
    matches.confirmCompleted(ctx, lena, m.id);
    createDispatcher().dispatch(ctx);
    return m;
  }

  it('MATCH_COMPLETED utan reservationId routas bara till Process C', () => {
    expect(routeTargets({ eventType: 'MATCH_COMPLETED', payload: {} })).toEqual(['PROCESS_C']);
    expect(routeTargets({ eventType: 'MATCH_COMPLETED', payload: { reservationId: 'res_1' } })).toEqual(['PROCESS_B', 'PROCESS_C']);
    const m = completedMatch();
    const ev = one<{ payload: string; processed_at: string }>(ctx.db, `SELECT payload, processed_at FROM outbox_events WHERE match_id = ?`, m.id)!;
    const payload = JSON.parse(ev.payload);
    expect(payload.reservationId).toBeUndefined();
    expect(payload.sequence).toBe(1);
    expect(payload.reviewDeadlineAt).toBe('2026-10-27T19:00:00Z'); // 7 dagar i Europe/Stockholm över sommartidsskiftet
    expect(ev.processed_at).toBeTruthy();
    expect(all(ctx.db, `SELECT * FROM fair_play_reviews WHERE status = 'PENDING'`)).toHaveLength(2);
  });

  it('idempotens: samma event behandlas inte två gånger', () => {
    const m = completedMatch();
    ctx.db.exec(`UPDATE outbox_events SET processed_at = NULL`);
    createDispatcher().dispatch(ctx);
    expect(all(ctx.db, `SELECT * FROM fair_play_reviews WHERE match_id = '${m.id}'`)).toHaveLength(2);
  });

  it('BR-05 / C3: recensioner räknas in först när båda lämnat in', () => {
    completedMatch();
    const lenaReview = fairplay.listMyReviews(ctx, lena)[0];
    fairplay.submitReview(ctx, lena, lenaReview.id, { playersScore: 3, leadersScore: 2, spectatorsScore: 'NOT_APPLICABLE', assessedLevel: 'HARD' });
    expect(identity.getTeam(ctx, hamTeamId)!.profile.reviewCount).toBe(0);
    const annaReview = fairplay.listMyReviews(ctx, anna)[0];
    fairplay.submitReview(ctx, anna, annaReview.id, { playersScore: 3, leadersScore: 3, spectatorsScore: 3, assessedLevel: 'MEDIUM' });
    expect(identity.getTeam(ctx, hamTeamId)!.profile).toMatchObject({ reviewCount: 1, fairPlayAverage: 2.5, visible: false });
    expect(all(ctx.db, `SELECT * FROM outbox_events WHERE event_type = 'REVIEW_AGGREGATED'`)).toHaveLength(2);
  });

  it('C4/C5: efter 7 dagar publiceras inskickad recension och den andra går ut', () => {
    completedMatch();
    const r = fairplay.listMyReviews(ctx, lena)[0];
    fairplay.submitReview(ctx, lena, r.id, { playersScore: 2, leadersScore: 2, spectatorsScore: 2, assessedLevel: 'EASY' });
    ctx.clock.set('2026-10-27T19:00:01Z');
    fairplay.runReviewDeadlines(ctx);
    const statuses = all<{ status: string }>(ctx.db, `SELECT status FROM fair_play_reviews ORDER BY status`).map((x) => x.status);
    expect(statuses).toEqual(['EXPIRED', 'PUBLISHED']);
    expect(identity.getTeam(ctx, hamTeamId)!.profile.reviewCount).toBe(1);
  });
});

describe('Revisionslogg (NFR-05)', () => {
  it('är append-only och saknar personuppgifter', () => {
    const m = matches.createOwnSlotMatch(ctx, lena, input());
    expect(() => ctx.db.exec(`DELETE FROM audit_log`)).toThrow(/append-only/);
    const rows = JSON.stringify(all(ctx.db, `SELECT * FROM audit_log WHERE entity_id = ?`, m.id));
    expect(rows).not.toContain('lena@x.se');
    expect(rows).not.toContain('+4670');
  });
});
