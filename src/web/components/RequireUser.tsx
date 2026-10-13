import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import type { UserRole } from '../../shared/types';
import { useSession } from '../session';

export function RequireUser({ role, children }: { role?: UserRole; children: ReactNode }) {
  const { user } = useSession();
  const location = useLocation();
  if (!user)
    return (
      <div className="card">
        <p>Du behöver logga in för att se den här sidan.</p>
        <Link className="button" to={`/logga-in?next=${encodeURIComponent(location.pathname)}`}>
          Logga in
        </Link>
      </div>
    );
  if (role && user.role !== role) return <p>Du har inte behörighet till den här sidan.</p>;
  return <>{children}</>;
}
