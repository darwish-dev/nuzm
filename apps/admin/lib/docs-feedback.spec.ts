import { describe, expect, it } from 'vitest';
import { helpfulShare, rangeOf } from './docs-feedback';

describe('documentation ratings page', () => {
  it('reads the helpful share, and nothing when nobody voted', () => {
    expect(helpfulShare({ good: 3, okay: 1, bad: 0, total: 4 })).toBe(75);
    expect(helpfulShare({ good: 0, okay: 0, bad: 2, total: 2 })).toBe(0);
    expect(helpfulShare({ good: 0, okay: 0, bad: 0, total: 0 })).toBeNull();
  });
  it('accepts only the offered ranges', () => {
    expect(rangeOf('7')).toBe(7);
    expect(rangeOf('90')).toBe(90);
    expect(rangeOf('365')).toBe(30);
    expect(rangeOf(undefined)).toBe(30);
    expect(rangeOf('abc')).toBe(30);
  });
});
