import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export type Db = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('TEAM_LEADER','OFFICE','ADMIN')),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  google_subject TEXT UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  club_name TEXT NOT NULL,
  is_home_club INTEGER NOT NULL,
  birth_year INTEGER NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('BOYS','GIRLS','MIXED')),
  profile_assessed_level TEXT,
  profile_fair_play_average REAL,
  profile_review_count INTEGER NOT NULL DEFAULT 0,
  profile_visible INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS team_memberships (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  team_id TEXT NOT NULL REFERENCES teams(id),
  approval_status TEXT NOT NULL CHECK (approval_status IN ('NOT_REQUIRED','PENDING','APPROVED','REJECTED')),
  decided_by_user_id TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, team_id)
);

CREATE TABLE IF NOT EXISTS facilities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS pitches (
  id TEXT PRIMARY KEY,
  facility_id TEXT NOT NULL REFERENCES facilities(id),
  name TEXT NOT NULL,
  surface TEXT NOT NULL CHECK (surface IN ('ARTIFICIAL_TURF','NATURAL_TURF')),
  supported_formats TEXT NOT NULL, -- JSON-array av GameFormat
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY,
  origin TEXT NOT NULL CHECK (origin IN ('NEW_WEEKEND_SLOT','OWN_TRAINING_SLOT')),
  home_team_id TEXT NOT NULL REFERENCES teams(id),
  home_contact TEXT NOT NULL,          -- JSON LeaderContact
  away_team_id TEXT REFERENCES teams(id),
  selected_opponent TEXT,              -- JSON LeaderContact
  game_format TEXT NOT NULL,
  birth_year INTEGER NOT NULL,
  category TEXT NOT NULL,
  open_to_adjacent_birth_years INTEGER NOT NULL,
  match_level TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL,
  facility_id TEXT NOT NULL,
  pitch_id TEXT NOT NULL,
  facility_name TEXT NOT NULL,
  facility_address TEXT NOT NULL,
  pitch_name TEXT NOT NULL,
  surface TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  referee TEXT NOT NULL,
  kit_color_home TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('RESERVATION_REQUESTED','PUBLISHED','MATCH_CONFIRMED','COMPLETED','CANCELLED','EXPIRED')),
  reservation_id TEXT,
  inquiries_count INTEGER NOT NULL DEFAULT 0,
  is_urgent INTEGER NOT NULL DEFAULT 0,
  completed_confirmed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_matches_status_start ON matches(status, start_time);

CREATE TABLE IF NOT EXISTS inquiries (
  id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL REFERENCES matches(id),
  team_id TEXT NOT NULL REFERENCES teams(id),
  leader_user_id TEXT NOT NULL REFERENCES users(id),
  contact TEXT NOT NULL,               -- JSON LeaderContact
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','WITHDRAWN','SELECTED','REJECTED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inquiries_match ON inquiries(match_id, status);

-- Process B: planbokning för Spår 1 (ReservationEntity). En reservation per match.
CREATE TABLE IF NOT EXISTS reservations (
  id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL UNIQUE,       -- logisk koppling till Process A, ingen REFERENCES
  home_team_id TEXT NOT NULL REFERENCES teams(id),
  requested_date TEXT NOT NULL,        -- YYYY-MM-DD lokalt, lördag/söndag
  time_window TEXT NOT NULL,           -- lokal tid, t.ex. '10:00-13:00'
  game_format TEXT NOT NULL,
  birth_year INTEGER NOT NULL,
  category TEXT NOT NULL,
  facility_id TEXT REFERENCES facilities(id),
  pitch_id TEXT REFERENCES pitches(id),
  facility_name TEXT,
  pitch_name TEXT,
  start_time TEXT,
  end_time TEXT,
  opponent TEXT,                       -- JSON från senaste RESERVATION_ACCEPTED
  status TEXT NOT NULL CHECK (status IN ('REQUESTED','RESERVED','ACCEPTED','COMPLETED','REJECTED_BY_OFFICE',
    'REVOKED_BY_DEADLINE','CANCELLED_BY_OFFICE','WITHDRAWN_BY_HOME','CLOSED_EXPIRED')),
  decision_reason TEXT,
  deadline_at TEXT NOT NULL,           -- matchdatum minus 14 dagar kl 23:59:59 Europe/Stockholm, i UTC
  reserved_at TEXT,                    -- när planen tilldelades (AC-202.1)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reservations_status ON reservations(status, requested_date);

CREATE TABLE IF NOT EXISTS fair_play_reviews (
  id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL REFERENCES matches(id),
  reviewing_team_id TEXT NOT NULL REFERENCES teams(id),
  reviewed_team_id TEXT NOT NULL REFERENCES teams(id),
  target_role TEXT NOT NULL CHECK (target_role IN ('HOME','AWAY')),
  players_score INTEGER,
  leaders_score INTEGER,
  spectators_score TEXT,               -- '1'|'2'|'3'|'NOT_APPLICABLE'
  total_score REAL,
  assessed_level TEXT,
  status TEXT NOT NULL CHECK (status IN ('PENDING','SUBMITTED','EXPIRED','PUBLISHED')),
  deadline_at TEXT NOT NULL,
  submitted_at TEXT,
  published_at TEXT,
  UNIQUE (match_id, reviewing_team_id)
);

-- Intern outbox (avsnitt 4.0): skrivs i samma transaktion som tillståndsändringen.
CREATE TABLE IF NOT EXISTS outbox_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  match_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  processed_at TEXT,
  UNIQUE (match_id, sequence)
);

-- Idempotens: varje mottagare behandlar ett eventId högst en gång.
CREATE TABLE IF NOT EXISTS processed_events (
  consumer TEXT NOT NULL,
  event_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  PRIMARY KEY (consumer, event_id)
);

-- Append-only revisionslogg (NFR-05). Endast pseudonymt användar-ID.
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  transition TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

-- E-postkö (NFR-03). Köas transaktionellt, skickas av en bakgrundsprocess.
CREATE TABLE IF NOT EXISTS email_outbox (
  id TEXT PRIMARY KEY,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  urgent INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  sent_at TEXT
);

-- Skickade påminnelser, så att varje påminnelse skickas en gång.
CREATE TABLE IF NOT EXISTS reminders_sent (
  match_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  PRIMARY KEY (match_id, kind)
);
`;

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}

const depth = new WeakMap<Db, number>();

/**
 * Kör fn i en databastransaktion. Nästlade anrop deltar i den yttre transaktionen.
 * Ett kastat fel rullar tillbaka allt (BR-16).
 */
export function tx<T>(db: Db, fn: () => T): T {
  const current = depth.get(db) ?? 0;
  if (current > 0) {
    depth.set(db, current + 1);
    try {
      return fn();
    } finally {
      depth.set(db, current);
    }
  }
  db.exec('BEGIN IMMEDIATE');
  depth.set(db, 1);
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    depth.set(db, 0);
  }
}

export const newId = (prefix: string) => `${prefix}_${randomUUID()}`;

type Row = Record<string, unknown>;

export function one<T = Row>(db: Db, sql: string, ...params: SqlParam[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function all<T = Row>(db: Db, sql: string, ...params: SqlParam[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

/** Kör en sats och returnerar antal påverkade rader. */
export function run(db: Db, sql: string, ...params: SqlParam[]): number {
  return Number(db.prepare(sql).run(...params).changes);
}

export type SqlParam = string | number | null | bigint | Uint8Array;
