import { describe, expect, it } from 'vitest';
import { isCompatible, medianLevel, totalScore } from './rules.js';
import { addLocalDays, localToUtc } from './time.js';

describe('BR-09 matchkompatibilitet', () => {
  const match = { birthYear: 2015, category: 'BOYS' as const, openToAdjacentBirthYears: false };
  it('kräver samma kategori och födelseår', () => {
    expect(isCompatible(match, { birthYear: 2015, category: 'BOYS' })).toBe(true);
    expect(isCompatible(match, { birthYear: 2015, category: 'MIXED' })).toBe(false);
    expect(isCompatible(match, { birthYear: 2016, category: 'BOYS' })).toBe(false);
  });
  it('tillåter ±1 år om matchen är öppen för det', () => {
    const open = { ...match, openToAdjacentBirthYears: true };
    expect(isCompatible(open, { birthYear: 2014, category: 'BOYS' })).toBe(true);
    expect(isCompatible(open, { birthYear: 2016, category: 'BOYS' })).toBe(true);
    expect(isCompatible(open, { birthYear: 2017, category: 'BOYS' })).toBe(false);
  });
});

describe('BR-13 median', () => {
  it('udda N ger mittvärdet', () => {
    expect(medianLevel(['HARD', 'EASY', 'MEDIUM'])).toBe('MEDIUM');
  });
  it('jämnt N ger det lägre mittvärdet', () => {
    expect(medianLevel(['EASY', 'MEDIUM', 'HARD', 'HARD_PLUS'])).toBe('MEDIUM');
  });
});

describe('AC-301.3 totalbetyg', () => {
  it('räknar inte med "ej tillämpligt"', () => {
    expect(totalScore(3, 2, 'NOT_APPLICABLE')).toBe(2.5);
    expect(totalScore(3, 3, 1)).toBeCloseTo(7 / 3);
  });
});

describe('Tidszon (1.4)', () => {
  it('följer specens exempel', () => {
    expect(localToUtc('2026-10-24', '10:00')).toBe('2026-10-24T08:00:00Z');
    expect(localToUtc('2026-10-10', '23:59:59')).toBe('2026-10-10T21:59:59Z');
  });
  it('lägger till lokala dagar över sommartidsskifte', () => {
    expect(addLocalDays('2026-10-20T10:00:00Z', 7)).toBe('2026-10-27T11:00:00Z');
  });
});
