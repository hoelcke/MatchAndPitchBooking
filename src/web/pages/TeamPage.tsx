import { useParams } from 'react-router-dom';
import type { Team } from '../../shared/types';
import { categoryLabel, levelLabel } from '../../shared/labels';
import { useApi } from '../hooks';
import { ErrorBox, Loading, teamLabel } from '../components/ui';

/** FR-C-303: lagprofil med aggregerade värden. Enskilda recensioner visas aldrig (AC-302.4). */
export function TeamPage() {
  const { id } = useParams();
  const { data: team, error, loading } = useApi<Team>(`/teams/${id}`);
  if (loading && !team) return <Loading />;
  if (!team) return <ErrorBox message={error} />;
  return (
    <div className="card">
      <h1>{teamLabel(team)}</h1>
      <p>{categoryLabel[team.category]} {team.birthYear}</p>
      {team.profile.visible ? (
        <div className="stats">
          <div className="stat"><span className="stat-value">{levelLabel[team.profile.assessedLevel!]}</span><span className="stat-label">Bedömd nivå</span></div>
          <div className="stat"><span className="stat-value">{team.profile.fairPlayAverage!.toFixed(1).replace('.', ',')}</span><span className="stat-label">Fair Play (av 3)</span></div>
          <div className="stat"><span className="stat-value">{team.profile.reviewCount}</span><span className="stat-label">Recensioner</span></div>
        </div>
      ) : (
        <p className="muted">Lagprofilen visas när laget fått minst 3 Fair Play-recensioner.</p>
      )}
      <p className="muted small">Värdena bygger på motståndarnas bedömningar från de senaste högst 10 matcherna.</p>
    </div>
  );
}
