import { createEnv, type TestEnv } from '@nuzm/platform/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cursorTimeSql, decodeTimeCursor, encodeTimeCursor } from './pagination';

/**
 * Regression (2026-11-27, audit.int.spec "paginates with a stable cursor" failing on CI): a keyset cursor built from a JavaScript Date keeps
 * milliseconds while Postgres keeps microseconds, so a row in the same millisecond just past a page boundary was never listed. Rows are placed
 * by hand inside one millisecond so the case is deterministic.
 */
let env: TestEnv;
const ROWS = [
  { id: '00000000-0000-4000-8000-00000000000a', at: '2026-11-27T10:00:00.599100Z' },
  { id: '00000000-0000-4000-8000-00000000000b', at: '2026-11-27T10:00:00.598700Z' }, // page 1 ends here
  { id: '00000000-0000-4000-8000-00000000000c', at: '2026-11-27T10:00:00.598300Z' }, // same millisecond as b
  { id: '00000000-0000-4000-8000-00000000000d', at: '2026-11-27T10:00:00.597000Z' },
];

beforeAll(async () => {
  env = await createEnv();
  await env.sql(`CREATE SCHEMA IF NOT EXISTS cursor_test`);
  await env.sql(
    `CREATE TABLE cursor_test.events (id uuid PRIMARY KEY, occurred_at timestamptz NOT NULL)`,
  );
  for (const r of ROWS)
    await env.sql(`INSERT INTO cursor_test.events (id, occurred_at) VALUES ($1, $2)`, [r.id, r.at]);
});
afterAll(async () => {
  await env.sql(`DROP SCHEMA IF EXISTS cursor_test CASCADE`);
  await env.close();
});

/** The keyset query every time-ordered list uses, 2 rows per page. */
async function page(cursor: string | null) {
  const cur = decodeTimeCursor(cursor);
  return env.sql(
    `SELECT id, occurred_at, ${cursorTimeSql('occurred_at')} AS cursor_t FROM cursor_test.events
      WHERE ($1::timestamptz IS NULL OR (occurred_at, id) < ($1::timestamptz, $2::uuid))
      ORDER BY occurred_at DESC, id DESC LIMIT 2`,
    [cur?.t ?? null, cur?.id ?? null],
  );
}

describe('time keyset cursor', () => {
  it('walks every row when two rows share a millisecond across a page break', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 5; i++) {
      const rows = await page(cursor);
      seen.push(...rows.map((r) => r.id as string));
      if (rows.length < 2) break;
      const last = rows[rows.length - 1]!;
      cursor = encodeTimeCursor(last.cursor_t as string, last.id as string);
    }
    expect(seen).toEqual(ROWS.map((r) => r.id));
  });

  it('keeps the microseconds in the cursor (the old Date-based cursor dropped them, and with them row c)', async () => {
    const [, b] = await page(null);
    expect(b!.cursor_t).toBe('2026-11-27T10:00:00.598700Z');
    const old = Buffer.from(`${(b!.occurred_at as Date).toISOString()}|${b!.id}`).toString(
      'base64url',
    );
    expect((await page(old)).map((r) => r.id)).toEqual([ROWS[3]!.id]); // c is skipped: the bug
    const fixed = encodeTimeCursor(b!.cursor_t as string, b!.id as string);
    expect((await page(fixed)).map((r) => r.id)).toEqual([ROWS[2]!.id, ROWS[3]!.id]);
  });

  it('accepts cursors issued before the fix (millisecond times) and refuses malformed ones', () => {
    const id = ROWS[0]!.id;
    expect(decodeTimeCursor(encodeTimeCursor('2026-11-27T10:00:00.598Z', id))).toEqual({
      t: '2026-11-27T10:00:00.598Z',
      id,
    });
    for (const bad of ['yesterday', '2026-11-27 10:00:00', '2026-11-27T10:00:00.1234567Z'])
      expect(decodeTimeCursor(encodeTimeCursor(bad, id))).toBeNull();
    expect(decodeTimeCursor('')).toBeNull();
  });
});
