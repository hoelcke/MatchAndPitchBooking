import type {
  ApprovalStatus,
  GameFormat,
  InquiryStatus,
  Level,
  MatchStatus,
  RefereeArrangement,
  ReservationStatus,
  ReviewStatus,
  Surface,
  TeamCategory,
} from './types.js';

export const gameFormatLabel: Record<GameFormat, string> = {
  '3v3': '3 mot 3',
  '5v5': '5 mot 5',
  '7v7_SMALL': '7 mot 7 (liten)',
  '7v7_LARGE': '7 mot 7 (stor)',
  '9v9': '9 mot 9',
  '11v11': '11 mot 11',
};

export const categoryLabel: Record<TeamCategory, string> = {
  BOYS: 'Pojkar',
  GIRLS: 'Flickor',
  MIXED: 'Mixat',
};

export const categoryPrefix: Record<TeamCategory, string> = { BOYS: 'P', GIRLS: 'F', MIXED: 'M' };

export const levelLabel: Record<Level, string> = {
  EASY: 'Lätt',
  EASY_PLUS: 'Lätt plus',
  MEDIUM: 'Medel',
  MEDIUM_PLUS: 'Medel plus',
  HARD: 'Svår',
  HARD_PLUS: 'Svår plus',
};

export const refereeLabel: Record<RefereeArrangement, string> = {
  HOME_ARRANGES: 'Hemmalaget ordnar domare',
  AWAY_BRINGS: 'Bortalaget tar med domare',
  SHARED_ON_SITE: 'Delas på plats',
};

export const surfaceLabel: Record<Surface, string> = {
  ARTIFICIAL_TURF: 'Konstgräs',
  NATURAL_TURF: 'Naturgräs',
};

export const matchStatusLabel: Record<MatchStatus, string> = {
  RESERVATION_REQUESTED: 'Plan begärd',
  PUBLISHED: 'Söker motståndare',
  MATCH_CONFIRMED: 'Motståndare klar',
  COMPLETED: 'Genomförd',
  CANCELLED: 'Avbokad',
  EXPIRED: 'Utgången',
};

export const inquiryStatusLabel: Record<InquiryStatus, string> = {
  ACTIVE: 'Aktiv',
  WITHDRAWN: 'Tillbakadragen',
  SELECTED: 'Vald',
  REJECTED: 'Ej vald',
};

export const approvalStatusLabel: Record<ApprovalStatus, string> = {
  NOT_REQUIRED: 'Aktiv',
  PENDING: 'Väntar på kansliet',
  APPROVED: 'Godkänd',
  REJECTED: 'Avslagen',
};

export const reviewStatusLabel: Record<ReviewStatus, string> = {
  PENDING: 'Att fylla i',
  SUBMITTED: 'Inskickad',
  EXPIRED: 'Utgången',
  PUBLISHED: 'Inräknad',
};

export const reservationStatusLabel: Record<ReservationStatus, string> = {
  REQUESTED: 'Väntar på kansliet',
  RESERVED: 'Plan tilldelad',
  ACCEPTED: 'Motståndare vald',
  COMPLETED: 'Genomförd',
  REJECTED_BY_OFFICE: 'Avslagen av kansliet',
  REVOKED_BY_DEADLINE: 'Återkallad (14-dagarsregeln)',
  CANCELLED_BY_OFFICE: 'Inställd av kansliet',
  WITHDRAWN_BY_HOME: 'Avbokad av hemmalaget',
  CLOSED_EXPIRED: 'Utgången',
};
