// Domäntyper enligt kravspecifikationen v1.1.1, avsnitt 2.
// Alla tidsfält av typen string är ISO-8601 i UTC (Z) om inget annat anges.

export type MatchOrigin = 'NEW_WEEKEND_SLOT' | 'OWN_TRAINING_SLOT'; // Spår 1 | Spår 2

export const GAME_FORMATS = ['3v3', '5v5', '7v7_SMALL', '7v7_LARGE', '9v9', '11v11'] as const;
export type GameFormat = (typeof GAME_FORMATS)[number];

export const TEAM_CATEGORIES = ['BOYS', 'GIRLS', 'MIXED'] as const;
export type TeamCategory = (typeof TEAM_CATEGORIES)[number];

// Gemensam sexgradig skala för matchnivå och lagets bedömda nivå.
export const LEVELS = ['EASY', 'EASY_PLUS', 'MEDIUM', 'MEDIUM_PLUS', 'HARD', 'HARD_PLUS'] as const;
export type Level = (typeof LEVELS)[number];

export const REFEREE_ARRANGEMENTS = ['HOME_ARRANGES', 'AWAY_BRINGS', 'SHARED_ON_SITE'] as const;
export type RefereeArrangement = (typeof REFEREE_ARRANGEMENTS)[number];

export const SURFACES = ['ARTIFICIAL_TURF', 'NATURAL_TURF'] as const;
export type Surface = (typeof SURFACES)[number];

export type UserRole = 'TEAM_LEADER' | 'OFFICE' | 'ADMIN'; // Gäst har inget konto

export type ApprovalStatus = 'NOT_REQUIRED' | 'PENDING' | 'APPROVED' | 'REJECTED';

export type MatchStatus =
  | 'RESERVATION_REQUESTED'
  | 'PUBLISHED'
  | 'MATCH_CONFIRMED'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'EXPIRED';

export type ReservationStatus =
  | 'REQUESTED'
  | 'RESERVED'
  | 'ACCEPTED'
  | 'COMPLETED'
  | 'REJECTED_BY_OFFICE'
  | 'REVOKED_BY_DEADLINE'
  | 'CANCELLED_BY_OFFICE'
  | 'WITHDRAWN_BY_HOME'
  | 'CLOSED_EXPIRED';

export type InquiryStatus = 'ACTIVE' | 'WITHDRAWN' | 'SELECTED' | 'REJECTED';

export type ReviewStatus = 'PENDING' | 'SUBMITTED' | 'EXPIRED' | 'PUBLISHED';

export type SpectatorsScore = 1 | 2 | 3 | 'NOT_APPLICABLE';

export interface User {
  id: string;
  role: UserRole;
  name: string;
  email: string;
  googleSubject?: string;
  createdAt: string;
}

export interface TeamProfile {
  assessedLevel?: Level;
  fairPlayAverage?: number;
  reviewCount: number;
  visible: boolean;
}

export interface Team {
  id: string;
  name: string;
  clubName: string;
  isHomeClub: boolean;
  birthYear: number;
  category: TeamCategory;
  profile: TeamProfile;
}

export interface TeamMembership {
  id: string;
  userId: string;
  teamId: string;
  approvalStatus: ApprovalStatus;
  decidedByUserId?: string;
  decidedAt?: string;
  createdAt: string;
}

export interface LeaderContact {
  userId: string;
  name: string;
  club: string;
  teamName: string;
  email: string;
  phone: string;
}

export interface Facility {
  id: string;
  name: string;
  address: string;
  active: boolean;
}

export interface Pitch {
  id: string;
  facilityId: string;
  name: string;
  surface: Surface;
  supportedFormats: GameFormat[];
  active: boolean;
}

export interface Venue {
  facilityId: string;
  pitchId: string;
  facilityName: string;
  facilityAddress: string;
  pitchName: string;
  surface: Surface;
  startTime: string;
  endTime: string;
}

export interface MatchEntity {
  id: string;
  origin: MatchOrigin;
  homeTeamId: string;
  homeContact: LeaderContact;
  awayTeamId?: string;
  selectedOpponent?: LeaderContact;
  gameFormat: GameFormat;
  birthYear: number;
  category: TeamCategory;
  openToAdjacentBirthYears: boolean;
  matchLevel: Level;
  durationMinutes: number;
  venue: Venue;
  referee: RefereeArrangement;
  kitColorHome: string;
  status: MatchStatus;
  reservationId?: string;
  inquiriesCount: number;
  isUrgent: boolean;
  completedConfirmedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface InquiryEntity {
  id: string;
  matchId: string;
  teamId: string;
  leaderUserId: string;
  contact: LeaderContact;
  status: InquiryStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ReservationOpponent {
  club: string;
  teamName: string;
  contactName: string;
  contactPhone: string;
}

export interface ReservationEntity {
  id: string;
  matchId: string;
  homeTeamId: string;
  requestedDate: string; // YYYY-MM-DD, lokalt datum, endast lördag/söndag
  timeWindow: string; // Lokal tid, t.ex. "10:00-13:00"
  gameFormat: GameFormat;
  birthYear: number;
  category: TeamCategory;
  allocatedPitch?: {
    facilityId: string;
    pitchId: string;
    facilityName: string;
    pitchName: string;
    startTime: string;
    endTime: string;
  };
  opponent?: ReservationOpponent;
  status: ReservationStatus;
  decisionReason?: string;
  deadlineAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface FairPlayReviewEntity {
  id: string;
  matchId: string;
  reviewingTeamId: string;
  reviewedTeamId: string;
  targetRole: 'HOME' | 'AWAY';
  playersScore?: 1 | 2 | 3;
  leadersScore?: 1 | 2 | 3;
  spectatorsScore?: SpectatorsScore;
  totalScore?: number;
  assessedLevel?: Level;
  status: ReviewStatus;
  deadlineAt: string;
  submittedAt?: string;
}

export interface AuditLogEntry {
  id: string;
  eventId: string;
  userId: string;
  entityType: string;
  entityId: string;
  transition: string;
  occurredAt: string;
}

export interface OutboxEvent<P = unknown> {
  eventId: string;
  eventType: string;
  matchId: string;
  sequence: number;
  payload: P;
  createdAt: string;
  processedAt?: string;
}
