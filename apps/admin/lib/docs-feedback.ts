/** The ratings page: how the votes of one documentation page read at a glance. */
export interface Votes {
  good: number;
  okay: number;
  bad: number;
  total: number;
}

/** Share of votes that said "helpful", as a whole percent; null when there are no votes (never 0%, which would read as "everyone said no"). */
export function helpfulShare(v: Votes): number | null {
  return v.total > 0 ? Math.round((v.good / v.total) * 100) : null;
}

/** The ranges offered on the page (days); anything else in the address falls back to 30. */
export const RANGES = [7, 30, 90] as const;
export const rangeOf = (raw: string | undefined): (typeof RANGES)[number] => {
  const n = Number(raw);
  return (RANGES as readonly number[]).includes(n) ? (n as (typeof RANGES)[number]) : 30;
};
