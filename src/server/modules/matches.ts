// Process A: Matchgenomförande (avsnitt 3.1, FR-A-101–107).
// Första utkastet implementerar Spår 2 (egen träningstid). Spår 1 kräver Process B (planbokning).
import type { Ctx } from '../context.js';
import type {
  GameFormat,
  InquiryEntity,
  InquiryStatus,
  LeaderContact,
  Level,
  MatchEntity,
  MatchStatus,
  RefereeArrangement,
  Team,
  TeamCategory,
  User,
} from '../../shared/types.js';
import { GAME_FORMATS, LEVELS, REFEREE_ARRANGEMENTS, TEAM_CATEGORIES } from '../../shared/types.js';
import { isCompatible } from '../../shared/rules.js';
import { addHours, addLocalDays, formatDateTime, formatSlot, localToUtc } from '../../shared/time.js';
import { all, newId, one, run, tx, type SqlParam } from '../infra/db.js';
import { audit, SYSTEM_USER } from '../infra/audit.js';
import { emit } from '../infra/outbox.js';
import { queueEmails } from '../infra/email.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../infra/errors.js';
import {
  getTeam,
  isActiveLeader,
  membershipsForUser,
  publicTeam,
  requireTeam,
  teamLeaderEmails,
} from './identity.js';
import { getPitchWithFacility } from './masterdata.js';

/** AC-107.1 / BR-14: bekräftelse av genomförd match senast 48 h efter sluttid. */
export const CONFIRM_WINDOW_HOURS = 48;
/** AC-107.3 [FÖRSLAG]: påminnelser vid sluttid och 24 h efter sluttid. */
export const REMINDER_OFFSETS_HOURS = [0, 24] as const;
export const REVIEW_PERIOD_DAYS = 7;

// ---------- Persistens ----------

interface MatchRow {
  id: string;
  origin: MatchEntity['origin'];
  home_team_id: string;
  home_contact: string;
  away_team_id: string | null;
  selected_opponent: string | null;
  game_format: GameFormat;
  birth_year: number;
  category: TeamCategory;
  open_to_adjacent_birth_years: number;
  match_level: Level;
  duration_minutes: number;
  facility_id: string;
  pitch_id: string;
  facility_name: string;
  facility_address: string;
  pitch_name: string;
  surface: MatchEntity['venue']['surface'];
  start_time: string;
  end_time: string;
  referee: RefereeArrangement;
  kit_color_home: string;
  status: MatchStatus;
  reservation_id: string | null;
  inquiries_count: number;
  is_urgent: number;
  completed_confirmed_at: string | null;
  created_at: string;
  updated_at: string;
}

const toMatch = (r: MatchRow): MatchEntity => ({
  id: r.id,
  origin: r.origin,
  homeTeamId: r.home_team_id,
  homeContact: JSON.parse(r.home_contact),
  awayTeamId: r.away_team_id ?? undefined,
  selectedOpponent: r.selected_opponent ? JSON.parse(r.selected_opponent) : undefined,
  gameFormat: r.game_format,
  birthYear: r.birth_year,
  category: r.category,
  openToAdjacentBirthYears: r.open_to_adjacent_birth_years === 1,
  matchLevel: r.match_level,
  durationMinutes: r.duration_minutes,
  venue: {
    facilityId: r.facility_id,
    pitchId: r.pitch_id,
    facilityName: r.facility_name,
    facilityAddress: r.facility_address,
    pitchName: r.pitch_name,
    surface: r.surface,
    startTime: r.start_time,
    endTime: r.end_time,
  },
  referee: r.referee,
  kitColorHome: r.kit_color_home,
  status: r.status,
  reservationId: r.reservation_id ?? undefined,
  inquiriesCount: r.inquiries_count,
  isUrgent: r.is_urgent === 1,
  completedConfirmedAt: r.completed_confirmed_at ?? undefined,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

interface InquiryRow {
  id: string;
  match_id: string;
  team_id: string;
  leader_user_id: string;
  contact: string;
  status: InquiryStatus;
  created_at: string;
  updated_at: string;
}

const toInquiry = (r: InquiryRow): InquiryEntity => ({
  id: r.id,
  matchId: r.match_id,
  teamId: r.team_id,
  leaderUserId: r.leader_user_id,
  contact: JSON.parse(r.contact),
  status: r.status,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function getMatch(ctx: Ctx, id: string): MatchEntity | undefined {
  const r = one<MatchRow>(ctx.db, `SELECT * FROM matches WHERE id = ?`, id);
  return r && toMatch(r);
}

function requireMatch(ctx: Ctx, id: string): MatchEntity {
  const m = getMatch(ctx, id);
  if (!m) throw notFound('Matchen finns inte');
  return m;
}

function inquiriesFor(ctx: Ctx, matchId: string, status?: InquiryStatus): InquiryEntity[] {
  return (
    status
      ? all<InquiryRow>(ctx.db, `SELECT * FROM inquiries WHERE match_id = ? AND status = ? ORDER BY created_at`, matchId, status)
      : all<InquiryRow>(ctx.db, `SELECT * FROM inquiries WHERE match_id = ? ORDER BY created_at`, matchId)
  ).map(toInquiry);
}

/**
 * BR-16: statusövergång med kontroll av förväntad nuvarande status i samma transaktion.
 * Kastar Conflict om matchen hunnit ändras.
 */
function transitionMatch(
  ctx: Ctx,
  match: MatchEntity,
  to: MatchStatus,
  opts: { userId: string; rule: string; eventId?: string; set?: Record<string, SqlParam> },
): void {
  const set: Record<string, SqlParam> = { ...(opts.set ?? {}), status: to, updated_at: ctx.clock.nowIso() };
  const cols = Object.keys(set);
  const changed = run(
    ctx.db,
    `UPDATE matches SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ? AND status = ?`,
    ...cols.map((c) => set[c]),
    match.id,
    match.status,
  );
  if (changed !== 1) throw conflict('Matchen har ändrats av någon annan. Ladda om sidan och försök igen.');
  audit(ctx, {
    eventId: opts.eventId,
    userId: opts.userId,
    entityType: 'Match',
    entityId: match.id,
    transition: `${match.status} -> ${to} (${opts.rule})`,
  });
}

function transitionInquiry(ctx: Ctx, inquiry: InquiryEntity, to: InquiryStatus, userId: string, conflictMessage: string): void {
  const changed = run(
    ctx.db,
    `UPDATE inquiries SET status = ?, updated_at = ? WHERE id = ? AND status = ?`,
    to,
    ctx.clock.nowIso(),
    inquiry.id,
    inquiry.status,
  );
  if (changed !== 1) throw conflict(conflictMessage);
  audit(ctx, { userId, entityType: 'Inquiry', entityId: inquiry.id, transition: `${inquiry.status} -> ${to}` });
}

function refreshInquiriesCount(ctx: Ctx, matchId: string): void {
  run(
    ctx.db,
    `UPDATE matches SET inquiries_count = (SELECT COUNT(*) FROM inquiries WHERE match_id = ? AND status = 'ACTIVE') WHERE id = ?`,
    matchId,
    matchId,
  );
}

const PHONE_RE = /^\+?[0-9][0-9 ()-]{5,19}$/;

function contactFor(user: User, team: Team, phone: string): LeaderContact {
  const p = (phone ?? '').trim();
  if (!p) throw badRequest('Telefonnummer är obligatoriskt'); // BR-17
  if (!PHONE_RE.test(p)) throw badRequest('Ogiltigt telefonnummer');
  return { userId: user.id, name: user.name, club: team.clubName, teamName: team.name, email: user.email, phone: p };
}

const matchTitle = (m: MatchEntity) => `${m.homeContact.club} ${m.homeContact.teamName}, ${formatSlot(m.venue.startTime, m.venue.endTime)}`;

// ---------- A2: Skapa match, Spår 2 ----------

export interface CreateOwnSlotInput {
  homeTeamId: string;
  phone: string;
  pitchId: string;
  date: string; // YYYY-MM-DD lokalt
  startTime: string; // HH:mm lokalt
  endTime: string; // HH:mm lokalt
  gameFormat: GameFormat;
  birthYear: number;
  category: TeamCategory;
  openToAdjacentBirthYears: boolean;
  matchLevel: Level;
  durationMinutes: number;
  referee: RefereeArrangement;
  kitColorHome: string;
}

/**
 * AC-101.3 / A2: Spår 2 publiceras direkt. Process B startas inte, och ingen validering
 * av plantillgång eller överlapp görs (BR-02).
 */
export function createOwnSlotMatch(ctx: Ctx, user: User, input: CreateOwnSlotInput): MatchEntity {
  const team = requireTeam(ctx, input.homeTeamId);
  // A2-guard / BR-07 / BR-08 / AC-101.5
  if (!team.isHomeClub) throw forbidden('Endast IFK Lidingö-lag kan skapa matcher');
  if (!isActiveLeader(ctx, user.id, team.id)) throw forbidden('Din koppling till laget är inte godkänd av kansliet');

  if (!GAME_FORMATS.includes(input.gameFormat)) throw badRequest('Ogiltig spelform');
  if (!TEAM_CATEGORIES.includes(input.category)) throw badRequest('Ogiltig kategori');
  if (!LEVELS.includes(input.matchLevel)) throw badRequest('Ogiltig matchnivå');
  if (!REFEREE_ARRANGEMENTS.includes(input.referee)) throw badRequest('Ogiltigt domarupplägg');
  const birthYear = Number(input.birthYear);
  if (!Number.isInteger(birthYear)) throw badRequest('Ogiltigt födelseår');
  const durationMinutes = Number(input.durationMinutes);
  if (!Number.isInteger(durationMinutes) || durationMinutes < 10 || durationMinutes > 180)
    throw badRequest('Speltiden måste vara 10–180 minuter');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date ?? '')) throw badRequest('Datum saknas');
  if (!/^\d{2}:\d{2}$/.test(input.startTime ?? '') || !/^\d{2}:\d{2}$/.test(input.endTime ?? ''))
    throw badRequest('Start- och sluttid måste anges');
  const kit = (input.kitColorHome ?? '').trim();
  if (!kit) throw badRequest('Ange hemmalagets matchställ');

  const startTime = localToUtc(input.date, input.startTime);
  const endTime = localToUtc(input.date, input.endTime);
  if (endTime <= startTime) throw badRequest('Sluttiden måste vara efter starttiden');
  if (startTime <= ctx.clock.nowIso()) throw badRequest('Starttiden har redan passerat');

  const venue = getPitchWithFacility(ctx, input.pitchId);
  if (!venue || !venue.pitch.active || !venue.facility.active) throw badRequest('Välj en aktiv plan ur listan');

  const contact = contactFor(user, team, input.phone);
  const id = newId('mat');
  const now = ctx.clock.nowIso();

  return tx(ctx.db, () => {
    run(
      ctx.db,
      `INSERT INTO matches (id, origin, home_team_id, home_contact, game_format, birth_year, category,
         open_to_adjacent_birth_years, match_level, duration_minutes, facility_id, pitch_id, facility_name,
         facility_address, pitch_name, surface, start_time, end_time, referee, kit_color_home, status,
         inquiries_count, is_urgent, created_at, updated_at)
       VALUES (?, 'OWN_TRAINING_SLOT', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PUBLISHED', 0, 0, ?, ?)`,
      id,
      team.id,
      JSON.stringify(contact),
      input.gameFormat,
      birthYear,
      input.category,
      input.openToAdjacentBirthYears ? 1 : 0,
      input.matchLevel,
      durationMinutes,
      venue.facility.id,
      venue.pitch.id,
      venue.facility.name,
      venue.facility.address,
      venue.pitch.name,
      venue.pitch.surface,
      startTime,
      endTime,
      input.referee,
      kit,
      now,
      now,
    );
    audit(ctx, { userId: user.id, entityType: 'Match', entityId: id, transition: '(start) -> PUBLISHED (A2)' });
    return getMatch(ctx, id)!;
  });
}

// ---------- Börsen ----------

export interface MarketFilters {
  gameFormat?: GameFormat;
  dateFrom?: string; // YYYY-MM-DD lokalt
  dateTo?: string;
  birthYear?: number;
  category?: TeamCategory;
  matchLevel?: Level;
}

/** AC-102.2/102.3: endast PUBLISHED, utan kontaktuppgifter. */
export function listMarket(ctx: Ctx, f: MarketFilters): MatchCard[] {
  const where = [`status = 'PUBLISHED'`, `start_time > ?`];
  const params: SqlParam[] = [ctx.clock.nowIso()];
  if (f.gameFormat) {
    where.push('game_format = ?');
    params.push(f.gameFormat);
  }
  if (f.category) {
    where.push('category = ?');
    params.push(f.category);
  }
  if (f.matchLevel) {
    where.push('match_level = ?');
    params.push(f.matchLevel);
  }
  if (f.birthYear) {
    // Matcher som ett lag med detta födelseår kan anmäla sig till (BR-09).
    where.push('(birth_year = ? OR (open_to_adjacent_birth_years = 1 AND ABS(birth_year - ?) = 1))');
    params.push(f.birthYear, f.birthYear);
  }
  if (f.dateFrom) {
    where.push('start_time >= ?');
    params.push(localToUtc(f.dateFrom, '00:00'));
  }
  if (f.dateTo) {
    where.push('start_time < ?');
    params.push(addLocalDays(localToUtc(f.dateTo, '00:00'), 1));
  }
  const rows = all<MatchRow>(
    ctx.db,
    `SELECT * FROM matches WHERE ${where.join(' AND ')} ORDER BY is_urgent DESC, start_time LIMIT 200`,
    ...params,
  );
  return rows.map((r) => toCard(ctx, toMatch(r)));
}

export type MatchCard = Omit<MatchEntity, 'homeContact' | 'selectedOpponent'> & {
  homeTeam: Team;
  awayTeam?: Team;
};

function toCard(ctx: Ctx, m: MatchEntity): MatchCard {
  const { homeContact: _h, selectedOpponent: _s, ...rest } = m;
  const away = m.awayTeamId ? getTeam(ctx, m.awayTeamId) : undefined;
  return { ...rest, homeTeam: publicTeam(getTeam(ctx, m.homeTeamId)!), awayTeam: away && publicTeam(away) };
}

// ---------- Matchdetalj med behörighetsstyrda fält ----------

export interface InquiryView {
  id: string;
  status: InquiryStatus;
  team: Team;
  createdAt: string;
  /** Kontaktuppgifter visas bara när laget valts (AC-103.2). */
  contact?: LeaderContact;
}

export interface MatchDetail {
  match: MatchCard & { homeContact?: LeaderContact; selectedOpponent?: LeaderContact };
  viewer: {
    isHomeLeader: boolean;
    isAwayLeader: boolean;
    /** Användarens lag som får anmäla intresse (BR-09). */
    eligibleTeams: Array<{ id: string; name: string; clubName: string }>;
    myInquiries: InquiryView[];
  };
  /** Bara för hemmalaget. */
  inquiries?: InquiryView[];
  allowed: {
    inquire: boolean;
    select: boolean;
    cancel: boolean;
    withdrawAsOpponent: boolean;
    confirmCompleted: boolean;
  };
  confirmWindow: { from: string; until: string };
}

export function getMatchDetail(ctx: Ctx, matchId: string, user: User | undefined): MatchDetail {
  const m = requireMatch(ctx, matchId);
  const now = ctx.clock.nowIso();
  const isHomeLeader = !!user && isActiveLeader(ctx, user.id, m.homeTeamId);
  const isAwayLeader = !!user && !!m.awayTeamId && isActiveLeader(ctx, user.id, m.awayTeamId);

  const myTeams = user
    ? membershipsForUser(ctx, user.id).filter((x) => x.approvalStatus === 'APPROVED' || x.approvalStatus === 'NOT_REQUIRED')
    : [];
  const all_ = inquiriesFor(ctx, m.id);
  const myInquiries = all_.filter((i) => myTeams.some((t) => t.teamId === i.teamId));
  const isInvolved = isHomeLeader || isAwayLeader || myInquiries.length > 0;

  // AC-102.3: matcher som inte är PUBLISHED visas bara för inblandade lag.
  if (m.status !== 'PUBLISHED' && !isInvolved) throw notFound('Matchen finns inte på börsen');

  const started = m.venue.startTime <= now;
  const busyTeamIds = new Set(all_.filter((i) => i.status === 'ACTIVE' || i.status === 'SELECTED').map((i) => i.teamId));
  const eligibleTeams = myTeams
    .filter((t) => t.teamId !== m.homeTeamId && !busyTeamIds.has(t.teamId) && isCompatible(m, t.team))
    .map((t) => ({ id: t.team.id, name: t.team.name, clubName: t.team.clubName }));

  const toView = (i: InquiryEntity): InquiryView => ({
    id: i.id,
    status: i.status,
    team: publicTeam(getTeam(ctx, i.teamId)!),
    createdAt: i.createdAt,
    contact: i.status === 'SELECTED' && (isHomeLeader || myTeams.some((t) => t.teamId === i.teamId)) ? i.contact : undefined,
  });

  const card = toCard(ctx, m);
  // Kontaktuppgifter: hemmalaget ser allt, valt lag ser hemmalagets kontakt efter valet. Gäster ser aldrig något.
  const showHome = isHomeLeader || isAwayLeader;
  const confirmFrom = m.venue.endTime;
  const confirmUntil = addHours(m.venue.endTime, CONFIRM_WINDOW_HOURS);

  return {
    match: {
      ...card,
      homeContact: showHome ? m.homeContact : undefined,
      selectedOpponent: showHome ? m.selectedOpponent : undefined,
    },
    viewer: { isHomeLeader, isAwayLeader, eligibleTeams, myInquiries: myInquiries.map(toView) },
    inquiries: isHomeLeader ? all_.map(toView) : undefined,
    allowed: {
      inquire: !!user && m.status === 'PUBLISHED' && !started && eligibleTeams.length > 0,
      select: isHomeLeader && m.status === 'PUBLISHED' && !started && m.inquiriesCount > 0,
      cancel: isHomeLeader && ['RESERVATION_REQUESTED', 'PUBLISHED', 'MATCH_CONFIRMED'].includes(m.status) && !started,
      withdrawAsOpponent: isAwayLeader && m.status === 'MATCH_CONFIRMED' && !started,
      confirmCompleted: isHomeLeader && m.status === 'MATCH_CONFIRMED' && now >= confirmFrom && now <= confirmUntil,
    },
    confirmWindow: { from: confirmFrom, until: confirmUntil },
  };
}

/** Matcher där användarens lag är hemmalag, valt lag eller har anmält intresse. */
export function listMyMatches(ctx: Ctx, user: User) {
  const teamIds = membershipsForUser(ctx, user.id)
    .filter((m) => m.approvalStatus === 'APPROVED' || m.approvalStatus === 'NOT_REQUIRED')
    .map((m) => m.teamId);
  if (teamIds.length === 0) return { home: [], away: [], inquiries: [] };
  const ph = teamIds.map(() => '?').join(',');
  const home = all<MatchRow>(ctx.db, `SELECT * FROM matches WHERE home_team_id IN (${ph}) ORDER BY start_time DESC`, ...teamIds);
  const away = all<MatchRow>(ctx.db, `SELECT * FROM matches WHERE away_team_id IN (${ph}) ORDER BY start_time DESC`, ...teamIds);
  const inq = all<InquiryRow>(
    ctx.db,
    `SELECT * FROM inquiries WHERE team_id IN (${ph}) AND status IN ('ACTIVE','REJECTED','WITHDRAWN') ORDER BY created_at DESC`,
    ...teamIds,
  );
  return {
    home: home.map((r) => toCard(ctx, toMatch(r))),
    away: away.map((r) => toCard(ctx, toMatch(r))),
    inquiries: inq
      .map(toInquiry)
      .map((i) => ({ id: i.id, status: i.status, teamId: i.teamId, match: toCard(ctx, getMatch(ctx, i.matchId)!) })),
  };
}

// ---------- AC-103.1: Intresseanmälan ----------

export function createInquiry(ctx: Ctx, user: User, matchId: string, input: { teamId: string; phone: string }): InquiryEntity {
  return tx(ctx.db, () => {
    const m = requireMatch(ctx, matchId);
    const team = requireTeam(ctx, input.teamId);
    if (!isActiveLeader(ctx, user.id, team.id)) throw forbidden('Du är inte godkänd ledare för laget');
    if (m.status !== 'PUBLISHED' || m.venue.startTime <= ctx.clock.nowIso())
      throw conflict('Matchen tar inte emot intresseanmälningar');
    if (team.id === m.homeTeamId) throw badRequest('Hemmalaget kan inte anmäla intresse till sin egen match');
    if (!isCompatible(m, team)) throw badRequest('Laget matchar inte matchens kategori och födelseår'); // BR-09
    const existing = one(
      ctx.db,
      `SELECT 1 FROM inquiries WHERE match_id = ? AND team_id = ? AND status IN ('ACTIVE','SELECTED')`,
      m.id,
      team.id,
    );
    if (existing) throw conflict('Laget har redan en aktiv intresseanmälan');

    const contact = contactFor(user, team, input.phone);
    const id = newId('inq');
    const now = ctx.clock.nowIso();
    run(
      ctx.db,
      `INSERT INTO inquiries (id, match_id, team_id, leader_user_id, contact, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
      id,
      m.id,
      team.id,
      user.id,
      JSON.stringify(contact),
      now,
      now,
    );
    audit(ctx, { userId: user.id, entityType: 'Inquiry', entityId: id, transition: '(start) -> ACTIVE' });
    refreshInquiriesCount(ctx, m.id);
    // Notifieringsmatris #6
    queueEmails(ctx, teamLeaderEmails(ctx, m.homeTeamId), {
      subject: `Ny intresseanmälan: ${team.clubName} ${team.name}`,
      body: `${team.clubName} ${team.name} vill spela er match ${matchTitle(m)}. Välj motståndare i appen.`,
    });
    return toInquiry(one<InquiryRow>(ctx.db, `SELECT * FROM inquiries WHERE id = ?`, id)!);
  });
}

// ---------- AC-103.3: Dra tillbaka intresse ----------

export function withdrawInquiry(ctx: Ctx, user: User, inquiryId: string): void {
  tx(ctx.db, () => {
    const r = one<InquiryRow>(ctx.db, `SELECT * FROM inquiries WHERE id = ?`, inquiryId);
    if (!r) throw notFound('Intresseanmälan finns inte');
    const inquiry = toInquiry(r);
    if (!isActiveLeader(ctx, user.id, inquiry.teamId)) throw forbidden();
    if (inquiry.status !== 'ACTIVE')
      throw conflict(inquiry.status === 'SELECTED' ? 'Laget är redan valt. Lämna återbud i stället.' : 'Intresseanmälan är inte aktiv');
    transitionInquiry(ctx, inquiry, 'WITHDRAWN', user.id, 'Intresseanmälan har redan ändrats');
    refreshInquiriesCount(ctx, inquiry.matchId);
  });
}

// ---------- A6 / AC-103.2: Hemmalaget väljer motståndare ----------

export function selectOpponent(ctx: Ctx, user: User, matchId: string, inquiryId: string): MatchEntity {
  return tx(ctx.db, () => {
    const m = requireMatch(ctx, matchId);
    if (!isActiveLeader(ctx, user.id, m.homeTeamId)) throw forbidden('Endast hemmalagets ledare kan välja motståndare');
    if (m.status !== 'PUBLISHED') throw conflict('Matchen söker inte motståndare');
    if (m.venue.startTime <= ctx.clock.nowIso()) throw conflict('Matchens starttid har passerat');

    const r = one<InquiryRow>(ctx.db, `SELECT * FROM inquiries WHERE id = ? AND match_id = ?`, inquiryId, m.id);
    if (!r) throw notFound('Intresseanmälan finns inte');
    const chosen = toInquiry(r);
    // AC-103.4 / BR-16: anmälan måste fortfarande vara ACTIVE i samma transaktion.
    if (chosen.status !== 'ACTIVE') throw conflict('Intresseanmälan har dragits tillbaka av motståndaren');
    transitionInquiry(ctx, chosen, 'SELECTED', user.id, 'Intresseanmälan har dragits tillbaka av motståndaren');

    const others = inquiriesFor(ctx, m.id, 'ACTIVE');
    for (const o of others) transitionInquiry(ctx, o, 'REJECTED', user.id, 'Intresseanmälningarna ändrades samtidigt');

    let eventId: string | undefined;
    if (m.reservationId) {
      // Spår 1: RESERVATION_ACCEPTED till Process B (4.4). Används inte i Spår 2.
      eventId = emit(ctx, 'RESERVATION_ACCEPTED', m.id, {
        reservationId: m.reservationId,
        awayTeamId: chosen.teamId,
        opponent: {
          club: chosen.contact.club,
          teamName: chosen.contact.teamName,
          contactName: chosen.contact.name,
          contactPhone: chosen.contact.phone,
        },
      }).eventId;
    }

    transitionMatch(ctx, m, 'MATCH_CONFIRMED', {
      userId: user.id,
      rule: 'A6',
      eventId,
      set: { away_team_id: chosen.teamId, selected_opponent: JSON.stringify(chosen.contact), is_urgent: 0, inquiries_count: 0 },
    });

    const updated = getMatch(ctx, m.id)!;
    // Notifieringsmatris #7 och #8
    const contactText = (c: LeaderContact) => `${c.name}, ${c.club} ${c.teamName}, tel ${c.phone}, e-post ${c.email}`;
    queueEmails(ctx, teamLeaderEmails(ctx, chosen.teamId), {
      subject: `Ni är valda som motståndare: ${matchTitle(m)}`,
      body: `Matchen är bekräftad. Plats: ${m.venue.facilityName} ${m.venue.pitchName}, ${m.venue.facilityAddress}.\nHemmalagets kontakt: ${contactText(m.homeContact)}`,
    });
    queueEmails(ctx, teamLeaderEmails(ctx, m.homeTeamId), {
      subject: `Motståndare bekräftad: ${chosen.contact.club} ${chosen.contact.teamName}`,
      body: `Ni har valt ${chosen.contact.club} ${chosen.contact.teamName} till ${matchTitle(m)}.\nKontakt: ${contactText(chosen.contact)}`,
    });
    for (const o of others) {
      queueEmails(ctx, teamLeaderEmails(ctx, o.teamId), {
        subject: `Annat lag valdes: ${matchTitle(m)}`,
        body: `Hemmalaget valde ett annat lag till matchen. Tack för er anmälan!`,
      });
    }
    return updated;
  });
}

// ---------- A7 / FR-A-104: Återbud från valt lag ----------

/**
 * Valt lag lämnar återbud. Matchen går direkt tillbaka till börsen med röd flagga (A7).
 * Hemmalaget kan sedan välja ny motståndare eller avboka (AC-104.2/104.3).
 */
export function withdrawAsOpponent(ctx: Ctx, user: User, matchId: string): MatchEntity {
  return tx(ctx.db, () => {
    const m = requireMatch(ctx, matchId);
    if (!m.awayTeamId || !isActiveLeader(ctx, user.id, m.awayTeamId)) throw forbidden('Endast valt lag kan lämna återbud');
    if (m.status !== 'MATCH_CONFIRMED') throw conflict('Matchen är inte bekräftad');
    if (m.venue.startTime <= ctx.clock.nowIso()) throw conflict('Matchens starttid har passerat');

    const selected = inquiriesFor(ctx, m.id, 'SELECTED')[0];
    if (selected) transitionInquiry(ctx, selected, 'WITHDRAWN', user.id, 'Intresseanmälan har redan ändrats');

    // BR-04: inget event till Process B, reservationen står kvar som ACCEPTED.
    transitionMatch(ctx, m, 'PUBLISHED', {
      userId: user.id,
      rule: 'A7',
      set: { away_team_id: null, selected_opponent: null, is_urgent: 1 },
    });
    refreshInquiriesCount(ctx, m.id);

    const team = getTeam(ctx, m.awayTeamId)!;
    // Notifieringsmatris #9 (akut)
    queueEmails(ctx, teamLeaderEmails(ctx, m.homeTeamId), {
      urgent: true,
      subject: `ÅTERBUD: ${team.clubName} ${team.name} kan inte spela`,
      body: `${team.clubName} ${team.name} har lämnat återbud till ${matchTitle(m)}. Matchen ligger åter på börsen med röd flagga. Välj en ny motståndare eller avboka matchen.`,
    });
    return getMatch(ctx, m.id)!;
  });
}

// ---------- A5 / A8 / A9 / FR-A-105: Hemmalaget avbokar ----------

export function cancelMatch(ctx: Ctx, user: User, matchId: string): MatchEntity {
  return tx(ctx.db, () => {
    const m = requireMatch(ctx, matchId);
    if (!isActiveLeader(ctx, user.id, m.homeTeamId)) throw forbidden('Endast hemmalagets ledare kan avboka');
    const rule = ({ RESERVATION_REQUESTED: 'A5', PUBLISHED: 'A8', MATCH_CONFIRMED: 'A9' } as Partial<Record<MatchStatus, string>>)[m.status];
    if (!rule) throw conflict('Matchen kan inte avbokas i nuvarande läge');
    if (m.status !== 'RESERVATION_REQUESTED' && m.venue.startTime <= ctx.clock.nowIso())
      throw conflict('Matchens starttid har passerat');

    let eventId: string | undefined;
    if (m.reservationId) {
      // Spår 1: plantiden frigörs i Process B (4.5).
      eventId = emit(ctx, 'RESERVATION_WITHDRAWN', m.id, { reservationId: m.reservationId }).eventId;
    }
    transitionMatch(ctx, m, 'CANCELLED', { userId: user.id, rule, eventId });

    // Notifieringsmatris #10
    const recipients =
      m.status === 'MATCH_CONFIRMED' && m.awayTeamId
        ? teamLeaderEmails(ctx, m.awayTeamId)
        : inquiriesFor(ctx, m.id, 'ACTIVE').flatMap((i) => teamLeaderEmails(ctx, i.teamId));
    queueEmails(ctx, recipients, {
      subject: `Matchen är avbokad: ${matchTitle(m)}`,
      body: `Hemmalaget har avbokat matchen ${matchTitle(m)}.`,
    });
    return getMatch(ctx, m.id)!;
  });
}

// ---------- A13 / FR-A-107: Bekräfta genomförd match ----------

export function confirmCompleted(ctx: Ctx, user: User, matchId: string): MatchEntity {
  return tx(ctx.db, () => {
    const m = requireMatch(ctx, matchId);
    if (!isActiveLeader(ctx, user.id, m.homeTeamId)) throw forbidden('Endast hemmalagets ledare kan bekräfta matchen');
    if (m.status !== 'MATCH_CONFIRMED') throw conflict('Matchen kan inte bekräftas i nuvarande läge');
    const now = ctx.clock.nowIso();
    if (now < m.venue.endTime) throw new AppError(409, 'TOO_EARLY', 'Matchen kan bekräftas först efter sluttid');
    if (now > addHours(m.venue.endTime, CONFIRM_WINDOW_HOURS))
      throw new AppError(409, 'TOO_LATE', 'Fristen på 48 timmar för att bekräfta matchen har passerat');

    // 4.8: reservationId saknas i Spår 2, eventet dirigeras då bara till Process C.
    const event = emit(ctx, 'MATCH_COMPLETED', m.id, {
      ...(m.reservationId ? { reservationId: m.reservationId } : {}),
      homeTeamId: m.homeTeamId,
      awayTeamId: m.awayTeamId,
      startTime: m.venue.startTime,
      endTime: m.venue.endTime,
      completedConfirmedAt: now,
      reviewDeadlineAt: addLocalDays(now, REVIEW_PERIOD_DAYS),
    });
    transitionMatch(ctx, m, 'COMPLETED', { userId: user.id, rule: 'A13', eventId: event.eventId, set: { completed_confirmed_at: now } });
    return getMatch(ctx, m.id)!;
  });
}

// ---------- Tidsstyrda övergångar (A12, A14, AC-107.3) ----------

/** Körs periodiskt av schemaläggaren. Varje match hanteras i en egen transaktion. */
export function runMatchTimers(ctx: Ctx): { expired: number; reminders: number } {
  const now = ctx.clock.nowIso();
  let expired = 0;
  let reminders = 0;

  // A12 / AC-106.1: ingen motståndare vid starttid.
  for (const r of all<MatchRow>(ctx.db, `SELECT * FROM matches WHERE status = 'PUBLISHED' AND start_time <= ?`, now)) {
    const m = toMatch(r);
    try {
      tx(ctx.db, () => {
        // MATCH_EXPIRED skickas bara när en Spår 1-reservation är ACCEPTED (4.9). Det kan inte gälla en
        // PUBLISHED Spår 2-match; hanteras när Process B finns.
        transitionMatch(ctx, m, 'EXPIRED', { userId: SYSTEM_USER, rule: 'A12' });
        // Notifieringsmatris #14
        queueEmails(
          ctx,
          [...teamLeaderEmails(ctx, m.homeTeamId), ...inquiriesFor(ctx, m.id, 'ACTIVE').flatMap((i) => teamLeaderEmails(ctx, i.teamId))],
          { subject: `Matchen utgick utan motståndare: ${matchTitle(m)}`, body: `Ingen motståndare valdes före starttid.` },
        );
      });
      expired++;
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
    }
  }

  // A14 / AC-107.2: ingen bekräftelse inom 48 h efter sluttid.
  const confirmDeadline = addHours(now, -CONFIRM_WINDOW_HOURS);
  for (const r of all<MatchRow>(ctx.db, `SELECT * FROM matches WHERE status = 'MATCH_CONFIRMED' AND end_time < ?`, confirmDeadline)) {
    const m = toMatch(r);
    try {
      tx(ctx.db, () => {
        const eventId = m.reservationId
          ? emit(ctx, 'MATCH_EXPIRED', m.id, { reservationId: m.reservationId, reason: 'NOT_CONFIRMED_WITHIN_48H' }).eventId
          : undefined;
        transitionMatch(ctx, m, 'EXPIRED', { userId: SYSTEM_USER, rule: 'A14', eventId });
        // Notifieringsmatris #17
        queueEmails(ctx, teamLeaderEmails(ctx, m.homeTeamId), {
          subject: `Matchen bekräftades inte: ${matchTitle(m)}`,
          body: `Matchen bekräftades inte som genomförd inom 48 timmar och har markerats som utgången. Inga Fair Play-recensioner skapas.`,
        });
      });
      expired++;
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
    }
  }

  // AC-107.3: påminnelser om att bekräfta "Match genomförd".
  for (const r of all<MatchRow>(ctx.db, `SELECT * FROM matches WHERE status = 'MATCH_CONFIRMED' AND end_time <= ?`, now)) {
    const m = toMatch(r);
    REMINDER_OFFSETS_HOURS.forEach((offset, idx) => {
      if (now < addHours(m.venue.endTime, offset)) return;
      const kind = `CONFIRM_COMPLETED_${idx + 1}`;
      tx(ctx.db, () => {
        const inserted = run(
          ctx.db,
          `INSERT OR IGNORE INTO reminders_sent (match_id, kind, sent_at) VALUES (?, ?, ?)`,
          m.id,
          kind,
          now,
        );
        if (!inserted) return;
        // Notifieringsmatris #15 och #16
        queueEmails(ctx, teamLeaderEmails(ctx, m.homeTeamId), {
          subject: `Påminnelse: bekräfta att matchen genomförts`,
          body: `Bekräfta "Match genomförd" för ${matchTitle(m)} senast ${formatDateTime(addHours(m.venue.endTime, CONFIRM_WINDOW_HOURS))}. Annars skapas inga Fair Play-recensioner.`,
        });
        reminders++;
      });
    });
  }

  return { expired, reminders };
}
