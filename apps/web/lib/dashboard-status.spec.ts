import { describe, expect, it } from 'vitest';
import {
  DOMAIN_PROBLEM_STATES,
  expiringSoon,
  formatDay,
  problemCount,
  sortAttention,
} from './dashboard-status';

const NOW = Date.parse('2026-11-20T00:00:00Z');
const day = (n: number) => new Date(NOW + n * 86_400_000).toISOString();

describe('dashboard status column logic', () => {
  it('counts active domains that expire within 30 days, not later ones, not past ones, not inactive ones', () => {
    expect(
      expiringSoon(
        [
          { state: 'active', expiresAt: day(10) },
          { state: 'active', expiresAt: day(30) },
          { state: 'active', expiresAt: day(31) },
          { state: 'active', expiresAt: day(-2) },
          { state: 'pending', expiresAt: day(5) },
          { state: 'active', expiresAt: null },
          { state: 'active' },
          { state: 'active', expiresAt: 'not a date' },
        ],
        NOW,
      ),
    ).toBe(2);
  });
  it('counts the items in a problem state', () => {
    expect(
      problemCount(
        [
          { state: 'active' },
          { state: 'expired' },
          { state: 'renewal_at_risk' },
          { state: 'pending' },
        ],
        DOMAIN_PROBLEM_STATES,
      ),
    ).toBe(2);
    expect(problemCount([], DOMAIN_PROBLEM_STATES)).toBe(0);
  });
  it('lists failures before warnings and keeps the order inside a group', () => {
    const items = [
      { id: 'a', tone: 'warn' as const, text: 'a', href: '/a' },
      { id: 'b', tone: 'bad' as const, text: 'b', href: '/b' },
      { id: 'c', tone: 'warn' as const, text: 'c', href: '/c' },
      { id: 'd', tone: 'bad' as const, text: 'd', href: '/d' },
    ];
    expect(sortAttention(items).map((i) => i.id)).toEqual(['b', 'd', 'a', 'c']);
    expect(items[0]!.id).toBe('a'); // the input is not changed
  });
  it('writes a day in the page language, in UTC', () => {
    expect(formatDay('2026-12-31T23:30:00Z', 'en')).toBe('31 Dec 2026');
    expect(formatDay('2026-12-31T23:30:00Z', 'ar')).toMatch(/2026/);
  });
});
