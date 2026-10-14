import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { LeaderContact } from '../../shared/types';
import type { MatchDetail } from '../../server/modules/matches';
import { categoryLabel, gameFormatLabel, inquiryStatusLabel, levelLabel, refereeLabel, reservationStatusLabel, surfaceLabel } from '../../shared/labels';
import { formatDateTime } from '../../shared/time';
import { api } from '../api';
import { useAction, useApi } from '../hooks';
import { useSession } from '../session';
import { ErrorBox, Field, Info, Loading, StatusBadge, TeamProfileLine, ageLabel, hasPitch, slotLabel, teamLabel } from '../components/ui';

function Contact({ title, c }: { title: string; c: LeaderContact }) {
  return (
    <div className="contact">
      <div className="muted small">{title}</div>
      <strong>{c.name}</strong> · {c.club} {c.teamName}
      <div>
        <a href={`tel:${c.phone.replace(/[^+\d]/g, '')}`}>{c.phone}</a> · <a href={`mailto:${c.email}`}>{c.email}</a>
      </div>
    </div>
  );
}

export function MatchPage() {
  const { id } = useParams();
  const { user } = useSession();
  const { data, error, loading, reload } = useApi<MatchDetail>(`/matches/${id}`);
  const action = useAction();
  const [phone, setPhone] = useState('');
  const [teamId, setTeamId] = useState('');

  if (loading && !data) return <Loading />;
  if (error || !data) return <ErrorBox message={error ?? 'Matchen hittades inte'} />;

  const { match: m, viewer, allowed, inquiries } = data;
  const act = async (fn: () => Promise<unknown>, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    const ok = await action.run(fn);
    await reload();
    return ok;
  };
  const chosenTeam = teamId || viewer.eligibleTeams[0]?.id;
  const activeInquiries = inquiries?.filter((i) => i.status === 'ACTIVE') ?? [];

  return (
    <>
      <p><Link to="/">← Börsen</Link></p>
      <div className={`card${m.isUrgent && m.status === 'PUBLISHED' ? ' urgent' : ''}`}>
        <div className="match-card-head">
          <span className="match-when">{slotLabel(m)}</span>
          <StatusBadge status={m.status} urgent={m.isUrgent} />
        </div>
        <h1 className="match-heading">
          {teamLabel(m.homeTeam)}
          {m.awayTeam && <> – {teamLabel(m.awayTeam)}</>}
        </h1>
        {m.isUrgent && m.status === 'PUBLISHED' && (
          <Info>Tidigare motståndare har lämnat återbud – laget söker snabbt en ny motståndare.</Info>
        )}
        <dl className="facts">
          <dt>Ålder</dt><dd>{categoryLabel[m.category]} {m.birthYear}{m.openToAdjacentBirthYears && ' (öppen för ett år yngre eller äldre)'}</dd>
          <dt>Spelform</dt><dd>{gameFormatLabel[m.gameFormat]}, speltid {m.durationMinutes} min</dd>
          <dt>Matchnivå</dt><dd>{levelLabel[m.matchLevel]}</dd>
          <dt>Plats</dt>
          <dd>
            {hasPitch(m) ? (
              <>{m.venue.facilityName}, {m.venue.pitchName} ({surfaceLabel[m.venue.surface].toLowerCase()})<br /><span className="muted">{m.venue.facilityAddress}</span></>
            ) : m.status === 'RESERVATION_REQUESTED' ? 'Tilldelas av kansliet' : 'Ingen plan tilldelades'}
          </dd>
          <dt>Domare</dt><dd>{refereeLabel[m.referee]}</dd>
          <dt>Hemmalagets ställ</dt><dd>{m.kitColorHome}</dd>
          <dt>Hemmalaget</dt><dd><Link to={`/lag/${m.homeTeam.id}`}>{teamLabel(m.homeTeam)}</Link><br /><TeamProfileLine team={m.homeTeam} /></dd>
        </dl>

        {(m.homeContact || m.selectedOpponent) && (
          <div className="contacts">
            {m.homeContact && viewer.isAwayLeader && <Contact title="Hemmalagets kontakt" c={m.homeContact} />}
            {m.selectedOpponent && viewer.isHomeLeader && <Contact title="Motståndarens kontakt" c={m.selectedOpponent} />}
          </div>
        )}
      </div>

      <ErrorBox message={action.error} />

      {/* Intresseanmälan (AC-103.1) */}
      {m.status === 'PUBLISHED' && !viewer.isHomeLeader && (
        <section className="card">
          <h2>Anmäl intresse</h2>
          {!user ? (
            <p><Link to={`/logga-in?next=/matcher/${m.id}`}>Logga in</Link> för att anmäla intresse.</p>
          ) : allowed.inquire ? (
            <form className="form" onSubmit={(e) => { e.preventDefault(); void act(() => api.post(`/matches/${m.id}/inquiries`, { teamId: chosenTeam, phone })); }}>
              {viewer.eligibleTeams.length > 1 && (
                <Field label="Lag">
                  <select value={chosenTeam} onChange={(e) => setTeamId(e.target.value)}>
                    {viewer.eligibleTeams.map((t) => <option key={t.id} value={t.id}>{teamLabel(t)}</option>)}
                  </select>
                </Field>
              )}
              {viewer.eligibleTeams.length === 1 && <p>Lag: <strong>{teamLabel(viewer.eligibleTeams[0])}</strong></p>}
              <Field label="Ditt telefonnummer" hint="Delas med hemmalaget om ni blir valda.">
                <input type="tel" required autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+46 70 123 45 67" />
              </Field>
              <button className="button" disabled={action.busy}>Anmäl intresse</button>
            </form>
          ) : viewer.myInquiries.some((i) => i.status === 'ACTIVE') ? null : (
            <p className="muted">Inget av dina lag matchar matchens kategori och födelseår.</p>
          )}
        </section>
      )}

      {viewer.myInquiries.length > 0 && (
        <section className="card">
          <h2>Era anmälningar</h2>
          <ul className="plain">
            {viewer.myInquiries.map((i) => (
              <li key={i.id} className="row">
                <span>{teamLabel(i.team)} – <strong>{inquiryStatusLabel[i.status]}</strong></span>
                {i.status === 'ACTIVE' && (
                  <button className="button secondary small" disabled={action.busy} onClick={() => void act(() => api.post(`/inquiries/${i.id}/withdraw`), 'Dra tillbaka intresseanmälan?')}>
                    Dra tillbaka
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {allowed.withdrawAsOpponent && (
        <section className="card">
          <h2>Kan ni inte spela?</h2>
          <p className="muted">Hemmalaget får ett akut meddelande och matchen läggs tillbaka på börsen.</p>
          <button className="button danger" disabled={action.busy} onClick={() => void act(() => api.post(`/matches/${m.id}/withdraw-opponent`), 'Lämna återbud till matchen?')}>
            Lämna återbud
          </button>
        </section>
      )}

      {/* Hemmalaget (A6, A8/A9, A13) */}
      {viewer.isHomeLeader && (
        <section className="card">
          <h2>Hemmalaget</h2>
          {data.reservation && <ReservationInfo r={data.reservation} matchStatus={m.status} />}
          {m.status === 'PUBLISHED' && (
            <>
              <h3>Intresseanmälningar ({activeInquiries.length})</h3>
              {activeInquiries.length === 0 && <p className="muted">Inga aktiva anmälningar än. Du får e-post när ett lag anmäler sig.</p>}
              <ul className="plain">
                {activeInquiries.map((i) => (
                  <li key={i.id} className="inquiry">
                    <div>
                      <Link to={`/lag/${i.team.id}`}><strong>{teamLabel(i.team)}</strong></Link> <span className="muted">({ageLabel(i.team)})</span>
                      <div className="small"><TeamProfileLine team={i.team} /></div>
                      <div className="muted small">Anmäld {formatDateTime(i.createdAt)}</div>
                    </div>
                    <button className="button small" disabled={action.busy || !allowed.select} onClick={() => void act(() => api.post(`/matches/${m.id}/select`, { inquiryId: i.id }), `Välj ${teamLabel(i.team)} som motståndare? Övriga anmälningar avvisas.`)}>
                      Välj
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          {m.status === 'MATCH_CONFIRMED' && (
            <>
              <p>
                Bekräfta att matchen spelats mellan <strong>{formatDateTime(data.confirmWindow.from)}</strong> och{' '}
                <strong>{formatDateTime(data.confirmWindow.until)}</strong>. Därefter skickas Fair Play-recensioner till båda lagen.
              </p>
              <button className="button" disabled={action.busy || !allowed.confirmCompleted} onClick={() => void act(() => api.post(`/matches/${m.id}/complete`), 'Bekräfta att matchen är genomförd?')}>
                Match genomförd
              </button>
            </>
          )}
          {allowed.cancel && (
            <div className="danger-zone">
              <p className="muted small">En publicerad match kan inte ändras. Avboka och skapa en ny match om något behöver ändras.</p>
              <button className="button danger secondary" disabled={action.busy} onClick={() => void act(() => api.post(`/matches/${m.id}/cancel`), 'Avboka matchen? Berörda lag meddelas.')}>
                Avboka match
              </button>
            </div>
          )}
          {m.status === 'COMPLETED' && <p>Matchen är genomförd. <Link to="/fair-play">Lämna Fair Play-recension</Link>.</p>}
        </section>
      )}
    </>
  );
}

/** Spår 1: kansliets handläggning och 14-dagarsfristen (Process B), bara för hemmalaget. */
function ReservationInfo({ r, matchStatus }: { r: NonNullable<MatchDetail['reservation']>; matchStatus: MatchDetail['match']['status'] }) {
  return (
    <div>
      <p>
        Helgtid via kansliet: <strong>{reservationStatusLabel[r.status]}</strong>
        <span className="muted small"> · önskat {r.requestedDate} kl {r.timeWindow}</span>
      </p>
      {r.status === 'REQUESTED' && <Info>Kansliet har fått er förfrågan. Matchen publiceras på börsen när en plan är tilldelad.</Info>}
      {r.status === 'RESERVED' && matchStatus === 'PUBLISHED' && (
        <Info>
          Välj motståndare senast <strong>{formatDateTime(r.deadlineAt)}</strong>. Annars återkallas plantiden automatiskt (14-dagarsregeln).
        </Info>
      )}
      {r.decisionReason && <p>Kansliets orsak: <em>{r.decisionReason}</em></p>}
    </div>
  );
}
