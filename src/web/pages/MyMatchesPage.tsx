import { Link } from 'react-router-dom';
import type { InquiryStatus } from '../../shared/types';
import type { MatchCard as MatchCardData } from '../../server/modules/matches';
import { inquiryStatusLabel } from '../../shared/labels';
import { useApi } from '../hooks';
import { RequireUser } from '../components/RequireUser';
import { ErrorBox, Loading, MatchCard } from '../components/ui';

interface Mine {
  home: MatchCardData[];
  away: MatchCardData[];
  inquiries: Array<{ id: string; status: InquiryStatus; teamId: string; match: MatchCardData }>;
}

const isOpen = (m: MatchCardData) => ['RESERVATION_REQUESTED', 'PUBLISHED', 'MATCH_CONFIRMED'].includes(m.status);

export function MyMatchesPage() {
  return (
    <RequireUser role="TEAM_LEADER">
      <MyMatches />
    </RequireUser>
  );
}

function MyMatches() {
  const { data, error, loading } = useApi<Mine>('/matches/mine');
  if (loading && !data) return <Loading />;
  if (!data) return <ErrorBox message={error} />;

  const upcoming = [...data.home, ...data.away].filter(isOpen).sort((a, b) => a.venue.startTime.localeCompare(b.venue.startTime));
  const history = [...data.home, ...data.away].filter((m) => !isOpen(m));
  const openInquiries = data.inquiries.filter((i) => i.match.status === 'PUBLISHED');

  return (
    <>
      <h1>Mina matcher</h1>
      <h2>Kommande</h2>
      {upcoming.length === 0 ? <p className="muted">Inga kommande matcher. <Link to="/">Hitta motstånd på börsen</Link>.</p> : <div className="list">{upcoming.map((m) => <MatchCard key={m.id} match={m} />)}</div>}

      {openInquiries.length > 0 && (
        <>
          <h2>Intresseanmälningar</h2>
          <div className="list">
            {openInquiries.map((i) => (
              <div key={i.id}>
                <div className="small">Status: <strong>{inquiryStatusLabel[i.status]}</strong></div>
                <MatchCard match={i.match} />
              </div>
            ))}
          </div>
        </>
      )}

      {history.length > 0 && (
        <>
          <h2>Historik</h2>
          <div className="list">{history.map((m) => <MatchCard key={m.id} match={m} />)}</div>
        </>
      )}
    </>
  );
}
