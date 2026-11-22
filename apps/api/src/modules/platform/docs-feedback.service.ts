import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Db } from '@nuzm/platform';
import { ProblemException } from '../../common/errors';
import { SlidingWindowLimiter } from '../../common/rate-limit';

/** The addresses of the public documentation a rating can be about (`/docs`, `/docs/guides/<slug>`, `/docs/reference/<area>`). */
export const DOCS_FEEDBACK_PAGE = /^\/docs(\/(guides|reference)\/[a-z0-9-]{1,60})?$/;
export const DOCS_FEEDBACK_SCORES = ['good', 'okay', 'bad'] as const;
export type DocsFeedbackScore = (typeof DOCS_FEEDBACK_SCORES)[number];

export interface DocsFeedbackConfig {
  enabled: boolean;
  /** secret that makes the client hash unguessable from an address alone */
  salt: string;
  perClientPerHour: number;
  perMinuteTotal: number;
}

/**
 * Collection is OFF in production until it is switched on (`DOCS_FEEDBACK_ENABLED=true` and a `DOCS_FEEDBACK_SALT`), on by default elsewhere. A missing salt in
 * production keeps it off: a guessable hash would make the stored votes linkable to an address.
 */
export function docsFeedbackConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): DocsFeedbackConfig {
  const prod = env.NODE_ENV === 'production';
  const salt = env.DOCS_FEEDBACK_SALT ?? (prod ? '' : randomBytes(16).toString('hex'));
  const enabled = prod
    ? env.DOCS_FEEDBACK_ENABLED === 'true'
    : env.DOCS_FEEDBACK_ENABLED !== 'false';
  return {
    enabled: enabled && salt !== '',
    salt,
    perClientPerHour: Number(env.DOCS_FEEDBACK_PER_CLIENT_PER_HOUR ?? 30),
    perMinuteTotal: Number(env.DOCS_FEEDBACK_PER_MINUTE_TOTAL ?? 600),
  };
}

export interface DocsFeedbackSummary {
  days: number;
  totals: { good: number; okay: number; bad: number; total: number };
  items: { page: string; good: number; okay: number; bad: number; total: number }[];
}

/**
 * Anonymous "Was this helpful?" ratings from the public documentation. Nothing identifying is stored: the client hash is SHA-256 over a secret salt, the client
 * address, the agent and the UTC day, so a vote cannot be traced back or followed from one day to the next. One row per page, client and day: a second vote the
 * same day replaces the first (so a retry or a change of mind never double counts). Abuse is limited per client and overall (in memory: NOT VERIFIED for
 * several API instances, like the sign-in limiter).
 */
export class DocsFeedbackService {
  constructor(
    private readonly db: Db,
    private readonly cfg: DocsFeedbackConfig,
    private readonly now: () => Date = () => new Date(),
    private readonly limiter = new SlidingWindowLimiter(),
  ) {}

  clientHash(ip: string, agent: string, day: string): string {
    return createHash('sha256').update(`${this.cfg.salt}|${ip}|${agent}|${day}`).digest('hex');
  }

  async record(input: {
    page: unknown;
    score: unknown;
    locale: unknown;
    ip: string;
    agent: string;
  }): Promise<void> {
    if (!this.cfg.enabled) throw new ProblemException('not_found');
    const { page, score, locale } = input;
    if (typeof page !== 'string' || !DOCS_FEEDBACK_PAGE.test(page))
      throw new ProblemException('validation_failed', 'page must be a documentation address');
    if (!DOCS_FEEDBACK_SCORES.includes(score as DocsFeedbackScore))
      throw new ProblemException('validation_failed', 'score must be good, okay or bad');
    if (locale !== 'ar' && locale !== 'en')
      throw new ProblemException('validation_failed', 'locale must be ar or en');
    const at = this.now();
    const day = at.toISOString().slice(0, 10);
    const hash = this.clientHash(input.ip, input.agent.slice(0, 300), day);
    const t = at.getTime();
    if (
      !this.limiter.allow('docs-feedback:all', this.cfg.perMinuteTotal, 60_000, t) ||
      !this.limiter.allow(`docs-feedback:${hash}`, this.cfg.perClientPerHour, 3_600_000, t)
    )
      throw new ProblemException('rate_limited');
    await this.db.withoutScope(async (c) => {
      await c.query(
        `INSERT INTO platform.docs_feedback (id, page, locale, score, client_hash, day)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (page, client_hash, day) DO UPDATE SET score = EXCLUDED.score, locale = EXCLUDED.locale, updated_at = now()`,
        [randomUUID(), page, locale, score, hash, day],
      );
    });
  }

  /** Votes per page over the last `days` days (1..365), most voted first. */
  async summary(daysInput: unknown): Promise<DocsFeedbackSummary> {
    const n = daysInput === undefined || daysInput === '' ? 30 : Number(daysInput);
    if (!Number.isInteger(n) || n < 1 || n > 365)
      throw new ProblemException('validation_failed', 'days must be a whole number from 1 to 365');
    const rows = await this.db.withoutScope(
      async (c) =>
        (
          await c.query(
            `SELECT page,
                    count(*) FILTER (WHERE score = 'good')::int AS good,
                    count(*) FILTER (WHERE score = 'okay')::int AS okay,
                    count(*) FILTER (WHERE score = 'bad')::int AS bad
               FROM platform.docs_feedback
              WHERE day > (now() AT TIME ZONE 'utc')::date - $1::int
              GROUP BY page`,
            [n],
          )
        ).rows as { page: string; good: number; okay: number; bad: number }[],
    );
    const items = rows
      .map((r) => ({ ...r, total: r.good + r.okay + r.bad }))
      .sort((a, b) => b.total - a.total || a.page.localeCompare(b.page));
    const totals = items.reduce(
      (t, r) => ({
        good: t.good + r.good,
        okay: t.okay + r.okay,
        bad: t.bad + r.bad,
        total: t.total + r.total,
      }),
      { good: 0, okay: 0, bad: 0, total: 0 },
    );
    return { days: n, totals, items };
  }
}
