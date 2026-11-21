import { describe, expect, it } from 'vitest';
import {
  DocsFeedbackService,
  docsFeedbackConfigFromEnv,
  type DocsFeedbackConfig,
} from './docs-feedback.service';

const cfg: DocsFeedbackConfig = {
  enabled: true,
  salt: 'test-salt-value',
  perClientPerHour: 3,
  perMinuteTotal: 100,
};

/** A recording stand-in for the database. */
function setup(over: Partial<DocsFeedbackConfig> = {}, start = new Date('2026-11-21T10:00:00Z')) {
  const queries: { sql: string; params: unknown[] }[] = [];
  let rows: { page: string; good: number; okay: number; bad: number }[] = [];
  let clock = start;
  const db = {
    withoutScope: async (
      fn: (c: { query: (s: string, p?: unknown[]) => Promise<{ rows: unknown[] }> }) => unknown,
    ) =>
      fn({
        query: async (sql: string, params: unknown[] = []) => {
          queries.push({ sql, params });
          return { rows: /GROUP BY page/.test(sql) ? rows : [] };
        },
      }),
  };
  const svc = new DocsFeedbackService(db as never, { ...cfg, ...over }, () => clock);
  return {
    svc,
    queries,
    setRows: (r: typeof rows) => (rows = r),
    advance: (ms: number) => (clock = new Date(clock.getTime() + ms)),
  };
}
const vote = (o: Record<string, unknown> = {}) => ({
  page: '/docs/guides/errors',
  score: 'good',
  locale: 'en',
  ip: '203.0.113.9',
  agent: 'Mozilla/5.0 test',
  ...o,
});

describe('docs feedback: recording a vote', () => {
  it('stores the page, score, language and a salted hash, and nothing that identifies the client', async () => {
    const { svc, queries } = setup();
    await svc.record(vote());
    expect(queries).toHaveLength(1);
    const [, page, locale, score, hash, day] = queries[0]!.params as string[];
    expect([page, locale, score, day]).toEqual(['/docs/guides/errors', 'en', 'good', '2026-11-21']);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const everything = JSON.stringify(queries);
    expect(everything).not.toContain('203.0.113.9');
    expect(everything).not.toContain('Mozilla');
    expect(everything).not.toContain(cfg.salt);
  });

  it('is one row per page, client and day, and a repeat vote replaces the first (ON CONFLICT)', async () => {
    const { svc, queries } = setup();
    await svc.record(vote({ score: 'bad' }));
    await svc.record(vote({ score: 'good' }));
    expect(queries[0]!.sql).toMatch(/ON CONFLICT \(page, client_hash, day\) DO UPDATE SET score/);
    expect(queries[0]!.params[4]).toBe(queries[1]!.params[4]); // same client, same day, same hash
  });

  it('the hash cannot be followed from one day to the next, nor across clients', async () => {
    const { svc, queries, advance } = setup();
    await svc.record(vote());
    advance(24 * 3_600_000);
    await svc.record(vote());
    await svc.record(vote({ ip: '203.0.113.10' }));
    const hashes = queries.map((q) => q.params[4]);
    expect(new Set(hashes).size).toBe(3);
  });

  it.each([
    ['an unknown page', { page: '/console/billing' }],
    ['a page with a query', { page: '/docs?x=1' }],
    ['a page that tries to climb', { page: '/docs/guides/../admin' }],
    ['arbitrary text as the page', { page: 'hello world' }],
    ['a missing page', { page: undefined }],
    ['an unknown score', { score: 'great' }],
    ['a missing score', { score: undefined }],
    ['an unknown language', { locale: 'fr' }],
  ])('refuses %s with 422 and stores nothing', async (_n, o) => {
    const { svc, queries } = setup();
    await expect(svc.record(vote(o))).rejects.toMatchObject({ code: 'validation_failed' });
    expect(queries).toHaveLength(0);
  });

  it('limits one client per hour, then lets it vote again after the hour', async () => {
    const { svc, advance } = setup();
    for (let i = 0; i < 3; i++) await svc.record(vote());
    await expect(svc.record(vote())).rejects.toMatchObject({ code: 'rate_limited' });
    await svc.record(vote({ ip: '198.51.100.7' })); // another client is not affected
    advance(3_600_001);
    await svc.record(vote());
  });

  it('limits all votes together', async () => {
    const { svc } = setup({ perMinuteTotal: 2 });
    await svc.record(vote({ ip: '1.1.1.1' }));
    await svc.record(vote({ ip: '1.1.1.2' }));
    await expect(svc.record(vote({ ip: '1.1.1.3' }))).rejects.toMatchObject({
      code: 'rate_limited',
    });
  });

  it('answers 404 and stores nothing while collection is off', async () => {
    const { svc, queries } = setup({ enabled: false });
    await expect(svc.record(vote())).rejects.toMatchObject({ code: 'not_found' });
    expect(queries).toHaveLength(0);
  });
});

describe('docs feedback: configuration', () => {
  it('is on by default outside production and off in production until switched on with a salt', () => {
    expect(docsFeedbackConfigFromEnv({ NODE_ENV: 'development' } as never).enabled).toBe(true);
    expect(
      docsFeedbackConfigFromEnv({
        NODE_ENV: 'development',
        DOCS_FEEDBACK_ENABLED: 'false',
      } as never).enabled,
    ).toBe(false);
    expect(docsFeedbackConfigFromEnv({ NODE_ENV: 'production' } as never).enabled).toBe(false);
    expect(
      docsFeedbackConfigFromEnv({ NODE_ENV: 'production', DOCS_FEEDBACK_ENABLED: 'true' } as never)
        .enabled,
    ).toBe(false); // no salt
    expect(
      docsFeedbackConfigFromEnv({
        NODE_ENV: 'production',
        DOCS_FEEDBACK_ENABLED: 'true',
        DOCS_FEEDBACK_SALT: 'x'.repeat(20),
      } as never).enabled,
    ).toBe(true);
  });
});

describe('docs feedback: the staff summary', () => {
  it('adds the votes up per page and in total, most voted first', async () => {
    const { svc, setRows } = setup();
    setRows([
      { page: '/docs/guides/errors', good: 1, okay: 0, bad: 3 },
      { page: '/docs', good: 5, okay: 2, bad: 0 },
    ]);
    const r = await svc.summary(undefined);
    expect(r.days).toBe(30);
    expect(r.items.map((i) => [i.page, i.total])).toEqual([
      ['/docs', 7],
      ['/docs/guides/errors', 4],
    ]);
    expect(r.totals).toEqual({ good: 6, okay: 2, bad: 3, total: 11 });
  });

  it.each(['0', '366', '1.5', 'abc'])('refuses days=%s', async (d) => {
    const { svc } = setup();
    await expect(svc.summary(d)).rejects.toMatchObject({ code: 'validation_failed' });
  });
});
