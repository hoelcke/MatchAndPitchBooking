import type { FairPlayReviewEntity, Team } from '../../shared/types';
import { levelLabel, reviewStatusLabel } from '../../shared/labels';
import { formatDateTime } from '../../shared/time';
import { useApi } from '../hooks';
import { RequireUser } from '../components/RequireUser';
import { Loading, teamLabel } from '../components/ui';

type Row = FairPlayReviewEntity & { reviewingTeam: Team; reviewedTeam: Team };

/** AC-302.4: administratören kan läsa enskilda recensioner. */
export function AdminPage() {
  return (
    <RequireUser role="ADMIN">
      <AdminReviews />
    </RequireUser>
  );
}

function AdminReviews() {
  const { data } = useApi<Row[]>('/admin/reviews');
  if (!data) return <Loading />;
  const spect = (v: Row['spectatorsScore']) => (v === 'NOT_APPLICABLE' ? 'ej akt.' : (v ?? '–'));
  return (
    <>
      <h1>Fair Play-recensioner</h1>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Recenserat lag</th><th>Av</th><th>Spelare</th><th>Ledare</th><th>Publik</th><th>Total</th><th>Nivå</th><th>Status</th><th>Inskickad</th></tr>
          </thead>
          <tbody>
            {data.map((r) => (
              <tr key={r.id}>
                <td>{teamLabel(r.reviewedTeam)}</td>
                <td>{teamLabel(r.reviewingTeam)}</td>
                <td>{r.playersScore ?? '–'}</td>
                <td>{r.leadersScore ?? '–'}</td>
                <td>{spect(r.spectatorsScore)}</td>
                <td>{r.totalScore?.toFixed(2) ?? '–'}</td>
                <td>{r.assessedLevel ? levelLabel[r.assessedLevel] : '–'}</td>
                <td>{reviewStatusLabel[r.status]}</td>
                <td>{r.submittedAt ? formatDateTime(r.submittedAt) : '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
