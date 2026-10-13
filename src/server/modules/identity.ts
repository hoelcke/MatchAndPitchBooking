// Konton, sessioner, lagprofiler och ledarkopplingar (avsnitt 1.5, 1.6, FR-U-001–003).
import { randomBytes } from 'node:crypto';
import type { Ctx } from '../context.js';
import type { ApprovalStatus, Team, TeamCategory, TeamMembership, User, UserRole } from '../../shared/types.js';
import { TEAM_CATEGORIES } from '../../shared/types.js';
import { HOME_CLUB_NAME } from '../../shared/rules.js';
import { all, newId, one, run, tx } from '../infra/db.js';
import { audit } from '../infra/audit.js';
import { queueEmail, queueEmails } from '../infra/email.js';
import { badRequest, conflict, forbidden, notFound } from '../infra/errors.js';

// ---------- Användare ----------

interface UserRow {
  id: string;
  role: UserRole;
  name: string;
  email: string;
  google_subject: string | null;
  created_at: string;
}

const toUser = (r: UserRow): User => ({
  id: r.id,
  role: r.role,
  name: r.name,
  email: r.email,
  googleSubject: r.google_subject ?? undefined,
  createdAt: r.created_at,
});

export function getUser(ctx: Ctx, id: string): User | undefined {
  const r = one<UserRow>(ctx.db, `SELECT * FROM users WHERE id = ?`, id);
  return r && toUser(r);
}

export function createUser(ctx: Ctx, u: { name: string; email: string; role: UserRole; googleSubject?: string; id?: string }): User {
  const id = u.id ?? newId('usr');
  run(
    ctx.db,
    `INSERT INTO users (id, role, name, email, google_subject, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    id,
    u.role,
    u.name,
    u.email.toLowerCase(),
    u.googleSubject ?? null,
    ctx.clock.nowIso(),
  );
  return getUser(ctx, id)!;
}

/** AC-U-001.1: konto skapas vid första Google-inloggningen. */
export function upsertGoogleUser(
  ctx: Ctx,
  identity: { subject: string; email: string; name: string },
  roleFor: (email: string) => UserRole,
): User {
  return tx(ctx.db, () => {
    const bySubject = one<UserRow>(ctx.db, `SELECT * FROM users WHERE google_subject = ?`, identity.subject);
    if (bySubject) return toUser(bySubject);
    const byEmail = one<UserRow>(ctx.db, `SELECT * FROM users WHERE email = ?`, identity.email.toLowerCase());
    if (byEmail) {
      run(ctx.db, `UPDATE users SET google_subject = ? WHERE id = ?`, identity.subject, byEmail.id);
      return getUser(ctx, byEmail.id)!;
    }
    return createUser(ctx, {
      name: identity.name,
      email: identity.email,
      role: roleFor(identity.email),
      googleSubject: identity.subject,
    });
  });
}

export function listUsers(ctx: Ctx): User[] {
  return all<UserRow>(ctx.db, `SELECT * FROM users ORDER BY role, name`).map(toUser);
}

export function emailsByRole(ctx: Ctx, role: UserRole): string[] {
  return all<{ email: string }>(ctx.db, `SELECT email FROM users WHERE role = ?`, role).map((r) => r.email);
}

// ---------- Sessioner ----------

const SESSION_DAYS = 30;

export function createSession(ctx: Ctx, userId: string): { token: string; expiresAt: string } {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
  run(ctx.db, `INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`, token, userId, expiresAt);
  return { token, expiresAt };
}

export function userForSession(ctx: Ctx, token: string): User | undefined {
  const s = one<{ user_id: string; expires_at: string }>(ctx.db, `SELECT user_id, expires_at FROM sessions WHERE token = ?`, token);
  if (!s || s.expires_at < new Date().toISOString()) return undefined;
  return getUser(ctx, s.user_id);
}

export function deleteSession(ctx: Ctx, token: string): void {
  run(ctx.db, `DELETE FROM sessions WHERE token = ?`, token);
}

// ---------- Lag ----------

interface TeamRow {
  id: string;
  name: string;
  club_name: string;
  is_home_club: number;
  birth_year: number;
  category: TeamCategory;
  profile_assessed_level: string | null;
  profile_fair_play_average: number | null;
  profile_review_count: number;
  profile_visible: number;
}

export const toTeam = (r: TeamRow): Team => ({
  id: r.id,
  name: r.name,
  clubName: r.club_name,
  isHomeClub: r.is_home_club === 1,
  birthYear: r.birth_year,
  category: r.category,
  profile: {
    assessedLevel: (r.profile_assessed_level ?? undefined) as Team['profile']['assessedLevel'],
    fairPlayAverage: r.profile_fair_play_average ?? undefined,
    reviewCount: r.profile_review_count,
    visible: r.profile_visible === 1,
  },
});

/** Lagprofilens aggregat visas bara när visible = true (AC-303.2). */
export function publicTeam(team: Team): Team {
  if (team.profile.visible) return team;
  return { ...team, profile: { reviewCount: team.profile.reviewCount, visible: false } };
}

export function getTeam(ctx: Ctx, id: string): Team | undefined {
  const r = one<TeamRow>(ctx.db, `SELECT * FROM teams WHERE id = ?`, id);
  return r && toTeam(r);
}

export function requireTeam(ctx: Ctx, id: string): Team {
  const t = getTeam(ctx, id);
  if (!t) throw notFound('Laget finns inte');
  return t;
}

export function listTeams(ctx: Ctx): Team[] {
  return all<TeamRow>(ctx.db, `SELECT * FROM teams ORDER BY club_name, birth_year DESC, name`).map(toTeam);
}

// ---------- Ledarkopplingar ----------

interface MembershipRow {
  id: string;
  user_id: string;
  team_id: string;
  approval_status: ApprovalStatus;
  decided_by_user_id: string | null;
  decided_at: string | null;
  created_at: string;
}

const toMembership = (r: MembershipRow): TeamMembership => ({
  id: r.id,
  userId: r.user_id,
  teamId: r.team_id,
  approvalStatus: r.approval_status,
  decidedByUserId: r.decided_by_user_id ?? undefined,
  decidedAt: r.decided_at ?? undefined,
  createdAt: r.created_at,
});

/** En koppling ger lagledarbehörighet om den är godkänd, eller inte kräver godkännande (externa lag). */
export const ACTIVE_MEMBERSHIP = `('APPROVED','NOT_REQUIRED')`;

export function membershipsForUser(ctx: Ctx, userId: string): Array<TeamMembership & { team: Team }> {
  return all<MembershipRow>(ctx.db, `SELECT * FROM team_memberships WHERE user_id = ? ORDER BY created_at`, userId).map(
    (r) => ({ ...toMembership(r), team: getTeam(ctx, r.team_id)! }),
  );
}

export function isActiveLeader(ctx: Ctx, userId: string, teamId: string): boolean {
  return !!one(
    ctx.db,
    `SELECT 1 FROM team_memberships WHERE user_id = ? AND team_id = ? AND approval_status IN ${ACTIVE_MEMBERSHIP}`,
    userId,
    teamId,
  );
}

export function requireActiveLeader(ctx: Ctx, userId: string, teamId: string): void {
  if (!isActiveLeader(ctx, userId, teamId)) throw forbidden('Du är inte godkänd ledare för laget');
}

/** E-post till alla aktiva ledare för ett lag. */
export function teamLeaderEmails(ctx: Ctx, teamId: string): string[] {
  return all<{ email: string }>(
    ctx.db,
    `SELECT u.email FROM team_memberships m JOIN users u ON u.id = m.user_id
     WHERE m.team_id = ? AND m.approval_status IN ${ACTIVE_MEMBERSHIP}`,
    teamId,
  ).map((r) => r.email);
}

export interface CreateTeamInput {
  isHomeClub: boolean;
  clubName?: string;
  name: string;
  birthYear: number;
  category: TeamCategory;
}

/** AC-U-002.1/2: ledaren skapar en lagprofil och kopplas till den. */
export function createTeam(ctx: Ctx, user: User, input: CreateTeamInput): { team: Team; membership: TeamMembership } {
  const name = (input.name ?? '').trim();
  const clubName = input.isHomeClub ? HOME_CLUB_NAME : (input.clubName ?? '').trim();
  const birthYear = Number(input.birthYear);
  const thisYear = ctx.clock.now().getUTCFullYear();
  if (!name) throw badRequest('Lagnamn saknas');
  if (!clubName) throw badRequest('Klubbnamn saknas');
  if (!Number.isInteger(birthYear) || birthYear < thisYear - 25 || birthYear > thisYear - 4)
    throw badRequest('Ogiltigt födelseår');
  if (!TEAM_CATEGORIES.includes(input.category)) throw badRequest('Ogiltig kategori');
  if (!input.isHomeClub && clubName.toLowerCase() === HOME_CLUB_NAME.toLowerCase())
    throw badRequest(`Välj "${HOME_CLUB_NAME}-lag" för lag i ${HOME_CLUB_NAME}`);

  return tx(ctx.db, () => {
    const id = newId('team');
    run(
      ctx.db,
      `INSERT INTO teams (id, name, club_name, is_home_club, birth_year, category, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      name,
      clubName,
      input.isHomeClub ? 1 : 0,
      birthYear,
      input.category,
      ctx.clock.nowIso(),
    );
    audit(ctx, { userId: user.id, entityType: 'Team', entityId: id, transition: '(start) -> CREATED' });
    const membership = addMembership(ctx, user, id);
    return { team: getTeam(ctx, id)!, membership };
  });
}

/** AC-U-002.3: en andra ledare kopplar sig till ett befintligt lag. */
export function joinTeam(ctx: Ctx, user: User, teamId: string): TeamMembership {
  return tx(ctx.db, () => {
    requireTeam(ctx, teamId);
    const existing = one<MembershipRow>(ctx.db, `SELECT * FROM team_memberships WHERE user_id = ? AND team_id = ?`, user.id, teamId);
    if (existing && existing.approval_status !== 'REJECTED') throw conflict('Du är redan kopplad till laget');
    if (existing) {
      // En avslagen koppling kan sökas på nytt.
      run(
        ctx.db,
        `UPDATE team_memberships SET approval_status = 'PENDING', decided_by_user_id = NULL, decided_at = NULL WHERE id = ?`,
        existing.id,
      );
      audit(ctx, { userId: user.id, entityType: 'TeamMembership', entityId: existing.id, transition: 'REJECTED -> PENDING' });
      notifyOfficeOfPendingMembership(ctx, user, requireTeam(ctx, teamId));
      return toMembership(one<MembershipRow>(ctx.db, `SELECT * FROM team_memberships WHERE id = ?`, existing.id)!);
    }
    return addMembership(ctx, user, teamId);
  });
}

function addMembership(ctx: Ctx, user: User, teamId: string): TeamMembership {
  const team = requireTeam(ctx, teamId);
  const status: ApprovalStatus = team.isHomeClub ? 'PENDING' : 'NOT_REQUIRED';
  const id = newId('mem');
  run(
    ctx.db,
    `INSERT INTO team_memberships (id, user_id, team_id, approval_status, created_at) VALUES (?, ?, ?, ?, ?)`,
    id,
    user.id,
    teamId,
    status,
    ctx.clock.nowIso(),
  );
  audit(ctx, { userId: user.id, entityType: 'TeamMembership', entityId: id, transition: `(start) -> ${status}` });
  if (status === 'PENDING') notifyOfficeOfPendingMembership(ctx, user, team);
  return toMembership(one<MembershipRow>(ctx.db, `SELECT * FROM team_memberships WHERE id = ?`, id)!);
}

function notifyOfficeOfPendingMembership(ctx: Ctx, user: User, team: Team) {
  // Notifieringsmatris #1
  queueEmails(ctx, emailsByRole(ctx, 'OFFICE'), {
    subject: `Ledarkoppling väntar på godkännande: ${team.name}`,
    body: `${user.name} (${user.email}) vill bli ledare för ${team.clubName} ${team.name}. Godkänn eller avslå i kansliets vy.`,
  });
}

export function listMemberships(ctx: Ctx, status?: ApprovalStatus) {
  const rows = status
    ? all<MembershipRow>(ctx.db, `SELECT * FROM team_memberships WHERE approval_status = ? ORDER BY created_at`, status)
    : all<MembershipRow>(
        ctx.db,
        `SELECT m.* FROM team_memberships m JOIN teams t ON t.id = m.team_id WHERE t.is_home_club = 1 ORDER BY m.created_at DESC`,
      );
  return rows.map((r) => {
    const u = getUser(ctx, r.user_id)!;
    return { ...toMembership(r), team: getTeam(ctx, r.team_id)!, user: { id: u.id, name: u.name, email: u.email } };
  });
}

/** FR-U-003: kansliet godkänner eller avslår en IFK Lidingö-koppling. */
export function decideMembership(ctx: Ctx, officeUser: User, membershipId: string, approve: boolean): TeamMembership {
  return tx(ctx.db, () => {
    const m = one<MembershipRow>(ctx.db, `SELECT * FROM team_memberships WHERE id = ?`, membershipId);
    if (!m) throw notFound('Kopplingen finns inte');
    const to: ApprovalStatus = approve ? 'APPROVED' : 'REJECTED';
    const changed = run(
      ctx.db,
      `UPDATE team_memberships SET approval_status = ?, decided_by_user_id = ?, decided_at = ?
       WHERE id = ? AND approval_status = 'PENDING'`,
      to,
      officeUser.id,
      ctx.clock.nowIso(),
      membershipId,
    );
    if (changed !== 1) throw conflict('Kopplingen är inte längre väntande');
    audit(ctx, { userId: officeUser.id, entityType: 'TeamMembership', entityId: m.id, transition: `PENDING -> ${to}` });
    const leader = getUser(ctx, m.user_id)!;
    const team = getTeam(ctx, m.team_id)!;
    // Notifieringsmatris #2
    queueEmail(ctx, {
      to: leader.email,
      subject: approve ? `Du är godkänd som ledare för ${team.name}` : `Din ledarkoppling till ${team.name} avslogs`,
      body: approve
        ? `Kansliet har godkänt dig som ledare för ${team.clubName} ${team.name}. Du kan nu skapa träningsmatcher.`
        : `Kansliet har avslagit din koppling till ${team.clubName} ${team.name}. Kontakta kansliet vid frågor.`,
    });
    return toMembership(one<MembershipRow>(ctx.db, `SELECT * FROM team_memberships WHERE id = ?`, membershipId)!);
  });
}
