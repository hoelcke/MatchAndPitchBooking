import { useState } from 'react';
import { NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { SessionProvider, useSession } from './session';
import { MarketPage } from './pages/MarketPage';
import { MatchPage } from './pages/MatchPage';
import { MyMatchesPage } from './pages/MyMatchesPage';
import { CreateMatchPage } from './pages/CreateMatchPage';
import { TeamsPage } from './pages/TeamsPage';
import { TeamPage } from './pages/TeamPage';
import { ReviewsPage } from './pages/ReviewsPage';
import { OfficePage } from './pages/OfficePage';
import { AdminPage } from './pages/AdminPage';
import { LoginPage } from './pages/LoginPage';
import { DevPage } from './pages/DevPage';

export function App() {
  return (
    <SessionProvider>
      <Shell />
    </SessionProvider>
  );
}

function Shell() {
  const { user, logout, config, loading } = useSession();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const close = () => setOpen(false);

  const links: Array<[string, string, boolean]> = [
    ['/', 'Börsen', true],
    ['/ny-match', 'Skapa match', user?.role === 'TEAM_LEADER'],
    ['/mina-matcher', 'Mina matcher', user?.role === 'TEAM_LEADER'],
    ['/fair-play', 'Fair Play', user?.role === 'TEAM_LEADER'],
    ['/lag', 'Mina lag', user?.role === 'TEAM_LEADER'],
    ['/kansli', 'Kansli', user?.role === 'OFFICE'],
    ['/admin', 'Admin', user?.role === 'ADMIN'],
    ['/dev', 'Dev', !!config?.devTools],
  ];

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <NavLink to="/" className="brand" onClick={close}>
            <span className="brand-mark">⚽</span> Matchbörsen
          </NavLink>
          <button className="menu-toggle" aria-expanded={open} aria-label="Meny" onClick={() => setOpen(!open)}>
            ☰
          </button>
          <nav className={`nav${open ? ' open' : ''}`}>
            {links
              .filter(([, , show]) => show)
              .map(([to, label]) => (
                <NavLink key={to} to={to} end={to === '/'} onClick={close}>
                  {label}
                </NavLink>
              ))}
            {user ? (
              <button className="link-button" onClick={() => { close(); void logout(); }}>
                Logga ut ({user.name.split(' ')[0]})
              </button>
            ) : (
              <NavLink to={`/logga-in?next=${encodeURIComponent(location.pathname)}`} onClick={close}>
                Logga in
              </NavLink>
            )}
          </nav>
        </div>
      </header>
      <main className="container">
        {loading ? null : (
          <Routes>
            <Route path="/" element={<MarketPage />} />
            <Route path="/matcher/:id" element={<MatchPage />} />
            <Route path="/mina-matcher" element={<MyMatchesPage />} />
            <Route path="/ny-match" element={<CreateMatchPage />} />
            <Route path="/lag" element={<TeamsPage />} />
            <Route path="/lag/:id" element={<TeamPage />} />
            <Route path="/fair-play" element={<ReviewsPage />} />
            <Route path="/kansli" element={<OfficePage />} />
            <Route path="/admin" element={<AdminPage />} />
            <Route path="/logga-in" element={<LoginPage />} />
            <Route path="/dev" element={<DevPage />} />
            <Route path="*" element={<p>Sidan finns inte.</p>} />
          </Routes>
        )}
      </main>
    </>
  );
}
