import { useState } from 'react';
import { api } from '../api';
import { useAction, useApi } from '../hooks';
import { useSession } from '../session';
import { ErrorBox } from '../components/ui';
import { formatDateTime } from '../../shared/time';

interface Email { id: string; to_email: string; subject: string; body: string; urgent: number; created_at: string; sent_at: string | null }
interface Audit { id: string; event_id: string; user_id: string; entity_type: string; entity_id: string; transition: string; occurred_at: string }
interface Outbox { event_id: string; event_type: string; match_id: string; sequence: number; payload: string; processed_at: string | null }

/** Utvecklarverktyg: tidsmaskin, utkorg, revisionslogg och outbox. Avstängt i produktion. */
export function DevPage() {
  const { config, reload: reloadSession } = useSession();
  const emails = useApi<Email[]>(config?.devTools ? '/dev/emails' : null);
  const audit = useApi<Audit[]>(config?.devTools ? '/dev/audit' : null);
  const outbox = useApi<Outbox[]>(config?.devTools ? '/dev/outbox' : null);
  const action = useAction();
  const [result, setResult] = useState<string>();
  if (!config?.devTools) return <p>Dev-verktyg är avstängda.</p>;

  const refresh = async () => {
    await Promise.all([emails.reload(), audit.reload(), outbox.reload(), reloadSession()]);
  };
  const clock = async (body: object) => {
    const r = await action.run(() => api.post<{ now: string; offsetHours: number; expired: number; reminders: number; reviewMatches: number }>('/dev/clock', body));
    if (r) setResult(`Klockan är nu ${formatDateTime(r.now)} (förskjutning ${r.offsetHours} h). Utgångna matcher: ${r.expired}, påminnelser: ${r.reminders}, recensionsfrister: ${r.reviewMatches}.`);
    await refresh();
  };

  return (
    <>
      <h1>Dev-verktyg</h1>
      <ErrorBox message={action.error} />
      <section className="card">
        <h2>Tidsmaskin</h2>
        <p className="muted small">Flytta serverns klocka framåt och kör schemaläggaren, för att prova starttid, 48-timmarsfristen och 7-dagarsfristen.</p>
        <div className="actions wrap">
          {[1, 6, 24, 48, 24 * 7].map((h) => (
            <button key={h} className="button small secondary" disabled={action.busy} onClick={() => void clock({ hours: h })}>
              +{h >= 24 ? `${h / 24} d` : `${h} h`}
            </button>
          ))}
          <button className="button small" disabled={action.busy} onClick={() => void clock({ reset: true })}>Återställ</button>
        </div>
        {result && <p className="small">{result}</p>}
      </section>

      <section className="card">
        <h2>Utkorg (e-post)</h2>
        <ul className="plain mail">
          {emails.data?.map((m) => (
            <li key={m.id}>
              <details>
                <summary>
                  {m.urgent ? <span className="badge badge-urgent">Akut</span> : null} <strong>{m.subject}</strong>
                  <span className="muted small"> → {m.to_email} · {formatDateTime(m.created_at)}{m.sent_at ? '' : ' · i kö'}</span>
                </summary>
                <pre>{m.body}</pre>
              </details>
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>Outbox-event</h2>
        <ul className="plain small">
          {outbox.data?.map((e) => (
            <li key={e.event_id}>
              <details>
                <summary><code>{e.event_type}</code> #{e.sequence} {e.processed_at ? '✓' : '(väntar)'}</summary>
                <pre>{JSON.stringify(JSON.parse(e.payload), null, 2)}</pre>
              </details>
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>Revisionslogg</h2>
        <div className="table-wrap">
          <table className="small">
            <thead><tr><th>Tid</th><th>Användare</th><th>Entitet</th><th>Övergång</th></tr></thead>
            <tbody>
              {audit.data?.map((a) => (
                <tr key={a.id}><td>{formatDateTime(a.occurred_at)}</td><td><code>{a.user_id}</code></td><td>{a.entity_type}</td><td>{a.transition}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
