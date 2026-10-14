// Testdata för dev och demo: användare per roll (öppen punkt 2), lag, anläggningar och några matcher.
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';
import type { Ctx } from './context.js';
import type { User } from '../shared/types.js';
import { openDb, one, run } from './infra/db.js';
import { Clock } from './infra/clock.js';
import { addDaysToDate, isWeekendDate, utcToLocal } from '../shared/time.js';
import * as identity from './modules/identity.js';
import * as masterdata from './modules/masterdata.js';
import * as matches from './modules/matches.js';
import * as fairplay from './modules/fairplay.js';
import * as reservations from './modules/reservations.js';
import { createDispatcher } from './runtime.js';

function localDatePlusDays(ctx: Ctx, days: number): string {
  return addDaysToDate(utcToLocal(ctx.clock.nowIso()).date, days);
}

/** Första lördag eller söndag minst `days` dagar fram (Spår 1, BR-01 och BR-06). */
function weekendPlusDays(ctx: Ctx, days: number): string {
  let date = localDatePlusDays(ctx, days);
  while (!isWeekendDate(date)) date = addDaysToDate(date, 1);
  return date;
}

export function seedIfEmpty(ctx: Ctx): void {
  if (one(ctx.db, `SELECT 1 FROM users LIMIT 1`)) return;
  seed(ctx);
}

export function seed(ctx: Ctx): void {
  const mk = (id: string, name: string, email: string, role: User['role']) => identity.createUser(ctx, { id, name, email, role });

  const office = mk('usr_office', 'Karin Kansli', 'kansli@ifklidingo.example', 'OFFICE');
  mk('usr_admin', 'Adam Admin', 'admin@ifklidingo.example', 'ADMIN');
  const lena = mk('usr_lena', 'Lena Lidingö', 'lena@example.com', 'TEAM_LEADER');
  const per = mk('usr_per', 'Per Pending', 'per@example.com', 'TEAM_LEADER');
  const fia = mk('usr_fia', 'Fia Flicktränare', 'fia@example.com', 'TEAM_LEADER');
  const anna = mk('usr_anna', 'Anna Lind', 'anna@hammarby.example', 'TEAM_LEADER');
  const erik = mk('usr_erik', 'Erik Djurman', 'erik@dif.example', 'TEAM_LEADER');
  const sara = mk('usr_sara', 'Sara Täby', 'sara@tabyfk.example', 'TEAM_LEADER');
  mk('usr_new', 'Nora Ny', 'nora@example.com', 'TEAM_LEADER');

  // Anläggningar och planer (FR-B-207)
  const skarsatra = masterdata.createFacility(ctx, office, { name: 'Skärsätra IP', address: 'Skärsätravägen 50, Lidingö' });
  const p1 = masterdata.createPitch(ctx, office, {
    facilityId: skarsatra.id,
    name: 'Plan 1',
    surface: 'ARTIFICIAL_TURF',
    supportedFormats: ['7v7_LARGE', '9v9', '11v11'],
  });
  const p2 = masterdata.createPitch(ctx, office, {
    facilityId: skarsatra.id,
    name: 'Plan 2',
    surface: 'ARTIFICIAL_TURF',
    supportedFormats: ['3v3', '5v5', '7v7_SMALL', '7v7_LARGE'],
  });
  const vallen = masterdata.createFacility(ctx, office, { name: 'Lidingövallen', address: 'Stockholmsvägen 51, Lidingö' });
  masterdata.createPitch(ctx, office, { facilityId: vallen.id, name: 'Huvudplan', surface: 'NATURAL_TURF', supportedFormats: ['9v9', '11v11'] });
  const v2 = masterdata.createPitch(ctx, office, { facilityId: vallen.id, name: 'Konstgräs', surface: 'ARTIFICIAL_TURF', supportedFormats: ['5v5', '7v7_SMALL', '7v7_LARGE', '9v9'] });

  // Lag och kopplingar
  const approve = (m: { id: string }) => identity.decideMembership(ctx, office, m.id, true);
  const lidP15 = identity.createTeam(ctx, lena, { isHomeClub: true, name: 'P2015 Blå', birthYear: 2015, category: 'BOYS' });
  approve(lidP15.membership);
  const lidF14 = identity.createTeam(ctx, fia, { isHomeClub: true, name: 'F2014', birthYear: 2014, category: 'GIRLS' });
  approve(lidF14.membership);
  identity.joinTeam(ctx, per, lidP15.team.id); // väntar på kansliet (AC-U-002.3)
  const ham = identity.createTeam(ctx, anna, { isHomeClub: false, clubName: 'Hammarby IF', name: 'P2015-11', birthYear: 2015, category: 'BOYS' });
  const dif = identity.createTeam(ctx, erik, { isHomeClub: false, clubName: 'Djurgårdens IF', name: 'P2016 Svart', birthYear: 2016, category: 'BOYS' });
  const taby = identity.createTeam(ctx, sara, { isHomeClub: false, clubName: 'Täby FK', name: 'F2014', birthYear: 2014, category: 'GIRLS' });

  const base = {
    homeTeamId: lidP15.team.id,
    phone: '+46 70 111 22 33',
    gameFormat: '7v7_LARGE' as const,
    birthYear: 2015,
    category: 'BOYS' as const,
    openToAdjacentBirthYears: true,
    matchLevel: 'MEDIUM' as const,
    durationMinutes: 60,
    referee: 'HOME_ARRANGES' as const,
    kitColorHome: 'Blå/vit',
  };

  // Historik: tre genomförda matcher mot Hammarby så att lagprofilerna blir synliga (minst 3 recensioner).
  const dispatcher = createDispatcher();
  ctx.clock.advance(-40 * 86_400_000);
  const levels = ['MEDIUM', 'MEDIUM_PLUS', 'MEDIUM'] as const;
  for (let i = 0; i < 3; i++) {
    const m = matches.createOwnSlotMatch(ctx, lena, { ...base, pitchId: p2.id, date: localDatePlusDays(ctx, 1 + i), startTime: '17:30', durationMinutes: 75 });
    const inq = matches.createInquiry(ctx, anna, m.id, { teamId: ham.team.id, phone: '+46 70 123 45 67' });
    matches.selectOpponent(ctx, lena, m.id, inq.id);
    ctx.clock.advance((2 + i) * 86_400_000);
    matches.confirmCompleted(ctx, lena, m.id);
    dispatcher.dispatch(ctx);
    for (const r of fairplay.listMyReviews(ctx, lena).filter((r) => r.matchId === m.id))
      fairplay.submitReview(ctx, lena, r.id, { playersScore: 3, leadersScore: 3, spectatorsScore: i === 1 ? 2 : 'NOT_APPLICABLE', assessedLevel: levels[i] });
    for (const r of fairplay.listMyReviews(ctx, anna).filter((r) => r.matchId === m.id))
      fairplay.submitReview(ctx, anna, r.id, { playersScore: 3, leadersScore: i === 2 ? 2 : 3, spectatorsScore: 3, assessedLevel: 'MEDIUM_PLUS' });
    dispatcher.dispatch(ctx);
    ctx.clock.advance(-(2 + i) * 86_400_000);
  }
  ctx.clock.reset();

  // Aktuella matcher på börsen (Spår 2).
  const m1 = matches.createOwnSlotMatch(ctx, lena, { ...base, pitchId: p2.id, date: localDatePlusDays(ctx, 5), startTime: '17:30', durationMinutes: 75 });
  matches.createInquiry(ctx, anna, m1.id, { teamId: ham.team.id, phone: '+46 70 123 45 67' });
  matches.createInquiry(ctx, erik, m1.id, { teamId: dif.team.id, phone: '+46 73 555 66 77' });
  matches.createOwnSlotMatch(ctx, lena, {
    ...base,
    pitchId: p1.id,
    date: localDatePlusDays(ctx, 12),
    startTime: '18:00',
    durationMinutes: 90,
    gameFormat: '9v9',
    openToAdjacentBirthYears: false,
    matchLevel: 'HARD',
    referee: 'SHARED_ON_SITE',
  });
  matches.createOwnSlotMatch(ctx, fia, {
    ...base,
    homeTeamId: lidF14.team.id,
    phone: '+46 70 999 88 77',
    pitchId: v2.id,
    date: localDatePlusDays(ctx, 8),
    startTime: '16:30',
    durationMinutes: 75,
    birthYear: 2014,
    category: 'GIRLS',
    matchLevel: 'EASY_PLUS',
    kitColorHome: 'Blått',
  });
  void taby;

  // Spår 1: en förfrågan i kansliets kö och en tilldelad helgtid som ligger på börsen.
  const weekendBase = { ...base, durationMinutes: 90, referee: 'SHARED_ON_SITE' as const, openToAdjacentBirthYears: false };
  matches.createWeekendSlotMatch(ctx, lena, { ...weekendBase, date: weekendPlusDays(ctx, 24), startTime: '10:00' });
  const fiaWeekend = matches.createWeekendSlotMatch(ctx, fia, {
    ...weekendBase,
    homeTeamId: lidF14.team.id,
    phone: '+46 70 999 88 77',
    date: weekendPlusDays(ctx, 30),
    startTime: '12:00',
    birthYear: 2014,
    category: 'GIRLS',
    matchLevel: 'MEDIUM',
    kitColorHome: 'Blått',
  });
  dispatcher.dispatch(ctx);
  const fiaReservation = reservations.getReservationForMatch(ctx, fiaWeekend.id)!;
  reservations.allocatePitch(ctx, office, fiaReservation.id, { pitchId: v2.id, startTime: '12:00' });
  dispatcher.dispatch(ctx);

  // Dev-seed ska inte skicka e-post i efterhand.
  run(ctx.db, `UPDATE email_outbox SET sent_at = created_at WHERE sent_at IS NULL`);
}

// `npm run seed` – återskapa databasen med testdata.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const path = process.env.DATABASE_PATH ?? 'data/matchborsen.db';
  if (process.argv.includes('--reset')) for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
  const ctx = { db: openDb(path), clock: new Clock() };
  seedIfEmpty(ctx);
  console.log(`Testdata skapad i ${path}`);
}
