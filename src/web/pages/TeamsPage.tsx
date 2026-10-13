import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { Team, TeamCategory } from '../../shared/types';
import { TEAM_CATEGORIES } from '../../shared/types';
import { HOME_CLUB_NAME } from '../../shared/rules';
import { approvalStatusLabel, categoryLabel } from '../../shared/labels';
import { api } from '../api';
import { useAction, useApi } from '../hooks';
import { useSession } from '../session';
import { RequireUser } from '../components/RequireUser';
import { ErrorBox, Field, ageLabel, teamLabel } from '../components/ui';

export function TeamsPage() {
  return (
    <RequireUser role="TEAM_LEADER">
      <Teams />
    </RequireUser>
  );
}

/** FR-U-002: lagprofil och ledarkoppling. */
function Teams() {
  const { memberships, reload } = useSession();
  const { data: allTeams, reload: reloadTeams } = useApi<Team[]>('/teams');
  const action = useAction();
  const [form, setForm] = useState({ isHomeClub: true, clubName: '', name: '', birthYear: new Date().getFullYear() - 10, category: 'BOYS' as TeamCategory });
  const [joinId, setJoinId] = useState('');

  const myTeamIds = new Set(memberships.map((m) => m.teamId));
  const joinable = allTeams?.filter((t) => !myTeamIds.has(t.id)) ?? [];

  const create = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await action.run(() => api.post('/teams', form));
    if (ok) {
      setForm({ ...form, name: '', clubName: '' });
      await Promise.all([reload(), reloadTeams()]);
    }
  };
  const join = async () => {
    const ok = await action.run(() => api.post(`/teams/${joinId}/join`));
    if (ok) {
      setJoinId('');
      await reload();
    }
  };

  return (
    <>
      <h1>Mina lag</h1>
      <ErrorBox message={action.error} />
      {memberships.length === 0 ? (
        <p className="muted">Du är inte kopplad till något lag än.</p>
      ) : (
        <ul className="plain card">
          {memberships.map((m) => (
            <li key={m.id} className="row">
              <span>
                <Link to={`/lag/${m.team.id}`}><strong>{teamLabel(m.team)}</strong></Link> <span className="muted">({ageLabel(m.team)})</span>
              </span>
              <span className={`badge badge-${m.approvalStatus.toLowerCase()}`}>{approvalStatusLabel[m.approvalStatus]}</span>
            </li>
          ))}
        </ul>
      )}

      <section className="card">
        <h2>Skapa lagprofil</h2>
        <form className="form" onSubmit={create}>
          <div className="segmented">
            <label><input type="radio" checked={form.isHomeClub} onChange={() => setForm({ ...form, isHomeClub: true })} /> {HOME_CLUB_NAME}-lag</label>
            <label><input type="radio" checked={!form.isHomeClub} onChange={() => setForm({ ...form, isHomeClub: false })} /> Annan klubb</label>
          </div>
          {form.isHomeClub ? (
            <p className="muted small">Kansliet godkänner kopplingen innan du kan skapa matcher.</p>
          ) : (
            <Field label="Klubb">
              <input required value={form.clubName} onChange={(e) => setForm({ ...form, clubName: e.target.value })} placeholder="T.ex. Hammarby IF" />
            </Field>
          )}
          <Field label="Lagnamn">
            <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="T.ex. P2015 Blå" />
          </Field>
          <div className="two">
            <Field label="Födelseår">
              <input type="number" required value={form.birthYear} onChange={(e) => setForm({ ...form, birthYear: Number(e.target.value) })} />
            </Field>
            <Field label="Kategori">
              <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value as TeamCategory })}>
                {TEAM_CATEGORIES.map((c) => <option key={c} value={c}>{categoryLabel[c]}</option>)}
              </select>
            </Field>
          </div>
          <button className="button" disabled={action.busy}>Skapa lag</button>
        </form>
      </section>

      {joinable.length > 0 && (
        <section className="card">
          <h2>Koppla dig till befintligt lag</h2>
          <div className="form">
            <select value={joinId} onChange={(e) => setJoinId(e.target.value)}>
              <option value="">Välj lag</option>
              {joinable.map((t) => <option key={t.id} value={t.id}>{teamLabel(t)} ({ageLabel(t)})</option>)}
            </select>
            <button className="button secondary" disabled={!joinId || action.busy} onClick={() => void join()}>Koppla mig</button>
          </div>
        </section>
      )}
    </>
  );
}
