import { useEffect, useState, type ReactNode } from 'react';
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

/** Spår 1 före tilldelning: matchen har bara en önskad tid och ingen plan (A1). */
export const hasPitch = (m: Pick<MatchCardData, 'venue'>) => !!m.venue.pitchId;

export function slotLabel(m: Pick<MatchCardData, 'venue'>) {
  const slot = formatSlot(m.venue.startTime, m.venue.endTime);
  return hasPitch(m) ? slot : `Önskat: ${slot}`;
}

export function VenueLine({ match }: { match: Pick<MatchCardData, 'venue' | 'status'> }) {
  const v = match.venue;
  if (!hasPitch(match)) return <>{match.status === 'RESERVATION_REQUESTED' ? 'Plan tilldelas av kansliet' : 'Ingen plan tilldelades'}</>;
  return (
    <>
      {v.facilityName}, {v.pitchName} ({surfaceLabel[v.surface].toLowerCase()}) · {v.facilityAddress}
    </>
  );
}

export function MatchCard({ match }: { match: MatchCardData }) {
  return (
    <Link to={`/matcher/${match.id}`} className={`card match-card${match.isUrgent && match.status === 'PUBLISHED' ? ' urgent' : ''}`}>
      <div className="match-card-head">
        <span className="match-when">{slotLabel(match)}</span>
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
      <div className="muted small"><VenueLine match={match} /></div>
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

const HOURS = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'));
const MINUTES = Array.from({ length: 12 }, (_, i) => String(i * 5).padStart(2, '0'));

/**
 * Tid i 24-timmarsformat (HH:mm). Webbläsarens <input type="time"> följer operativsystemets
 * språkinställning och kan visa AM/PM, därför två listor för timme och minut (5-minutersteg).
 */
export function TimeInput({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const [h = '00', m = '00'] = value.split(':');
  const minutes = MINUTES.includes(m) ? MINUTES : [...MINUTES, m].sort();
  return (
    <span className="time-input">
      <select aria-label={`${label}, timme`} value={h} onChange={(e) => onChange(`${e.target.value}:${m}`)}>
        {HOURS.map((x) => <option key={x} value={x}>{x}</option>)}
      </select>
      <span aria-hidden>:</span>
      <select aria-label={`${label}, minut`} value={m} onChange={(e) => onChange(`${h}:${e.target.value}`)}>
        {minutes.map((x) => <option key={x} value={x}>{x}</option>)}
      </select>
    </span>
  );
}

/** Sluttid (HH:mm) för en starttid plus längd i minuter. */
export function endTimeLabel(start: string, minutes: number): string {
  const [h, m] = start.split(':').map(Number);
  const total = h * 60 + m + (Number.isFinite(minutes) ? minutes : 0);
  return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
const pad2 = (n: number) => String(n).padStart(2, '0');
const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();
const weekdayFormatter = new Intl.DateTimeFormat('sv-SE', { weekday: 'long', timeZone: 'UTC' });

/**
 * Datum (YYYY-MM-DD) med listor för dag, månad och år i svensk ordning. Webbläsarens
 * <input type="date"> följer operativsystemets språkinställning och kan visa MM/DD/YYYY.
 * Värdet är tomt tills dag, månad och år är valda.
 */
export function DateInput({ value, onChange, label, firstYear, years = 2, required }: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  /** Första året i listan. Standard: innevarande år. */
  firstYear?: number;
  years?: number;
  required?: boolean;
}) {
  const parse = (v: string) => {
    const [y = '', m = '', d = ''] = v ? v.split('-') : [];
    return { y, m, d };
  };
  const [parts, setParts] = useState(() => parse(value));
  // Följ värdet utifrån, t.ex. när ett filter nollställs.
  useEffect(() => {
    if (value || (parts.y && parts.m && parts.d)) setParts(parse(value));
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  const update = (next: { y: string; m: string; d: string }) => {
    if (next.y && next.m && next.d) {
      const max = daysInMonth(Number(next.y), Number(next.m));
      if (Number(next.d) > max) next = { ...next, d: pad2(max) };
    }
    setParts(next);
    onChange(next.y && next.m && next.d ? `${next.y}-${next.m}-${next.d}` : '');
  };

  const start = firstYear ?? new Date().getFullYear();
  const yearList = Array.from({ length: years }, (_, i) => String(start + i));
  if (parts.y && !yearList.includes(parts.y)) yearList.unshift(parts.y);
  const dayCount = parts.y && parts.m ? daysInMonth(Number(parts.y), Number(parts.m)) : 31;
  const weekday = parts.y && parts.m && parts.d ? weekdayFormatter.format(new Date(`${parts.y}-${parts.m}-${parts.d}T00:00:00Z`)) : '';

  return (
    <span className="date-input">
      <select aria-label={`${label}, dag`} required={required} value={parts.d} onChange={(e) => update({ ...parts, d: e.target.value })}>
        <option value="">Dag</option>
        {Array.from({ length: dayCount }, (_, i) => pad2(i + 1)).map((x) => <option key={x} value={x}>{Number(x)}</option>)}
      </select>
      <select aria-label={`${label}, månad`} required={required} value={parts.m} onChange={(e) => update({ ...parts, m: e.target.value })}>
        <option value="">Månad</option>
        {MONTHS.map((name, i) => <option key={name} value={pad2(i + 1)}>{name}</option>)}
      </select>
      <select aria-label={`${label}, år`} required={required} value={parts.y} onChange={(e) => update({ ...parts, y: e.target.value })}>
        <option value="">År</option>
        {yearList.map((x) => <option key={x} value={x}>{x}</option>)}
      </select>
      {weekday && <span className="muted small">{weekday}</span>}
    </span>
  );
}
