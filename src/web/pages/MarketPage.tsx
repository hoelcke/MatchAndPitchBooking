import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { MatchCard as MatchCardData } from '../../server/modules/matches';
import { GAME_FORMATS, LEVELS, TEAM_CATEGORIES } from '../../shared/types';
import { categoryLabel, gameFormatLabel, levelLabel } from '../../shared/labels';
import { useApi } from '../hooks';
import { useSession } from '../session';
import { ErrorBox, Loading, MatchCard } from '../components/ui';

/** FR-A-102: Matchbörsen. Öppen även för gäster, utan kontaktuppgifter. */
export function MarketPage() {
  const { user, homeTeams } = useSession();
  const [filters, setFilters] = useState({ gameFormat: '', category: '', matchLevel: '', birthYear: '', dateFrom: '', dateTo: '' });
  const query = useMemo(() => {
    const p = new URLSearchParams(Object.entries(filters).filter(([, v]) => v));
    return `/matches?${p}`;
  }, [filters]);
  const { data, error, loading } = useApi<MatchCardData[]>(query);
  const set = (k: keyof typeof filters) => (e: { target: { value: string } }) => setFilters({ ...filters, [k]: e.target.value });
  const active = Object.values(filters).some(Boolean);

  return (
    <>
      <div className="page-head">
        <h1>Matchbörsen</h1>
        {homeTeams.length > 0 && (
          <Link className="button" to="/ny-match">
            + Skapa match
          </Link>
        )}
      </div>
      {!user && (
        <p className="muted">
          Hitta träningsmotstånd hos IFK Lidingö. <Link to="/logga-in">Logga in</Link> för att anmäla intresse.
        </p>
      )}

      <details className="filters" open={active || undefined}>
        <summary>Filtrera{active && ' (aktiva)'}</summary>
        <div className="filter-grid">
          <select value={filters.gameFormat} onChange={set('gameFormat')} aria-label="Spelform">
            <option value="">Alla spelformer</option>
            {GAME_FORMATS.map((f) => (
              <option key={f} value={f}>{gameFormatLabel[f]}</option>
            ))}
          </select>
          <select value={filters.category} onChange={set('category')} aria-label="Kategori">
            <option value="">Alla kategorier</option>
            {TEAM_CATEGORIES.map((c) => (
              <option key={c} value={c}>{categoryLabel[c]}</option>
            ))}
          </select>
          <input type="number" inputMode="numeric" placeholder="Födelseår, t.ex. 2015" value={filters.birthYear} onChange={set('birthYear')} aria-label="Födelseår" />
          <select value={filters.matchLevel} onChange={set('matchLevel')} aria-label="Matchnivå">
            <option value="">Alla nivåer</option>
            {LEVELS.map((l) => (
              <option key={l} value={l}>{levelLabel[l]}</option>
            ))}
          </select>
          <label className="inline-field">Från <input type="date" value={filters.dateFrom} onChange={set('dateFrom')} /></label>
          <label className="inline-field">Till <input type="date" value={filters.dateTo} onChange={set('dateTo')} /></label>
          {active && (
            <button className="link-button" onClick={() => setFilters({ gameFormat: '', category: '', matchLevel: '', birthYear: '', dateFrom: '', dateTo: '' })}>
              Rensa filter
            </button>
          )}
        </div>
      </details>

      <ErrorBox message={error} />
      {loading && !data ? (
        <Loading />
      ) : data && data.length === 0 ? (
        <p className="muted">Inga matcher matchar just nu.</p>
      ) : (
        <div className="list">{data?.map((m) => <MatchCard key={m.id} match={m} />)}</div>
      )}
    </>
  );
}
