import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setupAiEnv, type AiEnv } from '../modules/ai/testing/ai-harness';

/**
 * Session 07 (QA), Phase 2 - credential custody, dynamic: a provider API key typed into the admin console is sealed in the secret store and must appear NOWHERE else:
 * not in any response, not in any audit row (real hash-chained sink), not in any table of the database (every schema, every column of every row), not in what the
 * process writes to stdout/stderr, not in an error body. Throw-away TEST-ONLY marker values (never a real key); the connection test is never called (it would reach the
 * network): this suite makes no provider call. Own Postgres, in-process server.
 */
let e: AiEnv;
const act = (body: object) => e.admin('padmin', 'POST', '/v1/admin/ai/model-providers', body);
const out: string[] = [];

/** every table of every application schema, every row as text: the marker must be in none of them */
async function occurrences(...markers: string[]): Promise<{ table: string; n: number }[]> {
  const tables = (await e.sql(
    `SELECT table_schema s, table_name t FROM information_schema.tables
      WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema')`,
  )) as { s: string; t: string }[];
  const hits: { table: string; n: number }[] = [];
  for (const { s, t } of tables) {
    const n = Number(
      (
        await e.sql(`SELECT count(*) n FROM "${s}"."${t}" x WHERE x::text ~ $1`, [
          markers.map((m) => m.replace(/[^A-Za-z0-9 -]/g, '.')).join('|'),
        ])
      )[0]!.n,
    );
    if (n > 0) hits.push({ table: `${s}.${t}`, n });
  }
  return hits;
}

beforeAll(async () => {
  e = await setupAiEnv({ realAudit: true });
}, 180_000);
afterAll(() => e.h.close());

describe('QA credential custody: a provider key typed in the console', () => {
  const k1 = `test-only-${'Qz7m'.repeat(8)}`;
  const k2 = `test-only-${'Rw3n'.repeat(8)}`;
  const k3 = `test-only-${'Tv9p'.repeat(8)}`;
  let seen: string;

  it('is accepted by save_claude_key and set_credential, rotated and cleared, and every response carries the vault reference only', async () => {
    const spies = [
      vi
        .spyOn(process.stdout, 'write')
        .mockImplementation(((c: unknown) => (out.push(String(c)), true)) as never),
      vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(((c: unknown) => (out.push(String(c)), true)) as never),
    ];
    const bodies: string[] = [];
    try {
      const first = await act({ action: 'save_claude_key', apiKey: k1 });
      expect(first.statusCode, first.body).toBe(200);
      bodies.push(first.body);
      const rotated = await act({ action: 'save_claude_key', apiKey: k2 });
      expect(rotated.statusCode).toBe(200);
      bodies.push(rotated.body);
      const made = await act({
        action: 'configure',
        code: 'qa-cred',
        adapter: 'acme',
        displayName: 'QA Cred',
        region: 'sa-central',
      });
      bodies.push(made.body);
      const set = await act({ action: 'set_credential', id: made.json().id, apiKey: k3 });
      expect(set.statusCode, set.body).toBe(200);
      bodies.push(set.body);
      for (const bad of [
        { apiKey: 'short' },
        { apiKey: 'has a space inside the key value here' },
        { apiKey: 12345 },
        {},
      ]) {
        const r = await act({ action: 'set_credential', id: made.json().id, ...bad });
        expect(r.statusCode).toBe(422);
        bodies.push(r.body);
      }
      // a value sent in the WRONG place (configure with an apiKey) is refused and not echoed
      const wrong = await act({
        action: 'configure',
        code: 'qa-cred2',
        adapter: 'acme',
        displayName: 'x',
        region: 'sa-central',
        apiKey: k3,
      });
      expect(wrong.statusCode).toBe(422);
      bodies.push(wrong.body);
      // the list, the admin audit view and the organization audit view
      bodies.push((await e.admin('padmin', 'GET', '/v1/admin/ai/model-providers')).body);
      bodies.push((await e.admin('padmin', 'GET', '/v1/admin/audit-logs')).body);
      bodies.push((await e.call('alice', 'GET', '/v1/audit-logs', undefined, e.org.A!)).body);
      const cleared = await act({ action: 'clear_credential', id: made.json().id });
      expect(cleared.json().vaultRef).toBeNull();
      bodies.push(cleared.body);
    } finally {
      for (const s of spies) s.mockRestore();
    }
    seen = bodies.join('\n');
    for (const k of [k1, k2, k3])
      expect(seen, `marker ${k.slice(0, 16)}… in a response`).not.toContain(k);
    expect(seen).toMatch(/vault:\/\/(dev|mem)\/ai-claude/);
  });

  it('is in no process output (stdout/stderr) while it is handled', () => {
    const text = out.join('');
    for (const k of [k1, k2, k3]) expect(text).not.toContain(k);
  });

  it(
    'is in no table of the database: not as a column value, not in the audit chain, the outbox, the idempotency records or the operations',
    { timeout: 300_000 },
    async () => {
      expect(await occurrences(k1, k2, k3), 'tables holding a key').toEqual([]);
      // the audit trail exists and records WHO changed the credential (so the check above is not vacuous)
      const audited = await e.sql(
        `SELECT action, actor_type FROM audit.audit_logs WHERE action LIKE 'ai.provider.%' OR action LIKE 'ai.model_provider.%' ORDER BY occurred_at`,
      );
      expect(
        audited.length,
        JSON.stringify(
          await e.sql(`SELECT DISTINCT action FROM audit.audit_logs WHERE action LIKE 'ai.%'`),
        ),
      ).toBeGreaterThan(0);
    },
  );

  it('a request that fails validation leaves no half-made provider and no audit row carrying the value', async () => {
    const before = Number((await e.sql(`SELECT count(*) n FROM ai.model_providers`))[0]!.n);
    const r = await act({
      action: 'save_claude_key',
      apiKey: 'has a space inside the key value here',
    });
    expect(r.statusCode).toBe(422);
    expect(Number((await e.sql(`SELECT count(*) n FROM ai.model_providers`))[0]!.n)).toBe(before);
    expect(await occurrences('has a space inside the key value here')).toEqual([]);
  });

  it('only a platform administrator with the permission can set or clear a credential: org users, viewers and a platform role without the permission are refused and nothing is stored', async () => {
    const mark = `test-only-${'Uy2k'.repeat(8)}`;
    const id = (
      await act({
        action: 'configure',
        code: 'qa-cred3',
        adapter: 'acme',
        displayName: 'x',
        region: 'sa-central',
      })
    ).json().id as string;
    for (const who of ['alice', 'carol', 'dave']) {
      const r = await e.call(
        who,
        'POST',
        '/v1/admin/ai/model-providers',
        { action: 'set_credential', id, apiKey: mark },
        e.org.A!,
      );
      expect(r.statusCode, who).toBeGreaterThanOrEqual(401);
      expect(r.body).not.toContain(mark);
    }
    expect(await occurrences(mark)).toEqual([]);
  });
});
