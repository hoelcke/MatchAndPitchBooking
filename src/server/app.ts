import express, { type NextFunction, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { OAuth2Client } from 'google-auth-library';
import type { Ctx } from './context.js';
import type { User, UserRole } from '../shared/types.js';
import type { Runtime } from './runtime.js';
import { AppError, badRequest, forbidden, unauthorized } from './infra/errors.js';
import { all } from './infra/db.js';
import * as identity from './modules/identity.js';
import * as masterdata from './modules/masterdata.js';
import * as matches from './modules/matches.js';
import * as fairplay from './modules/fairplay.js';

export interface AppConfig {
  googleClientId?: string;
  officeEmails: string[];
  adminEmails: string[];
  devTools: boolean;
  secureCookies: boolean;
  staticDir?: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: User;
  }
}

const SESSION_COOKIE = 'mb_session';

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

export function createApp(ctx: Ctx, runtime: Runtime, config: AppConfig) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  // Session -> req.user
  app.use((req, _res, next) => {
    const token = readCookie(req, SESSION_COOKIE);
    if (token) req.user = identity.userForSession(ctx, token);
    next();
  });

  // Enkel CSRF-spärr: ändrande anrop måste vara JSON (kan inte skickas från ett vanligt formulär).
  app.use('/api', (req, _res, next) => {
    if (req.method !== 'GET' && !req.is('application/json')) return next(badRequest('Content-Type måste vara application/json'));
    next();
  });

  // Efter ändrande anrop: leverera outbox och e-post direkt (NFR-03).
  app.use('/api', (req, res, next) => {
    if (req.method !== 'GET') res.on('finish', () => void runtime.flush().catch(console.error));
    next();
  });

  const requireUser = (req: Request): User => {
    if (!req.user) throw unauthorized();
    return req.user;
  };
  const requireRole = (req: Request, ...roles: UserRole[]): User => {
    const u = requireUser(req);
    if (!roles.includes(u.role)) throw forbidden();
    return u;
  };

  const startSession = (res: Response, userId: string) => {
    const s = identity.createSession(ctx, userId);
    res.cookie(SESSION_COOKIE, s.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.secureCookies,
      expires: new Date(s.expiresAt),
      path: '/',
    });
  };

  const api = express.Router();

  // ---------- Konfiguration och konto ----------

  api.get('/config', (_req, res) => {
    res.json({ googleClientId: config.googleClientId ?? null, devTools: config.devTools, now: ctx.clock.nowIso() });
  });

  api.get('/me', (req, res) => {
    if (!req.user) return res.json({ user: null, memberships: [] });
    res.json({ user: req.user, memberships: identity.membershipsForUser(ctx, req.user.id) });
  });

  const google = config.googleClientId ? new OAuth2Client(config.googleClientId) : undefined;

  /** AC-U-001.1: Google Identity Services. Klienten skickar ID-token (credential). */
  api.post('/auth/google', async (req, res) => {
    if (!google) throw new AppError(501, 'NOT_CONFIGURED', 'Google-inloggning är inte konfigurerad');
    const credential = String(req.body?.credential ?? '');
    const ticket = await google.verifyIdToken({ idToken: credential, audience: config.googleClientId }).catch(() => {
      throw unauthorized('Ogiltig Google-inloggning');
    });
    const p = ticket.getPayload();
    if (!p?.sub || !p.email || !p.email_verified) throw unauthorized('Google-kontot saknar verifierad e-post');
    const email = p.email.toLowerCase();
    const user = identity.upsertGoogleUser(ctx, { subject: p.sub, email, name: p.name ?? email }, (e) =>
      config.adminEmails.includes(e) ? 'ADMIN' : config.officeEmails.includes(e) ? 'OFFICE' : 'TEAM_LEADER',
    );
    startSession(res, user.id);
    res.json({ user });
  });

  api.post('/auth/logout', (req, res) => {
    const token = readCookie(req, SESSION_COOKIE);
    if (token) identity.deleteSession(ctx, token);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  // ---------- Lag och ledarkopplingar ----------

  api.get('/teams', (_req, res) => {
    res.json(identity.listTeams(ctx).map(identity.publicTeam));
  });

  api.get('/teams/:id', (req, res) => {
    res.json(identity.publicTeam(identity.requireTeam(ctx, req.params.id)));
  });

  api.post('/teams', (req, res) => {
    const user = requireRole(req, 'TEAM_LEADER');
    res.status(201).json(identity.createTeam(ctx, user, req.body));
  });

  api.post('/teams/:id/join', (req, res) => {
    const user = requireRole(req, 'TEAM_LEADER');
    res.status(201).json(identity.joinTeam(ctx, user, req.params.id));
  });

  // ---------- Masterdata ----------

  api.get('/facilities', (_req, res) => {
    res.json(masterdata.listFacilities(ctx, { activeOnly: true }));
  });

  // ---------- Process A: matcher ----------

  api.get('/matches', (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    res.json(
      matches.listMarket(ctx, {
        gameFormat: (q.gameFormat || undefined) as matches.MarketFilters['gameFormat'],
        category: (q.category || undefined) as matches.MarketFilters['category'],
        matchLevel: (q.matchLevel || undefined) as matches.MarketFilters['matchLevel'],
        birthYear: q.birthYear ? Number(q.birthYear) : undefined,
        dateFrom: q.dateFrom || undefined,
        dateTo: q.dateTo || undefined,
      }),
    );
  });

  api.get('/matches/mine', (req, res) => {
    res.json(matches.listMyMatches(ctx, requireUser(req)));
  });

  api.get('/matches/:id', (req, res) => {
    res.json(matches.getMatchDetail(ctx, req.params.id, req.user));
  });

  api.post('/matches', (req, res) => {
    const user = requireRole(req, 'TEAM_LEADER');
    if (req.body?.origin === 'NEW_WEEKEND_SLOT')
      throw new AppError(501, 'NOT_IMPLEMENTED', 'Spår 1 (ny helgtid via kansliet) ingår inte i detta utkast');
    res.status(201).json(matches.createOwnSlotMatch(ctx, user, req.body));
  });

  api.post('/matches/:id/inquiries', (req, res) => {
    const user = requireRole(req, 'TEAM_LEADER');
    res.status(201).json(matches.createInquiry(ctx, user, req.params.id, req.body));
  });

  api.post('/inquiries/:id/withdraw', (req, res) => {
    matches.withdrawInquiry(ctx, requireUser(req), req.params.id);
    res.json({ ok: true });
  });

  api.post('/matches/:id/select', (req, res) => {
    res.json(matches.selectOpponent(ctx, requireUser(req), req.params.id, String(req.body?.inquiryId ?? '')));
  });

  api.post('/matches/:id/withdraw-opponent', (req, res) => {
    res.json(matches.withdrawAsOpponent(ctx, requireUser(req), req.params.id));
  });

  api.post('/matches/:id/cancel', (req, res) => {
    res.json(matches.cancelMatch(ctx, requireUser(req), req.params.id));
  });

  api.post('/matches/:id/complete', (req, res) => {
    res.json(matches.confirmCompleted(ctx, requireUser(req), req.params.id));
  });

  // ---------- Process C: Fair Play ----------

  api.get('/reviews/mine', (req, res) => {
    res.json(fairplay.listMyReviews(ctx, requireUser(req)));
  });

  api.post('/reviews/:id', (req, res) => {
    res.json(fairplay.submitReview(ctx, requireUser(req), req.params.id, req.body));
  });

  // ---------- Kansli ----------

  api.get('/office/memberships', (req, res) => {
    requireRole(req, 'OFFICE');
    res.json({
      pending: identity.listMemberships(ctx, 'PENDING'),
      all: identity.listMemberships(ctx),
    });
  });

  api.post('/office/memberships/:id/decision', (req, res) => {
    const user = requireRole(req, 'OFFICE');
    res.json(identity.decideMembership(ctx, user, req.params.id, req.body?.approve === true));
  });

  api.get('/office/facilities', (req, res) => {
    requireRole(req, 'OFFICE');
    res.json(masterdata.listFacilities(ctx, { activeOnly: false }));
  });

  api.post('/office/facilities', (req, res) => {
    res.status(201).json(masterdata.createFacility(ctx, requireRole(req, 'OFFICE'), req.body));
  });

  api.put('/office/facilities/:id', (req, res) => {
    res.json(masterdata.updateFacility(ctx, requireRole(req, 'OFFICE'), req.params.id, req.body));
  });

  api.post('/office/pitches', (req, res) => {
    res.status(201).json(masterdata.createPitch(ctx, requireRole(req, 'OFFICE'), req.body));
  });

  api.put('/office/pitches/:id', (req, res) => {
    res.json(masterdata.updatePitch(ctx, requireRole(req, 'OFFICE'), req.params.id, req.body));
  });

  // ---------- Administratör ----------

  api.get('/admin/reviews', (req, res) => {
    requireRole(req, 'ADMIN');
    res.json(fairplay.listAllReviews(ctx));
  });

  // ---------- Dev-verktyg (öppen punkt 2) ----------

  if (config.devTools) {
    api.get('/dev/users', (_req, res) => {
      res.json(identity.listUsers(ctx));
    });
    api.post('/dev/login', (req, res) => {
      const user = identity.getUser(ctx, String(req.body?.userId ?? ''));
      if (!user) throw badRequest('Okänd användare');
      startSession(res, user.id);
      res.json({ user });
    });
    api.get('/dev/emails', (_req, res) => {
      res.json(all(ctx.db, `SELECT * FROM email_outbox ORDER BY created_at DESC LIMIT 100`));
    });
    api.get('/dev/audit', (_req, res) => {
      res.json(all(ctx.db, `SELECT * FROM audit_log ORDER BY occurred_at DESC LIMIT 200`));
    });
    api.get('/dev/outbox', (_req, res) => {
      res.json(all(ctx.db, `SELECT * FROM outbox_events ORDER BY created_at DESC LIMIT 100`));
    });
    /** Tidsmaskin: flytta klockan framåt och kör schemaläggaren. */
    api.post('/dev/clock', async (req, res) => {
      if (req.body?.reset) ctx.clock.reset();
      else ctx.clock.advance(Number(req.body?.hours ?? 0) * 3_600_000);
      const result = await runtime.tick();
      res.json({ now: ctx.clock.nowIso(), offsetHours: ctx.clock.offset / 3_600_000, ...result });
    });
    api.post('/dev/tick', async (_req, res) => {
      res.json(await runtime.tick());
    });
  }

  api.use((_req, _res, next) => next(new AppError(404, 'NOT_FOUND', 'Okänd API-väg')));

  app.use('/api', api);

  // Byggd SPA i produktion.
  if (config.staticDir && existsSync(config.staticDir)) {
    const dir = resolve(config.staticDir);
    app.use(express.static(dir));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(resolve(dir, 'index.html')));
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) return res.status(err.status).json({ error: err.code, message: err.message });
    if (err instanceof SyntaxError) return res.status(400).json({ error: 'VALIDATION', message: 'Ogiltig JSON' });
    console.error(err);
    res.status(500).json({ error: 'INTERNAL', message: 'Något gick fel' });
  });

  return app;
}
