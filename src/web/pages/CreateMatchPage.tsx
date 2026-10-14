import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { Facility, GameFormat, MatchEntity, Pitch } from '../../shared/types';
import { GAME_FORMATS, LEVELS, REFEREE_ARRANGEMENTS, TEAM_CATEGORIES } from '../../shared/types';
import { categoryLabel, gameFormatLabel, levelLabel, refereeLabel, surfaceLabel } from '../../shared/labels';
import { addDaysToDate, daysBetweenDates, isWeekendDate, utcToLocal } from '../../shared/time';
import { api } from '../api';
import { useAction, useApi } from '../hooks';
import { useSession } from '../session';
import { RequireUser } from '../components/RequireUser';
import { ErrorBox, Field, Info, endTimeLabel, teamLabel } from '../components/ui';

type FacilityWithPitches = Facility & { pitches: Pitch[] };

export function CreateMatchPage() {
  return (
    <RequireUser role="TEAM_LEADER">
      <CreateMatchForm />
    </RequireUser>
  );
}

/** T.ex. "lördag 7 november 2026". */
const formatDateLong = (date: string) =>
  new Intl.DateTimeFormat('sv-SE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${date}T00:00:00Z`),
  );

/** BR-06: minsta ledtid för Spår 1. Servern kontrollerar samma regel. */
const MIN_LEAD_DAYS = 21;

type Track = 'OWN_TRAINING_SLOT' | 'NEW_WEEKEND_SLOT';

/** FR-A-101: Matchinitiering och vägval mellan Spår 1 och Spår 2. */
function CreateMatchForm() {
  const { homeTeams, memberships, config } = useSession();
  const [track, setTrack] = useState<Track>('OWN_TRAINING_SLOT');
  const navigate = useNavigate();
  const { data: facilities } = useApi<FacilityWithPitches[]>('/facilities');
  const action = useAction();
  const [f, setF] = useState({
    homeTeamId: homeTeams[0]?.id ?? '',
    phone: '',
    facilityId: '',
    pitchId: '',
    date: '',
    startTime: '17:30', // Spår 2
    weekendStartTime: '10:00', // Spår 1, önskad starttid
    gameFormat: '7v7_LARGE' as GameFormat,
    birthYear: homeTeams[0]?.birthYear ?? new Date().getFullYear() - 10,
    category: homeTeams[0]?.category ?? 'BOYS',
    openToAdjacentBirthYears: false,
    matchLevel: 'MEDIUM',
    durationMinutes: 60, // Matchens längd. Sluttid = starttid + längd.
    referee: 'HOME_ARRANGES',
    kitColorHome: '',
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((prev) => ({ ...prev, [k]: v }));

  // Förifyll ålder och kategori från valt lag.
  useEffect(() => {
    const t = homeTeams.find((x) => x.id === f.homeTeamId);
    if (t) setF((prev) => ({ ...prev, birthYear: t.birthYear, category: t.category }));
  }, [f.homeTeamId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (homeTeams.length === 0) {
    const pending = memberships.some((m) => m.team.isHomeClub && m.approvalStatus === 'PENDING');
    return (
      <div className="card">
        <h1>Skapa match</h1>
        {pending ? (
          <Info>Din koppling till ett IFK Lidingö-lag väntar på kansliets godkännande. Du kan skapa matcher när den är godkänd.</Info>
        ) : (
          <p>Endast godkända ledare för IFK Lidingö-lag kan skapa matcher. <Link to="/lag">Koppla dig till ett lag</Link>.</p>
        )}
      </div>
    );
  }

  const weekend = track === 'NEW_WEEKEND_SLOT';
  const facility = facilities?.find((x) => x.id === f.facilityId);
  const pitch = facility?.pitches.find((p) => p.id === f.pitchId);
  const formatWarning = pitch && !pitch.supportedFormats.includes(f.gameFormat);

  // Spår 1: samma regler som servern (AC-101.2, AC-101.4), för direkt återkoppling.
  const today = utcToLocal(config?.now ?? new Date().toISOString()).date;
  let earliest = addDaysToDate(today, MIN_LEAD_DAYS);
  while (!isWeekendDate(earliest)) earliest = addDaysToDate(earliest, 1);
  const dateProblem =
    weekend && f.date
      ? !isWeekendDate(f.date)
        ? 'Träningsmatchtider tilldelas endast under helger'
        : daysBetweenDates(today, f.date) < MIN_LEAD_DAYS
          ? 'Helgtider måste begäras minst 21 dagar i förväg. Använd en egen träningstid (Spår 2) för tidigare matcher.'
          : undefined
      : undefined;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const { facilityId: _f, pitchId, startTime, weekendStartTime, ...common } = f;
    const body = weekend ? { ...common, startTime: weekendStartTime } : { ...common, pitchId, startTime };
    const created = await action.run(() => api.post<MatchEntity>('/matches', { origin: track, ...body }));
    if (created) navigate(`/matcher/${created.id}`);
  };

  const startKey = weekend ? 'weekendStartTime' : 'startTime';
  const timeFields = (
    <div className="two">
      <Field label={weekend ? 'Önskad starttid' : 'Starttid'}>
        <input type="time" step={300} required value={f[startKey]} onChange={(e) => set(startKey, e.target.value)} />
      </Field>
      <Field label="Längd (min)" hint={`Slutar ${endTimeLabel(f[startKey], f.durationMinutes)}`}>
        <input type="number" min={10} max={180} step={5} required value={f.durationMinutes} onChange={(e) => set('durationMinutes', Number(e.target.value))} />
      </Field>
    </div>
  );

  return (
    <>
      <h1>Skapa match</h1>
      <div className="track-choice" role="group" aria-label="Välj spår">
        <button type="button" className={`track${weekend ? '' : ' selected'}`} aria-pressed={!weekend} onClick={() => setTrack('OWN_TRAINING_SLOT')}>
          <strong>Spår 2 · Egen träningstid</strong>
          <span className="small">Ni har redan en plantid. Matchen publiceras direkt på börsen – kansliet behöver inte tillfrågas.</span>
        </button>
        <button type="button" className={`track${weekend ? ' selected' : ''}`} aria-pressed={weekend} onClick={() => setTrack('NEW_WEEKEND_SLOT')}>
          <strong>Spår 1 · Ny helgtid via kansliet</strong>
          <span className="small">Kansliet tilldelar en plan en lördag eller söndag. Begär minst 21 dagar i förväg.</span>
        </button>
      </div>

      <form className="form card" onSubmit={submit}>
        <ErrorBox message={action.error} />
        {homeTeams.length > 1 ? (
          <Field label="Hemmalag">
            <select value={f.homeTeamId} onChange={(e) => set('homeTeamId', e.target.value)}>
              {homeTeams.map((t) => <option key={t.id} value={t.id}>{teamLabel(t)}</option>)}
            </select>
          </Field>
        ) : (
          <p>Hemmalag: <strong>{teamLabel(homeTeams[0])}</strong></p>
        )}

        {weekend ? (
          <fieldset>
            <legend>Önskad helgtid</legend>
            <Field label="Datum (lördag eller söndag)" hint={dateProblem ?? `Tidigast ${formatDateLong(earliest)}.`}>
              <input type="date" required min={earliest} value={f.date} onChange={(e) => set('date', e.target.value)} aria-invalid={!!dateProblem} />
            </Field>
            {timeFields}
            <p className="muted small">Kansliet väljer plan och bekräftar tiden. Matchen publiceras på börsen när planen är tilldelad.</p>
          </fieldset>
        ) : (
          <fieldset>
            <legend>Plats och tid</legend>
            <Field label="Anläggning">
              <select required value={f.facilityId} onChange={(e) => setF({ ...f, facilityId: e.target.value, pitchId: '' })}>
                <option value="">Välj anläggning</option>
                {facilities?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
            </Field>
            <Field label="Plan" hint={formatWarning ? `Planen är inte registrerad för ${gameFormatLabel[f.gameFormat].toLowerCase()} – kontrollera att ni får plats.` : undefined}>
              <select required value={f.pitchId} onChange={(e) => set('pitchId', e.target.value)} disabled={!facility}>
                <option value="">Välj plan</option>
                {facility?.pitches.map((p) => (
                  <option key={p.id} value={p.id}>{p.name} ({surfaceLabel[p.surface].toLowerCase()})</option>
                ))}
              </select>
            </Field>
            <Field label="Datum">
              <input type="date" required value={f.date} onChange={(e) => set('date', e.target.value)} />
            </Field>
            {timeFields}
          </fieldset>
        )}

        <fieldset>
          <legend>Matchen</legend>
          <Field label="Spelform">
            <select value={f.gameFormat} onChange={(e) => set('gameFormat', e.target.value as GameFormat)}>
              {GAME_FORMATS.map((g) => <option key={g} value={g}>{gameFormatLabel[g]}</option>)}
            </select>
          </Field>
          <div className="two">
            <Field label="Födelseår">
              <input type="number" required value={f.birthYear} onChange={(e) => set('birthYear', Number(e.target.value))} />
            </Field>
            <Field label="Kategori">
              <select value={f.category} onChange={(e) => set('category', e.target.value as typeof f.category)}>
                {TEAM_CATEGORIES.map((c) => <option key={c} value={c}>{categoryLabel[c]}</option>)}
              </select>
            </Field>
          </div>
          <label className="check">
            <input type="checkbox" checked={f.openToAdjacentBirthYears} onChange={(e) => set('openToAdjacentBirthYears', e.target.checked)} />
            Öppen för lag ett år yngre eller äldre
          </label>
          <Field label="Matchnivå (önskat motstånd)">
            <select value={f.matchLevel} onChange={(e) => set('matchLevel', e.target.value)}>
              {LEVELS.map((l) => <option key={l} value={l}>{levelLabel[l]}</option>)}
            </select>
          </Field>
          <Field label="Domare">
            <select value={f.referee} onChange={(e) => set('referee', e.target.value)}>
              {REFEREE_ARRANGEMENTS.map((r) => <option key={r} value={r}>{refereeLabel[r]}</option>)}
            </select>
          </Field>
          <Field label="Hemmalagets matchställ">
            <input required value={f.kitColorHome} onChange={(e) => set('kitColorHome', e.target.value)} placeholder="T.ex. blå tröja, vita byxor" />
          </Field>
        </fieldset>

        <Field label="Ditt telefonnummer" hint="Visas för motståndaren när ni valt varandra.">
          <input type="tel" required autoComplete="tel" value={f.phone} onChange={(e) => set('phone', e.target.value)} placeholder="+46 70 123 45 67" />
        </Field>

        {weekend && (
          <p className="muted small">
            Motståndare måste vara vald senast 14 dagar före matchdagen. Annars återkallas plantiden automatiskt.
          </p>
        )}
        <p className="muted small">När matchen är publicerad kan den inte ändras. Vid ändringar avbokar du och skapar en ny match.</p>
        <button className="button" disabled={action.busy || !!dateProblem}>
          {weekend ? 'Skicka förfrågan till kansliet' : 'Publicera på börsen'}
        </button>
      </form>
    </>
  );
}
