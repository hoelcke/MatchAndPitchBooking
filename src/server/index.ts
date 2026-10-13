import { openDb } from './infra/db.js';
import { Clock } from './infra/clock.js';
import { ConsoleEmailSender } from './infra/email.js';
import { createApp } from './app.js';
import { createDispatcher, Runtime } from './runtime.js';
import { seedIfEmpty } from './seed.js';

const isProd = process.env.NODE_ENV === 'production';
const list = (v?: string) => (v ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const ctx = { db: openDb(process.env.DATABASE_PATH ?? 'data/matchborsen.db'), clock: new Clock() };
const devTools = process.env.ENABLE_DEV_TOOLS ? process.env.ENABLE_DEV_TOOLS === 'true' : !isProd;

if (devTools) seedIfEmpty(ctx);

const runtime = new Runtime(ctx, createDispatcher(), new ConsoleEmailSender());
const app = createApp(ctx, runtime, {
  googleClientId: process.env.GOOGLE_CLIENT_ID || undefined,
  officeEmails: list(process.env.OFFICE_EMAILS),
  adminEmails: list(process.env.ADMIN_EMAILS),
  devTools,
  secureCookies: isProd,
  staticDir: 'dist/web',
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`Matchbörsen API på http://localhost:${port} (dev-verktyg: ${devTools ? 'på' : 'av'})`);
  runtime.start();
  void runtime.tick();
});
