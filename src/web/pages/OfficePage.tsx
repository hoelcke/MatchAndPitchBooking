import { useState } from 'react';
import type { Facility, GameFormat, Pitch, Surface, Team, TeamMembership } from '../../shared/types';
import { GAME_FORMATS, SURFACES } from '../../shared/types';
import { approvalStatusLabel, gameFormatLabel, surfaceLabel } from '../../shared/labels';
import { formatDateTime } from '../../shared/time';
import { api } from '../api';
import { useAction, useApi } from '../hooks';
import { RequireUser } from '../components/RequireUser';
import { ErrorBox, Field, Info, Loading, ageLabel, teamLabel } from '../components/ui';

type MembershipRow = TeamMembership & { team: Team; user: { id: string; name: string; email: string } };
type FacilityWithPitches = Facility & { pitches: Pitch[] };

export function OfficePage() {
  return (
    <RequireUser role="OFFICE">
      <h1>Kansli</h1>
      <Info>Spår 1 (kö för helgtider) kommer i nästa version. I Spår 2 använder lagen sina egna träningstider och kansliet behöver inte göra något.</Info>
      <Approvals />
      <Masterdata />
    </RequireUser>
  );
}

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
