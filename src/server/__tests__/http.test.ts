// Integrationstester över HTTP: routing, behörighet per endpoint och felkoder (app.ts).
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../infra/db.js';
import { FixedClock } from '../infra/clock.js';
import type { Ctx } from '../context.js';
import type { User } from '../../shared/types.js';
import { isValidDate } from '../../shared/time.js';
import * as identity from '../modules/identity.js';
import * as masterdata from '../modules/masterdata.js';
import { createApp } from '../app.js';
import { createDispatcher, Runtime } from '../runtime.js';

let ctx: Ctx & { clock: FixedClock };
let server: Server;
let base: string;
let office: User, lena: User, anna: User;
let homeTeamId: string, hamTeamId: string, pitchId: string;

// Tisdag 2026-10-13, samma utgångsläge som domäntesterna.
beforeEach(async () => {
  ctx = { db: openDb(':memory:'), clock: new FixedClock(new Date('2026-10-13T08:00:00Z')) };
  office = identity.createUser(ctx, { name: 'Kansli', email: 'k@x.se', role: 'OFFICE' });
  lena = identity.createUser(ctx, { name: 'Lena', email: 'lena@x.se', role: 'TEAM_LEADER' });
  anna = identity.createUser(ctx, { name: 'Anna', email: 'anna@x.se', role: 'TEAM_LEADER' });
  const fac = masterdata.createFacility(ctx, office, { name: 'Skärsätra IP', address: 'Skärsätravägen 50' });
  pitchId = masterdata.createPitch(ctx, office, { facilityId: fac.id, name: 'Plan 2', surface: 'ARTIFICIAL_TURF', supportedFormats: ['7v7_LARGE'] }).id;
  const home = identity.createTeam(ctx, lena, { isHomeClub: true, name: 'P2015', birthYear: 2015, category: 'BOYS' });
  identity.decideMembership(ctx, office, home.membership.id, true);
  homeTeamId = home.team.id;
  hamTeamId = identity.createTeam(ctx, anna, { isHomeClub: false, clubName: 'Hammarby IF', name: 'P2015', birthYear: 2015, category: 'BOYS' }).team.id;

  const runtime = new Runtime(ctx, createDispatcher(), { send: async () => {} });
  const app = createApp(ctx, runtime, { officeEmails: [], adminEmails: [], devTools: true, secureCookies: false });
  server = await new Promise<Server>((ok) => {
    const s = app.listen(0, () => ok(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterEach(() => new Promise<void>((ok) => server.close(() => ok())));

interface Res {
  status: number;
  body: any;
}

async function call(method: string, path: string, opts: { cookie?: string; body?: unknown; contentType?: string } = {}): Promise<Res> {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  if (method !== 'GET') headers['content-type'] = opts.contentType ?? 'application/json';
  const r = await fetch(base + path, {
    method,
    headers,
    body: method === 'GET' ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body ?? {}),
  });
  return { status: r.status, body: await r.json() };
}

/** Loggar in via dev-inloggningen och returnerar sessionscookien. */
async function login(user: User): Promise<string> {
  const r = await fetch(`${base}/dev/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: user.id }),
  });
  expect(r.status).toBe(200);
  return r.headers.get('set-cookie')!.split(';')[0];
}

const ownSlot = (over: Record<string, unknown> = {}) => ({
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

describe('HTTP: felkoder och skydd', () => {
  it('okänd API-väg ger 404 NOT_FOUND', async () => {
    expect(await call('GET', '/finns-inte')).toMatchObject({ status: 404, body: { error: 'NOT_FOUND' } });
  });

  it('ändrande anrop utan inloggning ger 401', async () => {
    expect(await call('POST', '/matches', { body: ownSlot() })).toMatchObject({ status: 401, body: { error: 'UNAUTHORIZED' } });
  });

  it('ändrande anrop som inte är JSON ger 400 (CSRF-spärr)', async () => {
    const cookie = await login(lena);
    const r = await call('POST', '/matches', { cookie, body: 'x=1', contentType: 'application/x-www-form-urlencoded' });
    expect(r).toMatchObject({ status: 400, body: { error: 'VALIDATION' } });
  });

  it('ogiltig JSON ger 400', async () => {
    const cookie = await login(lena);
    expect(await call('POST', '/matches', { cookie, body: '{inte json' })).toMatchObject({ status: 400, body: { error: 'VALIDATION' } });
  });

  it('lagledare når inte kansliets och administratörens endpoints (403)', async () => {
    const cookie = await login(lena);
    expect((await call('GET', '/office/reservations', { cookie })).status).toBe(403);
    expect((await call('GET', '/admin/reviews', { cookie })).status).toBe(403);
    expect((await call('GET', '/office/reservations', { cookie: await login(office) })).status).toBe(200);
  });
});

describe('HTTP: börsens filter (3.1)', () => {
  it.each(['2026-02-30', '2026-13-01', 'igår', '2026-1-5'])('ogiltigt datum %s ger 400 i stället för 500', async (d) => {
    const r = await call('GET', `/matches?dateFrom=${encodeURIComponent(d)}`);
    expect(r).toMatchObject({ status: 400, body: { error: 'VALIDATION' } });
    expect((await call('GET', `/matches?dateTo=${encodeURIComponent(d)}`)).status).toBe(400);
  });

  it('ogiltigt födelseår ger 400', async () => {
    expect((await call('GET', '/matches?birthYear=abc')).status).toBe(400);
  });

  it('giltiga filter fungerar', async () => {
    await call('POST', '/matches', { cookie: await login(lena), body: ownSlot() });
    const r = await call('GET', '/matches?dateFrom=2026-10-20&dateTo=2026-10-20&birthYear=2015');
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(1);
    expect((await call('GET', '/matches?dateFrom=2026-10-21')).body).toHaveLength(0);
  });

  it('isValidDate känner igen skottdagar', () => {
    expect(isValidDate('2028-02-29')).toBe(true);
    expect(isValidDate('2026-02-29')).toBe(false);
  });
});

describe('HTTP: Spår 2 från publicering till bekräftad match', () => {
  it('skapar, anmäler intresse och väljer motståndare med rätt statuskoder', async () => {
    const lenaCookie = await login(lena);
    const annaCookie = await login(anna);

    const created = await call('POST', '/matches', { cookie: lenaCookie, body: ownSlot() });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('PUBLISHED');
    const matchId = created.body.id;

    // AC-102.2: gäster ser matchen men inga kontaktuppgifter.
    const anon = await call('GET', `/matches/${matchId}`);
    expect(anon.status).toBe(200);
    expect(anon.body.match.homeContact).toBeUndefined();

    const inq = await call('POST', `/matches/${matchId}/inquiries`, { cookie: annaCookie, body: { teamId: hamTeamId, phone: '+46701234567' } });
    expect(inq.status).toBe(201);

    // Bara hemmalaget får välja motståndare.
    expect((await call('POST', `/matches/${matchId}/select`, { cookie: annaCookie, body: { inquiryId: inq.body.id } })).status).toBe(403);

    const selected = await call('POST', `/matches/${matchId}/select`, { cookie: lenaCookie, body: { inquiryId: inq.body.id } });
    expect(selected).toMatchObject({ status: 200, body: { status: 'MATCH_CONFIRMED' } });

    // BR-16: ett andra klick ger 409.
    const again = await call('POST', `/matches/${matchId}/select`, { cookie: lenaCookie, body: { inquiryId: inq.body.id } });
    expect(again).toMatchObject({ status: 409, body: { error: 'CONFLICT' } });
  });

  it('valideringsfel från domänen ger 400 med svenskt meddelande', async () => {
    const r = await call('POST', '/matches', { cookie: await login(lena), body: ownSlot({ durationMinutes: 5 }) });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/minuter/);
  });
});

describe('HTTP: Spår 1 och kansliet (2.1)', () => {
  it('kansliet kan öppna en match som väntar på plan, andra lag får 404', async () => {
    const created = await call('POST', '/matches', {
      cookie: await login(lena),
      body: ownSlot({ origin: 'NEW_WEEKEND_SLOT', pitchId: undefined, date: '2026-11-07', startTime: '10:00' }),
    });
    expect(created).toMatchObject({ status: 201, body: { status: 'RESERVATION_REQUESTED' } });
    const matchId = created.body.id;

    expect((await call('GET', `/matches/${matchId}`, { cookie: await login(office) })).status).toBe(200);
    expect((await call('GET', `/matches/${matchId}`, { cookie: await login(anna) })).status).toBe(404);
    expect((await call('GET', `/matches/${matchId}`)).status).toBe(404);

    // Process B har tagit emot förfrågan (flush efter anropet) och den ligger i kansliets kö.
    const queue = await call('GET', '/office/reservations', { cookie: await login(office) });
    expect(JSON.stringify(queue.body)).toContain(matchId);
  });
});
