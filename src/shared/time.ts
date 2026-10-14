// Tid och tidszon (avsnitt 1.4 / BR-12): lagring i UTC, regler och visning i Europe/Stockholm.

export const TIME_ZONE = 'Europe/Stockholm';

const partsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function localParts(date: Date): LocalParts {
  const p: Record<string, number> = {};
  for (const part of partsFormatter.formatToParts(date)) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  return { year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute, second: p.second };
}

/** Skillnaden mellan lokal väggklocka och UTC vid en viss tidpunkt, i millisekunder. */
function offsetMs(date: Date): number {
  const p = localParts(date);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Sant om strängen är ett giltigt kalenderdatum på formen YYYY-MM-DD (t.ex. inte 2026-02-30). */
export function isValidDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** Lokalt datum (YYYY-MM-DD) och tid (HH:mm eller HH:mm:ss) i Europe/Stockholm till UTC ISO-sträng. */
export function localToUtc(date: string, time: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm, ss = 0] = time.split(':').map(Number);
  const wall = Date.UTC(y, m - 1, d, hh, mm, ss);
  // Två iterationer hanterar övergången till och från sommartid.
  let ts = wall - offsetMs(new Date(wall));
  ts = wall - offsetMs(new Date(ts));
  return new Date(ts).toISOString().replace('.000Z', 'Z');
}

/** UTC ISO-sträng till lokalt datum och tid i Europe/Stockholm. */
export function utcToLocal(iso: string): { date: string; time: string } {
  const p = localParts(new Date(iso));
  return {
    date: `${p.year}-${pad(p.month)}-${pad(p.day)}`,
    time: `${pad(p.hour)}:${pad(p.minute)}`,
  };
}

/** Lägg till kalenderdagar räknat i Europe/Stockholm (behåller lokal väggklocka över sommartidsskifte). */
export function addLocalDays(iso: string, days: number): string {
  const p = localParts(new Date(iso));
  const shifted = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  const date = `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
  return localToUtc(date, `${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`);
}

export function addHours(iso: string, hours: number): string {
  return new Date(new Date(iso).getTime() + hours * 3_600_000).toISOString().replace('.000Z', 'Z');
}

const displayFormatter = new Intl.DateTimeFormat('sv-SE', {
  timeZone: TIME_ZONE,
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

const timeFormatter = new Intl.DateTimeFormat('sv-SE', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit' });

/** T.ex. "lör 24 okt. 10:00" */
export function formatDateTime(iso: string): string {
  return displayFormatter.format(new Date(iso));
}

/** T.ex. "lör 24 okt. 10:00–11:30" */
export function formatSlot(startIso: string, endIso: string): string {
  return `${formatDateTime(startIso)}–${timeFormatter.format(new Date(endIso))}`;
}

/** Lokalt kalenderdatum (YYYY-MM-DD) plus ett antal dagar. */
export function addDaysToDate(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/** Antal kalenderdagar från `from` till `to` (båda YYYY-MM-DD). */
export function daysBetweenDates(from: string, to: string): number {
  const toUtc = (s: string) => {
    const [y, m, d] = s.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toUtc(to) - toUtc(from)) / 86_400_000);
}

/** BR-01: lördag eller söndag. */
export function isWeekendDate(date: string): boolean {
  const [y, m, d] = date.split('-').map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return day === 0 || day === 6;
}

export function addMinutes(iso: string, minutes: number): string {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString().replace('.000Z', 'Z');
}
