// Rena affärsregler som delas av server och klient.
import { LEVELS, type Level, type TeamCategory } from './types.js';

export const HOME_CLUB_NAME = 'IFK Lidingö';

/** BR-09: samma kategori, och samma födelseår eller ±1 år om matchen är öppen för det. */
export function isCompatible(
  match: { birthYear: number; category: TeamCategory; openToAdjacentBirthYears: boolean },
  team: { birthYear: number; category: TeamCategory },
): boolean {
  if (match.category !== team.category) return false;
  const diff = Math.abs(match.birthYear - team.birthYear);
  return diff === 0 || (match.openToAdjacentBirthYears && diff === 1);
}

export function levelToNumber(level: Level): number {
  return LEVELS.indexOf(level) + 1;
}

export function numberToLevel(n: number): Level {
  return LEVELS[n - 1];
}

/**
 * BR-13: median av bedömd nivå. Sortera stigande och välj element (N+1)/2 vid udda N
 * och N/2 vid jämnt N (det lägre mittvärdet, räknat från 1).
 */
export function medianLevel(levels: Level[]): Level | undefined {
  if (levels.length === 0) return undefined;
  const sorted = levels.map(levelToNumber).sort((a, b) => a - b);
  const n = sorted.length;
  const position = n % 2 === 1 ? (n + 1) / 2 : n / 2;
  return numberToLevel(sorted[position - 1]);
}

/** AC-301.3: totalbetyg = genomsnitt av delbetygen; "ej tillämpligt" räknas inte med. */
export function totalScore(players: number, leaders: number, spectators: number | 'NOT_APPLICABLE'): number {
  const scores = spectators === 'NOT_APPLICABLE' ? [players, leaders] : [players, leaders, spectators];
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

export const PROFILE_WINDOW = 10;
export const PROFILE_MIN_REVIEWS = 3;

/** BR-13: genomsnitt utan avrundning, visas och skickas med en decimal. */
export function roundOneDecimal(n: number): number {
  return Math.round(n * 10) / 10;
}
