import { useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { User } from '../../shared/types';
import { api } from '../api';
import { useAction, useApi } from '../hooks';
import { useSession } from '../session';
import { ErrorBox } from '../components/ui';

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (o: { client_id: string; callback: (r: { credential: string }) => void }) => void;
          renderButton: (el: HTMLElement, o: Record<string, unknown>) => void;
        };
      };
    };
  }
}

const roleLabel: Record<User['role'], string> = { TEAM_LEADER: 'Lagledare', OFFICE: 'Kansli', ADMIN: 'Administratör' };

/** AC-U-001.1: inloggning med Google Identity Services. Dev-växlaren finns bara i dev/test (öppen punkt 2). */
export function LoginPage() {
  const { config, reload, user } = useSession();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = params.get('next') || '/';
  const action = useAction();
  const buttonRef = useRef<HTMLDivElement>(null);
  const { data: devUsers } = useApi<User[]>(config?.devTools ? '/dev/users' : null);

  const done = async () => {
    await reload();
    navigate(next);
  };

  useEffect(() => {
    const clientId = config?.googleClientId;
    if (!clientId || !buttonRef.current) return;
    const render = () => {
      window.google!.accounts.id.initialize({
        client_id: clientId,
        callback: (r) => void action.run(() => api.post('/auth/google', { credential: r.credential })).then((ok) => ok && done()),
      });
      window.google!.accounts.id.renderButton(buttonRef.current!, { theme: 'outline', size: 'large', text: 'signin_with', locale: 'sv' });
    };
    if (window.google) return render();
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = render;
    document.head.appendChild(s);
  }, [config?.googleClientId]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <h1>Logga in</h1>
      {user && <p>Du är inloggad som {user.name}.</p>}
      <ErrorBox message={action.error} />
      <section className="card">
        <p>Lagledare och kansli loggar in med sitt Google-konto. Ett konto skapas vid första inloggningen.</p>
        {config?.googleClientId ? <div ref={buttonRef} /> : <p className="muted small">Google-inloggning är inte konfigurerad (GOOGLE_CLIENT_ID saknas).</p>}
      </section>
      {config?.devTools && devUsers && (
        <section className="card dev">
          <h2>Testanvändare (endast dev)</h2>
          <ul className="plain">
            {devUsers.map((u) => (
              <li key={u.id} className="row">
                <span>
                  <strong>{u.name}</strong> <span className="muted small">{roleLabel[u.role]}</span>
                </span>
                <button className="button small secondary" disabled={action.busy} onClick={async () => { const ok = await action.run(() => api.post('/dev/login', { userId: u.id })); if (ok) await done(); }}>
                  Logga in
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
