# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Matchbörsen & Planbokning: a web app for IFK Lidingö's practice matches, built from the requirements spec in [docs/kravspecifikation-v1.1.1.md](docs/kravspecifikation-v1.1.1.md). Both tracks are implemented: **Spår 1** (home team requests a weekend slot, the office allocates a pitch in Process B, then the match is published) and **Spår 2** (home team already has its own training slot and publishes straight to the market). [README.md](README.md) has the requirement traceability table and a list of spec interpretations that are still open for review. Read it before changing domain behaviour.

The codebase, UI text, comments and error messages are in **Swedish**. Code comments cite spec IDs (`BR-16`, `AC-103.4`, `A7`, `FR-A-104`, `NFR-05`, …). Keep that convention so changes stay traceable to the spec. [docs/erd.md](docs/erd.md) has a Mermaid ER diagram of the schema, and [docs/arbetsfloden.html](docs/arbetsfloden.html) shows the three processes as case lifecycles (stages, steps, statuses, spec IDs and the events between processes). Update both when the schema or a workflow changes.

## Commands

Requires Node ≥ 22.13 (uses built-in `node:sqlite`, no native deps).

```bash
npm run dev          # API (tsx watch) on :3000 + Vite on :5173, proxied via /api/
npm test             # vitest run (all src/**/*.test.ts)
npx vitest run src/shared/rules.test.ts      # single file
npx vitest run -t "AC-101.3"                 # tests whose name matches
npm run typecheck    # tsc --noEmit
npm run seed         # wipe and re-seed data/matchborsen.db
npm run build && npm start   # production: API server serves dist/web
```

`npm start` uses `NODE_ENV=production tsx …` (POSIX env syntax), which won't work from PowerShell. Use Git Bash or set `$env:NODE_ENV` first.

In dev, the DB is created and seeded automatically on first start. Log in via "Logga in → Testanvändare" (seed users are listed in the README). The `/dev` page has a **time machine** that advances the server clock and runs the scheduler, plus views of the email outbox, outbox events and audit log. Dev tools are off when `NODE_ENV=production` unless `ENABLE_DEV_TOOLS=true`. Env vars are in [.env.example](.env.example).

## Architecture

- `src/shared/`: pure code used by both server and client (domain types, pure business rules in `rules.ts`, UTC ↔ `Europe/Stockholm` time handling in `time.ts`, Swedish labels).
- `src/server/`: Express 5 REST API (`app.ts`) on top of domain modules in `modules/` (identity, masterdata, matches = Process A, reservations = Process B, fairplay = Process C). Infrastructure lives in `infra/`.
- `src/web/`: React 19 SPA (Vite root is `src/web`). It imports only **types** from the server (e.g. `MatchCard` from `server/modules/matches`). Never import runtime server code into the client.

### Service pattern

Every domain function has the signature `fn(ctx: Ctx, user: User, ...args)`, where `Ctx = { db, clock }` ([context.ts](src/server/context.ts)). Always read the time from `ctx.clock.nowIso()` / `ctx.clock.now()`, never from `Date.now()`. The time machine and the tests' `FixedClock` depend on this.

Errors are thrown as `AppError` via the helpers in [infra/errors.ts](src/server/infra/errors.ts) (`badRequest`, `forbidden`, `notFound`, `conflict`), and `app.ts` maps them to HTTP status codes and JSON `{ error, message }`. The client's `ApiError` shows the server's Swedish message.

### Transactions, state transitions and the outbox (the key invariants)

- Wrap mutating operations in `tx(ctx.db, () => …)` ([infra/db.ts](src/server/infra/db.ts)). Nested `tx` calls join the outer transaction, and any throw rolls everything back. Transactions use `BEGIN IMMEDIATE`.
- **BR-16:** status changes go through helpers like `transitionMatch` / `transitionInquiry` in [modules/matches.ts](src/server/modules/matches.ts). They run `UPDATE … WHERE id = ? AND status = <expected>` and throw `conflict` if no row changed. They also write the audit-log row (NFR-05, append-only, enforced by DB triggers). Don't write raw status `UPDATE`s that skip this.
- **Internal outbox (spec §4.0):** cross-process communication uses `emit(ctx, eventType, matchId, payload)` from [infra/outbox.ts](src/server/infra/outbox.ts), inside the same transaction as the state change. `sequence` increases strictly per `matchId`. The `Dispatcher` delivers in order per match and consumer, with idempotency through `processed_events(consumer, event_id)`. Routing is in `routeTargets`. Consumers are registered in `createDispatcher()` in [runtime.ts](src/server/runtime.ts): `matches.onEvent` (Process A), `reservations.onEvent` (Process B) and Process C. Processes A and B never call each other's write functions; they only exchange events. Events that no longer fit the receiver's state are ignored and logged in `audit_log` as `IGNORED …`.
- **Email** is queued with `queueEmail(s)` in the same transaction and delivered by the `Runtime` (flush every 5 s, urgent first). `ConsoleEmailSender` only logs.
- **Timers:** `Runtime.tick()` (every 30 s) flushes the outbox, then runs `runMatchTimers` (expiry at start time, completion reminders), `runReservationDeadlines` (14-day rule, 18-day reminder) and `runReviewDeadlines` (Fair Play deadlines). `app.ts` also flushes the outbox and email after every mutating request.

### Time

Everything is stored as UTC ISO strings (no milliseconds). Local dates and times entered by users are interpreted in `Europe/Stockholm`, DST-aware, through `shared/time.ts`. "48 h" means real elapsed hours. "7 days" means local calendar days.

### Database

SQLite through `node:sqlite`. The schema is the `SCHEMA` string in `infra/db.ts`, applied with `CREATE TABLE IF NOT EXISTS`. There is no migration system, so after a schema change, run `npm run seed` to recreate the dev DB. Use the `one` / `all` / `run` helpers with positional `?` params. IDs come from `newId(prefix)`.

### Tests

The domain tests ([track1.test.ts](src/server/__tests__/track1.test.ts), [track2.test.ts](src/server/__tests__/track2.test.ts)) build a fresh `openDb(':memory:')` plus a `FixedClock` in `beforeEach`. They call the module functions directly (not over HTTP), drive the outbox with `createDispatcher().dispatch(ctx)`, and assert on `audit_log` / outbox rows. `describe` names reference spec IDs. Follow the same pattern for new behaviour.
