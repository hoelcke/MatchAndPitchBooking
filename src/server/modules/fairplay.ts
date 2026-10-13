// Process C: Fair Play-recension (avsnitt 3.3, FR-C-301–303) och lagprofilens aggregat (BR-13).
import type { Ctx } from '../context.js';
import type { FairPlayReviewEntity, Level, OutboxEvent, ReviewStatus, SpectatorsScore, User } from '../../shared/types.js';
import { LEVELS } from '../../shared/types.js';
import { medianLevel, PROFILE_MIN_REVIEWS, PROFILE_WINDOW, roundOneDecimal, totalScore } from '../../shared/rules.js';
import { all, newId, one, run, tx } from '../infra/db.js';
import { audit, SYSTEM_USER } from '../infra/audit.js';
import { emit } from '../infra/outbox.js';
import { queueEmails } from '../infra/email.js';
import { badRequest, conflict, forbidden, notFound } from '../infra/errors.js';
import { getTeam, isActiveLeader, membershipsForUser, publicTeam, teamLeaderEmails } from './identity.js';
import { getMatch } from './matches.js';

interface ReviewRow {
  id: string;
  match_id: string;
  reviewing_team_id: string;
  reviewed_team_id: string;
  target_role: 'HOME' | 'AWAY';
  players_score: number | null;
  leaders_score: number | null;
  spectators_score: string | null;
  total_score: number | null;
  assessed_level: Level | null;
  status: ReviewStatus;
  deadline_at: string;
  submitted_at: string | null;
  published_at: string | null;
}

const toReview = (r: ReviewRow): FairPlayReviewEntity => ({
  id: r.id,
  matchId: r.match_id,
  reviewingTeamId: r.reviewing_team_id,
  reviewedTeamId: r.reviewed_team_id,
  targetRole: r.target_role,
  playersScore: (r.players_score ?? undefined) as FairPlayReviewEntity['playersScore'],
  leadersScore: (r.leaders_score ?? undefined) as FairPlayReviewEntity['leadersScore'],
  spectatorsScore:
    r.spectators_score === null
      ? undefined
      : r.spectators_score === 'NOT_APPLICABLE'
        ? 'NOT_APPLICABLE'
        : (Number(r.spectators_score) as 1 | 2 | 3),
  totalScore: r.total_score ?? undefined,
  assessedLevel: r.assessed_level ?? undefined,
  status: r.status,
  deadlineAt: r.deadline_at,
  submittedAt: r.submitted_at ?? undefined,
});

function reviewsForMatch(ctx: Ctx, matchId: string): FairPlayReviewEntity[] {
  return all<ReviewRow>(ctx.db, `SELECT * FROM fair_play_reviews WHERE match_id = ?`, matchId).map(toReview);
}

function setReviewStatus(ctx: Ctx, review: FairPlayReviewEntity, to: ReviewStatus, rule: string, userId: string): void {
  const now = ctx.clock.nowIso();
  const changed = run(
    ctx.db,
    `UPDATE fair_play_reviews SET status = ?, published_at = CASE WHEN ? = 'PUBLISHED' THEN ? ELSE published_at END
     WHERE id = ? AND status = ?`,
    to,
    to,
    now,
    review.id,
    review.status,
  );
  if (changed !== 1) throw conflict('Recensionen har ändrats samtidigt');
  audit(ctx, { userId, entityType: 'FairPlayReview', entityId: review.id, transition: `${review.status} -> ${to} (${rule})` });
}

// ---------- C1: MATCH_COMPLETED skapar två instanser ----------

export function onMatchCompleted(ctx: Ctx, event: OutboxEvent): 'HANDLED' | 'IGNORED' {
  const p = event.payload as { homeTeamId: string; awayTeamId: string; reviewDeadlineAt: string };
  if (reviewsForMatch(ctx, event.matchId).length > 0) return 'IGNORED';
  const match = getMatch(ctx, event.matchId);
  const instances: Array<[string, string, 'HOME' | 'AWAY']> = [
    [p.homeTeamId, p.awayTeamId, 'AWAY'], // C1: hemmalaget recenserar bortalaget
    [p.awayTeamId, p.homeTeamId, 'HOME'], // C2: bortalaget recenserar hemmalaget
  ];
  for (const [reviewing, reviewed, role] of instances) {
    const id = newId('rev');
    run(
      ctx.db,
      `INSERT INTO fair_play_reviews (id, match_id, reviewing_team_id, reviewed_team_id, target_role, status, deadline_at)
       VALUES (?, ?, ?, ?, ?, 'PENDING', ?)`,
      id,
      event.matchId,
      reviewing,
      reviewed,
      role,
      p.reviewDeadlineAt,
    );
    audit(ctx, { eventId: event.eventId, userId: SYSTEM_USER, entityType: 'FairPlayReview', entityId: id, transition: '(start) -> PENDING (C1)' });
    const other = getTeam(ctx, reviewed)!;
    // Notifieringsmatris #18
    queueEmails(ctx, teamLeaderEmails(ctx, reviewing), {
      subject: `Fair Play: recensera ${other.clubName} ${other.name}`,
      body: `Tack för matchen${match ? ` på ${match.venue.facilityName}` : ''}! Lämna en Fair Play-recension inom 7 dagar. Motståndaren ser aldrig din enskilda recension.`,
    });
  }
  return 'HANDLED';
}

// ---------- C2/C3: Inlämning ----------

export interface ReviewInput {
  playersScore: number;
  leadersScore: number;
  spectatorsScore: SpectatorsScore;
  assessedLevel: Level;
}

const isScore = (n: unknown): n is 1 | 2 | 3 => n === 1 || n === 2 || n === 3;

export function submitReview(ctx: Ctx, user: User, reviewId: string, input: ReviewInput): FairPlayReviewEntity {
  // AC-301.3: spelare, ledare och nivå obligatoriska; publik får vara "ej tillämpligt".
  if (!isScore(input.playersScore) || !isScore(input.leadersScore)) throw badRequest('Betygsätt spelare och ledare (1–3)');
  if (!(isScore(input.spectatorsScore) || input.spectatorsScore === 'NOT_APPLICABLE'))
    throw badRequest('Betygsätt publiken eller välj "ej tillämpligt"');
  if (!LEVELS.includes(input.assessedLevel)) throw badRequest('Bedöm motståndarens nivå');

  return tx(ctx.db, () => {
    const r = one<ReviewRow>(ctx.db, `SELECT * FROM fair_play_reviews WHERE id = ?`, reviewId);
    if (!r) throw notFound('Recensionen finns inte');
    const review = toReview(r);
    if (!isActiveLeader(ctx, user.id, review.reviewingTeamId)) throw forbidden();
    if (review.status !== 'PENDING') throw conflict('Recensionen är redan inskickad eller stängd');
    const now = ctx.clock.nowIso();
    if (now > review.deadlineAt) throw conflict('Fristen för recensionen har passerat');

    const changed = run(
      ctx.db,
      `UPDATE fair_play_reviews SET players_score = ?, leaders_score = ?, spectators_score = ?, total_score = ?,
         assessed_level = ?, status = 'SUBMITTED', submitted_at = ? WHERE id = ? AND status = 'PENDING'`,
      input.playersScore,
      input.leadersScore,
      String(input.spectatorsScore),
      totalScore(input.playersScore, input.leadersScore, input.spectatorsScore),
      input.assessedLevel,
      now,
      review.id,
    );
    if (changed !== 1) throw conflict('Recensionen har ändrats samtidigt');
    audit(ctx, { userId: user.id, entityType: 'FairPlayReview', entityId: review.id, transition: 'PENDING -> SUBMITTED (C2)' });

    // C3: båda inskickade -> båda publiceras samtidigt (BR-05).
    const both = reviewsForMatch(ctx, review.matchId);
    if (both.every((x) => x.status === 'SUBMITTED')) {
      for (const x of both) publish(ctx, x, 'C3', user.id);
    }
    return toReview(one<ReviewRow>(ctx.db, `SELECT * FROM fair_play_reviews WHERE id = ?`, review.id)!);
  });
}

function publish(ctx: Ctx, review: FairPlayReviewEntity, rule: string, userId: string): void {
  setReviewStatus(ctx, review, 'PUBLISHED', rule, userId);
  const profile = recomputeTeamProfile(ctx, review.reviewedTeamId);
  // 4.10: lagprofilens beräknade värden efter att recensionen räknats in.
  emit(ctx, 'REVIEW_AGGREGATED', review.matchId, {
    teamId: review.reviewedTeamId,
    assessedLevel: profile.assessedLevel,
    fairPlayAverage: profile.fairPlayAverage === undefined ? undefined : roundOneDecimal(profile.fairPlayAverage),
    reviewCount: profile.reviewCount,
    visible: profile.visible,
  });
}

// ---------- C4/C5: Frist ----------

export function runReviewDeadlines(ctx: Ctx): number {
  const now = ctx.clock.nowIso();
  const matchIds = all<{ match_id: string }>(
    ctx.db,
    `SELECT DISTINCT match_id FROM fair_play_reviews WHERE status IN ('PENDING','SUBMITTED') AND deadline_at < ?`,
    now,
  ).map((r) => r.match_id);
  for (const matchId of matchIds) {
    tx(ctx.db, () => {
      for (const review of reviewsForMatch(ctx, matchId)) {
        if (review.status === 'SUBMITTED') publish(ctx, review, 'C4', SYSTEM_USER);
        else if (review.status === 'PENDING') setReviewStatus(ctx, review, 'EXPIRED', 'C5', SYSTEM_USER);
      }
    });
  }
  return matchIds.length;
}

// ---------- BR-13: Lagprofil ----------

export function recomputeTeamProfile(ctx: Ctx, teamId: string) {
  const window = all<{ total_score: number; assessed_level: Level }>(
    ctx.db,
    `SELECT total_score, assessed_level FROM fair_play_reviews
     WHERE reviewed_team_id = ? AND status = 'PUBLISHED' ORDER BY published_at DESC, submitted_at DESC LIMIT ?`,
    teamId,
    PROFILE_WINDOW,
  );
  const reviewCount = window.length;
  const assessedLevel = medianLevel(window.map((w) => w.assessed_level));
  const fairPlayAverage = reviewCount ? window.reduce((s, w) => s + w.total_score, 0) / reviewCount : undefined;
  const visible = reviewCount >= PROFILE_MIN_REVIEWS;
  run(
    ctx.db,
    `UPDATE teams SET profile_assessed_level = ?, profile_fair_play_average = ?, profile_review_count = ?, profile_visible = ? WHERE id = ?`,
    assessedLevel ?? null,
    fairPlayAverage ?? null,
    reviewCount,
    visible ? 1 : 0,
    teamId,
  );
  return { assessedLevel, fairPlayAverage, reviewCount, visible };
}

// ---------- Läsning ----------

/** Recensioner som användarens lag ska lämna. Visar aldrig recensioner om det egna laget (AC-302.4). */
export function listMyReviews(ctx: Ctx, user: User) {
  const teamIds = membershipsForUser(ctx, user.id)
    .filter((m) => m.approvalStatus === 'APPROVED' || m.approvalStatus === 'NOT_REQUIRED')
    .map((m) => m.teamId);
  if (!teamIds.length) return [];
  const rows = all<ReviewRow>(
    ctx.db,
    `SELECT * FROM fair_play_reviews WHERE reviewing_team_id IN (${teamIds.map(() => '?').join(',')}) ORDER BY deadline_at DESC`,
    ...teamIds,
  );
  return rows.map(toReview).map((r) => {
    const m = getMatch(ctx, r.matchId)!;
    return {
      ...r,
      reviewingTeam: publicTeam(getTeam(ctx, r.reviewingTeamId)!),
      reviewedTeam: publicTeam(getTeam(ctx, r.reviewedTeamId)!),
      match: { id: m.id, startTime: m.venue.startTime, endTime: m.venue.endTime, facilityName: m.venue.facilityName },
    };
  });
}

/** AC-302.4: administratören kan läsa enskilda recensioner. */
export function listAllReviews(ctx: Ctx) {
  return all<ReviewRow>(ctx.db, `SELECT * FROM fair_play_reviews ORDER BY deadline_at DESC LIMIT 500`)
    .map(toReview)
    .map((r) => ({ ...r, reviewingTeam: getTeam(ctx, r.reviewingTeamId)!, reviewedTeam: getTeam(ctx, r.reviewedTeamId)! }));
}
