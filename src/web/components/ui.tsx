import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { MatchStatus, Team } from '../../shared/types';
import type { MatchCard as MatchCardData } from '../../server/modules/matches';
import { categoryPrefix, gameFormatLabel, levelLabel, matchStatusLabel, surfaceLabel } from '../../shared/labels';
import { formatSlot } from '../../shared/time';

export function ErrorBox({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <div className="alert alert-error" role="alert">
      {message}
    </div>
  );
}

export function Info({ children }: { children: ReactNode }) {
  return <div className="alert alert-info">{children}</div>;
}

export function StatusBadge({ status, urgent }: { status: MatchStatus; urgent?: boolean }) {
  return (
    <span className="badges">
      {urgent && status === 'PUBLISHED' && <span className="badge badge-urgent">Brådskande</span>}
      <span className={`badge badge-${status.toLowerCase()}`}>{matchStatusLabel[status]}</span>
    </span>
  );
}

export const teamLabel = (t: Pick<Team, 'clubName' | 'name'>) => `${t.clubName} ${t.name}`;
export const ageLabel = (m: { category: Team['category']; birthYear: number }) => `${categoryPrefix[m.category]}${m.birthYear}`;

/** Lagprofilens aggregat. Visas bara när minst 3 recensioner finns (AC-303.2). */
export function TeamProfileLine({ team }: { team: Team }) {
  if (!team.profile.visible) return <span className="muted">Ingen lagprofil än</span>;
  return (
    <span className="profile">
      Bedömd nivå <strong>{levelLabel[team.profile.assessedLevel!]}</strong> · Fair Play{' '}
      <strong>{team.profile.fairPlayAverage!.toFixed(1).replace('.', ',')}</strong>/3
      <span className="muted"> ({team.profile.reviewCount} rec.)</span>
    </span>
  );
}

export function MatchCard({ match }: { match: MatchCardData }) {
  return (
    <Link to={`/matcher/${match.id}`} className={`card match-card${match.isUrgent && match.status === 'PUBLISHED' ? ' urgent' : ''}`}>
      <div className="match-card-head">
        <span className="match-when">{formatSlot(match.venue.startTime, match.venue.endTime)}</span>
        <StatusBadge status={match.status} urgent={match.isUrgent} />
      </div>
      <div className="match-title">
        {teamLabel(match.homeTeam)}
        {match.awayTeam && <> – {teamLabel(match.awayTeam)}</>}
      </div>
      <div className="chips">
        <span className="chip">{ageLabel(match)}{match.openToAdjacentBirthYears && ' ±1'}</span>
        <span className="chip">{gameFormatLabel[match.gameFormat]}</span>
        <span className="chip">Nivå: {levelLabel[match.matchLevel]}</span>
      </div>
      <div className="muted small">
        {match.venue.facilityName}, {match.venue.pitchName} ({surfaceLabel[match.venue.surface].toLowerCase()}) · {match.venue.facilityAddress}
      </div>
      {match.status === 'PUBLISHED' && match.inquiriesCount > 0 && (
        <div className="small">{match.inquiriesCount} {match.inquiriesCount > 1 ? 'intresseanmälningar' : 'intresseanmälan'}</div>
      )}
    </Link>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Loading() {
  return <p className="muted">Laddar…</p>;
}
