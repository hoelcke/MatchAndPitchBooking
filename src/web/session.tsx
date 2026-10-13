import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Team, TeamMembership, User } from '../shared/types';
import { api } from './api';

export type Membership = TeamMembership & { team: Team };

interface Config {
  googleClientId: string | null;
  devTools: boolean;
  now: string;
}

interface Session {
  loading: boolean;
  user: User | null;
  memberships: Membership[];
  config: Config | null;
  reload: () => Promise<void>;
  logout: () => Promise<void>;
  /** Lag där användaren får agera (godkänd eller externt lag). */
  activeTeams: Team[];
  /** IFK Lidingö-lag där användaren är godkänd och får skapa matcher. */
  homeTeams: Team[];
}

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<User | null>(null);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [config, setConfig] = useState<Config | null>(null);

  const reload = useCallback(async () => {
    const [me, cfg] = await Promise.all([
      api.get<{ user: User | null; memberships: Membership[] }>('/me'),
      api.get<Config>('/config'),
    ]);
    setUser(me.user);
    setMemberships(me.memberships);
    setConfig(cfg);
    setLoading(false);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const logout = async () => {
    await api.post('/auth/logout');
    await reload();
  };

  const active = memberships.filter((m) => m.approvalStatus === 'APPROVED' || m.approvalStatus === 'NOT_REQUIRED');
  const value: Session = {
    loading,
    user,
    memberships,
    config,
    reload,
    logout,
    activeTeams: active.map((m) => m.team),
    homeTeams: active.filter((m) => m.team.isHomeClub).map((m) => m.team),
  };
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error('SessionProvider saknas');
  return s;
}
