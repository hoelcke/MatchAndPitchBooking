import { useState } from 'react';
import type { FairPlayReviewEntity, Level, Team } from '../../shared/types';
import { LEVELS } from '../../shared/types';
import { levelLabel, reviewStatusLabel } from '../../shared/labels';
import { formatDateTime, formatSlot } from '../../shared/time';
import { api } from '../api';
import { useAction, useApi } from '../hooks';
import { RequireUser } from '../components/RequireUser';
import { ErrorBox, Loading, teamLabel } from '../components/ui';

type MyReview = FairPlayReviewEntity & {
  reviewingTeam: Team;
  reviewedTeam: Team;
  match: { id: string; startTime: string; endTime: string; facilityName: string };
};

export function ReviewsPage() {
  return (
    <RequireUser role="TEAM_LEADER">
      <Reviews />
    </RequireUser>
  );
}

function Reviews() {
  const { data, error, loading, reload } = useApi<MyReview[]>('/reviews/mine');
  if (loading && !data) return <Loading />;
  if (!data) return <ErrorBox message={error} />;
  const pending = data.filter((r) => r.status === 'PENDING');
  const done = data.filter((r) => r.status !== 'PENDING');
  return (
    <>
      <h1>Fair Play</h1>
      <p className="muted">
        Recensionerna är blinda: de räknas in i lagprofilerna först när båda lagen svarat eller 7 dagar gått. Det recenserade laget ser aldrig enskilda svar.
      </p>
      {pending.length === 0 && <p>Inga recensioner att fylla i just nu.</p>}
      {pending.map((r) => <ReviewForm key={r.id} review={r} onDone={reload} />)}
      {done.length > 0 && (
        <>
          <h2>Tidigare</h2>
          <ul className="plain card">
            {done.map((r) => (
              <li key={r.id} className="row">
                <span>{teamLabel(r.reviewedTeam)} <span className="muted small">{formatDateTime(r.match.startTime)}</span></span>
                <span className="badge">{reviewStatusLabel[r.status]}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function Score({ label, value, onChange, allowNa }: { label: string; value?: number | 'NOT_APPLICABLE'; onChange: (v: number | 'NOT_APPLICABLE') => void; allowNa?: boolean }) {
  const options: Array<[number | 'NOT_APPLICABLE', string]> = [[1, '1'], [2, '2'], [3, '3'], ...(allowNa ? [['NOT_APPLICABLE', 'Ej aktuellt'] as [string, string]] : [])] as Array<[number | 'NOT_APPLICABLE', string]>;
  return (
    <fieldset className="score">
      <legend>{label}</legend>
      <div className="segmented">
        {options.map(([v, text]) => (
          <button type="button" key={String(v)} className={value === v ? 'on' : ''} aria-pressed={value === v} onClick={() => onChange(v)}>
            {text}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

/** AC-301.3: delbetyg 1–3 för spelare, ledare och publik samt bedömd nivå. Ingen fritext. */
function ReviewForm({ review, onDone }: { review: MyReview; onDone: () => Promise<void> }) {
  const action = useAction();
  const [players, setPlayers] = useState<number>();
  const [leaders, setLeaders] = useState<number>();
  const [spectators, setSpectators] = useState<number | 'NOT_APPLICABLE'>();
  const [level, setLevel] = useState<Level | ''>('');
  const complete = players && leaders && spectators && level;

  return (
    <section className="card">
      <h2>{teamLabel(review.reviewedTeam)}</h2>
      <p className="muted small">
        {formatSlot(review.match.startTime, review.match.endTime)}, {review.match.facilityName} · Svara senast {formatDateTime(review.deadlineAt)}
      </p>
      <ErrorBox message={action.error} />
      <p className="small">1 = dåligt, 2 = okej, 3 = mycket bra</p>
      <Score label="Spelarnas uppträdande" value={players} onChange={(v) => setPlayers(v as number)} />
      <Score label="Ledarnas uppträdande" value={leaders} onChange={(v) => setLeaders(v as number)} />
      <Score label="Publikens uppträdande" value={spectators} onChange={setSpectators} allowNa />
      <label className="field">
        <span className="field-label">Motståndarens nivå</span>
        <select value={level} onChange={(e) => setLevel(e.target.value as Level)}>
          <option value="">Välj nivå</option>
          {LEVELS.map((l) => <option key={l} value={l}>{levelLabel[l]}</option>)}
        </select>
      </label>
      <button
        className="button"
        disabled={!complete || action.busy}
        onClick={async () => {
          const ok = await action.run(() =>
            api.post(`/reviews/${review.id}`, { playersScore: players, leadersScore: leaders, spectatorsScore: spectators, assessedLevel: level }),
          );
          if (ok) await onDone();
        }}
      >
        Skicka recension
      </button>
    </section>
  );
}
