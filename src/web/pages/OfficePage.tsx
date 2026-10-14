import { useState } from 'react';
import type { Facility, GameFormat, Pitch, Surface, Team, TeamMembership } from '../../shared/types';
import { GAME_FORMATS, SURFACES } from '../../shared/types';
import type { ReservationView } from '../../server/modules/reservations';
import { approvalStatusLabel, gameFormatLabel, reservationStatusLabel, surfaceLabel } from '../../shared/labels';
import { formatDateTime, formatSlot } from '../../shared/time';
import { api, ApiError } from '../api';
import { useAction, useApi } from '../hooks';
import { RequireUser } from '../components/RequireUser';
import { ErrorBox, Field, Loading, ageLabel, endTimeLabel, teamLabel } from '../components/ui';

type MembershipRow = TeamMembership & { team: Team; user: { id: string; name: string; email: string } };
type FacilityWithPitches = Facility & { pitches: Pitch[] };

export function OfficePage() {
  return (
    <RequireUser role="OFFICE">
      <h1>Kansli</h1>
      <Reservations />
      <Approvals />
      <Masterdata />
    </RequireUser>
  );
}

// ---------- Process B: helgtider (FR-B-201–206) ----------

interface ReservationLists {
  queue: ReservationView[];
  active: ReservationView[];
  closed: ReservationView[];
}

/** T.ex. "lör 7 nov." för ett lokalt datum (YYYY-MM-DD). */
const dateLabel = (date: string) =>
  new Intl.DateTimeFormat('sv-SE', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));

const requestLabel = (r: ReservationView) =>
  `${r.homeTeam.clubName} ${r.homeTeam.name} · ${gameFormatLabel[r.gameFormat]} · ${ageLabel(r)}`;

/** Frågar efter en obligatorisk orsak (högst 200 tecken, 4.3 och 4.7). */
function askReason(question: string): string | undefined {
  const reason = window.prompt(`${question}\nOrsaken visas för de berörda lagen (högst 200 tecken).`)?.trim();
  return reason ? reason.slice(0, 200) : undefined;
}

function Reservations() {
  const { data, reload } = useApi<ReservationLists>('/office/reservations');
  const { data: facilities } = useApi<FacilityWithPitches[]>('/facilities');
  const action = useAction();
  if (!data || !facilities) return <Loading />;

  const act = async (fn: () => Promise<unknown>) => {
    const ok = await action.run(fn);
    await reload();
    return ok;
  };
  const cancel = (r: ReservationView) => {
    const reason = askReason(`Ställ in bokningen för ${r.homeTeam.clubName} ${r.homeTeam.name} ${dateLabel(r.requestedDate)}?`);
    if (reason) void act(() => api.post(`/office/reservations/${r.id}/cancel`, { reason }));
  };

  return (
    <>
      <section className="card">
        <h2>Förfrågningar om helgtider ({data.queue.length})</h2>
        <ErrorBox message={action.error} />
        {data.queue.length === 0 && <p className="muted">Inga förfrågningar att hantera.</p>}
        <ul className="plain">
          {data.queue.map((r) => (
            <li key={r.id} className="sub">
              <QueueItem r={r} facilities={facilities} act={act} busy={action.busy} />
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>Tilldelade helgtider ({data.active.length})</h2>
        {data.active.length === 0 && <p className="muted">Inga aktiva bokningar.</p>}
        <ul className="plain">
          {data.active.map((r) => (
            <li key={r.id} className="inquiry">
              <div>
                <strong>{formatSlot(r.allocatedPitch!.startTime, r.allocatedPitch!.endTime)}</strong> · {r.allocatedPitch!.facilityName}, {r.allocatedPitch!.pitchName}
                <div>{requestLabel(r)}</div>
                <div className="small">
                  {reservationStatusLabel[r.status]}
                  {r.status === 'ACCEPTED' && r.opponent && <> mot {r.opponent.club} {r.opponent.teamName}</>}
                  {r.status === 'RESERVED' && <span className="muted"> · motståndare senast {formatDateTime(r.deadlineAt)}</span>}
                </div>
              </div>
              <button className="button small danger secondary" disabled={action.busy} onClick={() => cancel(r)}>Ställ in</button>
            </li>
          ))}
        </ul>
        {data.closed.length > 0 && (
          <details>
            <summary>Avslutade ({data.closed.length})</summary>
            <ul className="plain">
              {data.closed.map((r) => (
                <li key={r.id} className="row small">
                  <span>{dateLabel(r.requestedDate)} · {requestLabel(r)}{r.decisionReason && <span className="muted"> · {r.decisionReason}</span>}</span>
                  <span>{reservationStatusLabel[r.status]}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>
    </>
  );
}

/** AC-201.2: tilldela en plan som stödjer spelformen, eller avslå med orsak (AC-204.1). */
function QueueItem({ r, facilities, act, busy }: {
  r: ReservationView;
  facilities: FacilityWithPitches[];
  act: (fn: () => Promise<unknown>) => Promise<unknown>;
  busy: boolean;
}) {
  // Förifyllt med den önskade tiden: starttid och längd.
  const [wishStart, wishEnd] = r.timeWindow.split('-');
  const wishMinutes = (Number(wishEnd.slice(0, 2)) * 60 + Number(wishEnd.slice(3))) - (Number(wishStart.slice(0, 2)) * 60 + Number(wishStart.slice(3)));
  const [form, setForm] = useState({ pitchId: '', startTime: wishStart, durationMinutes: wishMinutes });
  const options = facilities.flatMap((f) =>
    f.pitches.filter((p) => p.supportedFormats.includes(r.gameFormat)).map((p) => ({ id: p.id, label: `${f.name}, ${p.name} (${surfaceLabel[p.surface].toLowerCase()})` })),
  );

  const allocate = async (overrideOverlap = false): Promise<unknown> => {
    try {
      return await api.post(`/office/reservations/${r.id}/allocate`, { ...form, overrideOverlap });
    } catch (e) {
      // Överlapp är en varning som kansliet kan åsidosätta.
      if (e instanceof ApiError && e.code === 'OVERLAP' && window.confirm(`${e.message}.\n\nTilldela ändå?`)) return allocate(true);
      throw e;
    }
  };
  const reject = () => {
    const reason = askReason(`Avslå förfrågan från ${r.homeTeam.clubName} ${r.homeTeam.name} ${dateLabel(r.requestedDate)}?`);
    if (reason) void act(() => api.post(`/office/reservations/${r.id}/reject`, { reason }));
  };

  return (
    <form className="form" onSubmit={(e) => { e.preventDefault(); void act(() => allocate()); }}>
      <div>
        <strong>{dateLabel(r.requestedDate)} kl {r.timeWindow.replace('-', '–')}</strong>
        <div>{requestLabel(r)}</div>
        <div className="muted small">Inkom {formatDateTime(r.createdAt)} · motståndare ska vara vald senast {formatDateTime(r.deadlineAt)}</div>
      </div>
      <Field label="Plan" hint={options.length === 0 ? `Ingen aktiv plan stödjer ${gameFormatLabel[r.gameFormat].toLowerCase()}.` : undefined}>
        <select required value={form.pitchId} onChange={(e) => setForm({ ...form, pitchId: e.target.value })}>
          <option value="">Välj plan</option>
          {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
      </Field>
      <div className="two">
        <Field label="Starttid">
          <input type="time" step={300} required value={form.startTime} onChange={(e) => setForm({ ...form, startTime: e.target.value })} />
        </Field>
        <Field label="Längd (min)" hint={`Slutar ${endTimeLabel(form.startTime, form.durationMinutes)}`}>
          <input type="number" min={10} max={180} step={5} required value={form.durationMinutes} onChange={(e) => setForm({ ...form, durationMinutes: Number(e.target.value) })} />
        </Field>
      </div>
      <div className="actions">
        <button className="button small" disabled={busy}>Tilldela plan</button>
        <button type="button" className="button small secondary" disabled={busy} onClick={reject}>Avslå</button>
      </div>
    </form>
  );
}

// ---------- Ledarkopplingar och masterdata ----------

/** FR-U-003: godkänn eller avslå IFK Lidingö-kopplingar. */
function Approvals() {
  const { data, reload } = useApi<{ pending: MembershipRow[]; all: MembershipRow[] }>('/office/memberships');
  const action = useAction();
  const decide = async (id: string, approve: boolean) => {
    await action.run(() => api.post(`/office/memberships/${id}/decision`, { approve }));
    await reload();
  };
  if (!data) return <Loading />;
  const decided = data.all.filter((m) => m.approvalStatus !== 'PENDING');
  return (
    <section className="card">
      <h2>Ledarkopplingar att godkänna ({data.pending.length})</h2>
      <ErrorBox message={action.error} />
      {data.pending.length === 0 && <p className="muted">Inga väntande kopplingar.</p>}
      <ul className="plain">
        {data.pending.map((m) => (
          <li key={m.id} className="inquiry">
            <div>
              <strong>{m.user.name}</strong> <span className="muted small">{m.user.email}</span>
              <div>{teamLabel(m.team)} ({ageLabel(m.team)})</div>
              <div className="muted small">Ansökt {formatDateTime(m.createdAt)}</div>
            </div>
            <div className="actions">
              <button className="button small" disabled={action.busy} onClick={() => void decide(m.id, true)}>Godkänn</button>
              <button className="button small secondary" disabled={action.busy} onClick={() => void decide(m.id, false)}>Avslå</button>
            </div>
          </li>
        ))}
      </ul>
      {decided.length > 0 && (
        <details>
          <summary>Beslutade kopplingar ({decided.length})</summary>
          <ul className="plain">
            {decided.map((m) => (
              <li key={m.id} className="row small">
                <span>{m.user.name} – {teamLabel(m.team)}</span>
                <span>{approvalStatusLabel[m.approvalStatus]}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

/** FR-B-207: masterdata för anläggningar och planer. */
function Masterdata() {
  const { data, reload } = useApi<FacilityWithPitches[]>('/office/facilities');
  const action = useAction();
  const [newFacility, setNewFacility] = useState({ name: '', address: '' });
  if (!data) return <Loading />;
  const save = async (fn: () => Promise<unknown>) => {
    const ok = await action.run(fn);
    await reload();
    return ok;
  };
  return (
    <section className="card">
      <h2>Anläggningar och planer</h2>
      <ErrorBox message={action.error} />
      {data.map((f) => (
        <FacilityEditor key={f.id} facility={f} save={save} />
      ))}
      <form
        className="form sub"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await save(() => api.post('/office/facilities', newFacility))) setNewFacility({ name: '', address: '' });
        }}
      >
        <h3>Ny anläggning</h3>
        <Field label="Namn"><input required value={newFacility.name} onChange={(e) => setNewFacility({ ...newFacility, name: e.target.value })} /></Field>
        <Field label="Adress"><input required value={newFacility.address} onChange={(e) => setNewFacility({ ...newFacility, address: e.target.value })} /></Field>
        <button className="button secondary" disabled={action.busy}>Lägg till anläggning</button>
      </form>
    </section>
  );
}

function FacilityEditor({ facility, save }: { facility: FacilityWithPitches; save: (fn: () => Promise<unknown>) => Promise<unknown> }) {
  const [adding, setAdding] = useState(false);
  return (
    <div className={`sub${facility.active ? '' : ' inactive'}`}>
      <div className="row">
        <span>
          <strong>{facility.name}</strong> <span className="muted small">{facility.address}</span>
        </span>
        <button
          className="link-button small"
          onClick={() => void save(() => api.put(`/office/facilities/${facility.id}`, { name: facility.name, address: facility.address, active: !facility.active }))}
        >
          {facility.active ? 'Inaktivera' : 'Aktivera'}
        </button>
      </div>
      <ul className="plain">
        {facility.pitches.map((p) => (
          <li key={p.id} className={`row small${p.active ? '' : ' inactive'}`}>
            <span>
              {p.name} · {surfaceLabel[p.surface]} · {p.supportedFormats.map((g) => gameFormatLabel[g]).join(', ')}
            </span>
            <button className="link-button small" onClick={() => void save(() => api.put(`/office/pitches/${p.id}`, { ...p, active: !p.active }))}>
              {p.active ? 'Inaktivera' : 'Aktivera'}
            </button>
          </li>
        ))}
      </ul>
      {adding ? (
        <PitchForm
          onCancel={() => setAdding(false)}
          onSave={async (pitch) => {
            if (await save(() => api.post('/office/pitches', { ...pitch, facilityId: facility.id }))) setAdding(false);
          }}
        />
      ) : (
        <button className="link-button small" onClick={() => setAdding(true)}>+ Lägg till plan</button>
      )}
    </div>
  );
}

function PitchForm({ onSave, onCancel }: { onSave: (p: { name: string; surface: Surface; supportedFormats: GameFormat[] }) => void; onCancel: () => void }) {
  const [p, setP] = useState({ name: '', surface: 'ARTIFICIAL_TURF' as Surface, supportedFormats: [] as GameFormat[] });
  return (
    <form className="form" onSubmit={(e) => { e.preventDefault(); onSave(p); }}>
      <Field label="Plannamn"><input required value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} /></Field>
      <Field label="Underlag">
        <select value={p.surface} onChange={(e) => setP({ ...p, surface: e.target.value as Surface })}>
          {SURFACES.map((s) => <option key={s} value={s}>{surfaceLabel[s]}</option>)}
        </select>
      </Field>
      <fieldset>
        <legend>Spelformer</legend>
        <div className="checks">
          {GAME_FORMATS.map((g) => (
            <label key={g} className="check">
              <input
                type="checkbox"
                checked={p.supportedFormats.includes(g)}
                onChange={(e) => setP({ ...p, supportedFormats: e.target.checked ? [...p.supportedFormats, g] : p.supportedFormats.filter((x) => x !== g) })}
              />
              {gameFormatLabel[g]}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="actions">
        <button className="button small">Spara plan</button>
        <button type="button" className="button small secondary" onClick={onCancel}>Avbryt</button>
      </div>
    </form>
  );
}
