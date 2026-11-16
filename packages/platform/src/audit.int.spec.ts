import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditIntegrity, HmacCheckpointSigner, PLATFORM_CHAIN } from './audit';
import { ORG_A, ORG_B, createEnv, type TestEnv } from './testing/harness';

let env: TestEnv;
let integrity: AuditIntegrity;
const signer = new HmacCheckpointSigner(new Uint8Array(randomBytes(32)));

const insert = (
  e: TestEnv,
  org: string | null,
  action = 'test.thing.done',
  extra: Record<string, unknown> = {},
) =>
  (org ? e.app.withOrg.bind(e.app, org) : e.app.withoutScope.bind(e.app))((c) =>
    c.query(
      `INSERT INTO audit.audit_logs (id, actor_type, actor_user_id, org_id, action, outcome, detail)
       VALUES (gen_random_uuid(), 'system', NULL, $1, $2, 'success', $3)`,
      [org, action, JSON.stringify(extra)],
    ),
  );
/** Admin connection with the append-only triggers disabled, to simulate a privileged DB-level attacker. */
const asAttacker = async (fn: () => Promise<unknown>) => {
  await env.sql('ALTER TABLE audit.audit_logs DISABLE TRIGGER audit_logs_no_update');
  try {
    await fn();
  } finally {
    await env.sql('ALTER TABLE audit.audit_logs ENABLE TRIGGER audit_logs_no_update');
  }
};

beforeAll(async () => {
  env = await createEnv();
  integrity = new AuditIntegrity(env.app, signer);
});
afterAll(() => env.close());

describe('audit hash chain (real PostgreSQL)', () => {
  it('links rows per chain with sequential numbers and an unbroken prev_hash', async () => {
    for (let i = 0; i < 5; i++) await insert(env, ORG_A, 'test.thing.done', { i });
    await insert(env, ORG_B);
    await insert(env, null);
    const rows = await env.sql(
      `SELECT chain_key, chain_seq::int seq, prev_hash, hash FROM audit.audit_logs WHERE org_id=$1 ORDER BY chain_seq`,
      [ORG_A],
    );
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(rows[0]!.prev_hash).toBe('0'.repeat(64));
    for (let i = 1; i < rows.length; i++) expect(rows[i]!.prev_hash).toBe(rows[i - 1]!.hash);
    expect(new Set(rows.map((r) => r.chain_key))).toEqual(new Set([ORG_A]));
    // independent chains: B and the platform chain start at 1
    expect(
      (await env.sql(`SELECT chain_seq::int s FROM audit.audit_logs WHERE org_id=$1`, [ORG_B]))[0]!
        .s,
    ).toBe(1);
    expect(
      (
        await env.sql(
          `SELECT chain_key, chain_seq::int s FROM audit.audit_logs WHERE org_id IS NULL`,
        )
      )[0],
    ).toEqual({ chain_key: PLATFORM_CHAIN, s: 1 });
    expect((await integrity.verifyChain(ORG_A)).ok).toBe(true);
  });

  it('serialises concurrent writers on one chain: no gaps, no forks', async () => {
    await Promise.all(
      Array.from({ length: 25 }, (_, i) => insert(env, ORG_B, 'test.race.done', { i })),
    );
    const seqs = (
      await env.sql(
        `SELECT chain_seq::int s FROM audit.audit_logs WHERE org_id=$1 ORDER BY chain_seq`,
        [ORG_B],
      )
    ).map((r) => r.s);
    expect(seqs).toEqual(Array.from({ length: 26 }, (_, i) => i + 1));
    const v = await integrity.verifyChain(ORG_B);
    expect(v).toMatchObject({ ok: true, checked: 26 });
  });

  it('ignores a caller-supplied hash, sequence and timestamp (the database assigns them)', async () => {
    await env.app.withOrg(ORG_A, (c) =>
      c.query(
        `INSERT INTO audit.audit_logs (id, chain_key, chain_seq, occurred_at, actor_type, org_id, action, outcome, prev_hash, hash)
         VALUES (gen_random_uuid(), gen_random_uuid(), 999, '2001-01-01', 'system', $1, 'test.forge.attempt', 'success', 'x', 'y')`,
        [ORG_A],
      ),
    );
    const r = (
      await env.sql(
        `SELECT chain_key, chain_seq::int s, occurred_at, hash FROM audit.audit_logs WHERE action='test.forge.attempt'`,
      )
    )[0]!;
    expect(r.chain_key).toBe(ORG_A);
    expect(r.s).toBe(6);
    expect(new Date(r.occurred_at as string).getFullYear()).toBeGreaterThan(2020);
    expect(r.hash).not.toBe('y');
    expect((await integrity.verifyChain(ORG_A)).ok).toBe(true);
  });

  it('is append-only: runtime roles and even the owner cannot UPDATE or DELETE', async () => {
    await expect(
      env.app.withOrg(ORG_A, (c) => c.query(`UPDATE audit.audit_logs SET action='test.x.y'`)),
    ).rejects.toThrow(/permission denied|append-only/);
    await expect(
      env.app.withOrg(ORG_A, (c) => c.query(`DELETE FROM audit.audit_logs`)),
    ).rejects.toThrow(/permission denied|append-only/);
    await expect(env.sql(`UPDATE audit.audit_logs SET outcome='failure'`)).rejects.toThrow(
      /append-only/,
    );
    await expect(env.sql(`DELETE FROM audit.audit_logs`)).rejects.toThrow(/append-only/);
    await expect(env.sql(`TRUNCATE audit.audit_logs`)).rejects.toThrow(/append-only/);
  });

  it('enforces the action taxonomy <domain>.<resource>.<action>', async () => {
    await expect(insert(env, ORG_A, 'login')).rejects.toThrow(/check constraint/);
    await expect(insert(env, ORG_A, 'Auth.Login.Failed')).rejects.toThrow(/check constraint/);
  });

  it('RLS: a tenant sees only its own chain; inserts must match the context org', async () => {
    const own = await env.app.withOrg(ORG_A, (c) =>
      c.query('SELECT DISTINCT org_id FROM audit.audit_logs'),
    );
    expect(own.rows).toEqual([{ org_id: ORG_A }]);
    // no context at all: the platform chain rows (org NULL) are not readable either
    expect(
      (await env.app.withoutScope((c) => c.query('SELECT 1 FROM audit.audit_logs'))).rowCount,
    ).toBe(0);
    await expect(
      env.app.withOrg(ORG_A, (c) =>
        c.query(
          `INSERT INTO audit.audit_logs (id, actor_type, org_id, action, outcome) VALUES (gen_random_uuid(),'system',$1,'test.cross.insert','success')`,
          [ORG_B],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    // the chain-head table is not reachable at all by runtime roles
    await expect(
      env.app.withOrg(ORG_A, (c) => c.query('SELECT * FROM audit.chain_heads')),
    ).rejects.toThrow(/permission denied/);
    // verification is scoped: another tenant's chain is refused
    await expect(
      env.app.withOrg(ORG_A, (c) => c.query('SELECT * FROM audit.verify_chain($1)', [ORG_B])),
    ).rejects.toThrow(/not in scope/);
    expect(
      (
        await env.app.withOrg(ORG_A, (c) =>
          c.query('SELECT ok FROM audit.verify_chain($1)', [ORG_A]),
        )
      ).rows[0]!.ok,
    ).toBe(true);
  });
});

describe('unscoped callers are refused (NULL-scope regression, found in M02 review)', () => {
  it('verify_chain and chain_tips raise when no scope is set at all', async () => {
    await expect(
      env.app.withoutScope((c) => c.query('SELECT * FROM audit.verify_chain($1)', [ORG_A])),
    ).rejects.toThrow(/not in scope/);
    await expect(
      env.app.withoutScope((c) => c.query('SELECT * FROM audit.chain_tips()')),
    ).rejects.toThrow(/platform scope required/);
  });
});

describe('tamper detection', () => {
  it('detects an edited row, naming the first bad sequence', async () => {
    await asAttacker(() =>
      env.sql(`UPDATE audit.audit_logs SET outcome='failure' WHERE org_id=$1 AND chain_seq=3`, [
        ORG_A,
      ]),
    );
    const v = await integrity.verifyChain(ORG_A);
    expect(v).toMatchObject({ ok: false, firstBadSeq: 3 });
    expect(v.reason).toMatch(/does not match its hash/);
    await asAttacker(() =>
      env.sql(`UPDATE audit.audit_logs SET outcome='success' WHERE org_id=$1 AND chain_seq=3`, [
        ORG_A,
      ]),
    );
    expect((await integrity.verifyChain(ORG_A)).ok).toBe(true);
  });

  it('detects a deleted row in the middle (sequence gap) and a re-hashed forgery', async () => {
    await asAttacker(() =>
      env.sql(`DELETE FROM audit.audit_logs WHERE org_id=$1 AND chain_seq=2`, [ORG_B]),
    );
    expect(await integrity.verifyChain(ORG_B)).toMatchObject({ ok: false, firstBadSeq: 2 });
  });

  it('detects tail truncation through chain_heads, and through a signed checkpoint even if the head is also rewritten', async () => {
    // fresh chain: add rows, checkpoint, then truncate the tail and "repair" chain_heads like an attacker would
    const ORG_C = '00000000-0000-7000-8000-00000000000c';
    for (let i = 0; i < 4; i++) await insert(env, ORG_C, 'test.tail.done', { i });
    expect((await integrity.checkpoint(ORG_C)).upToSeq).toBe(4);
    await insert(env, ORG_C);
    await asAttacker(() =>
      env.sql(`DELETE FROM audit.audit_logs WHERE org_id=$1 AND chain_seq=5`, [ORG_C]),
    );
    expect(await integrity.verifyChain(ORG_C)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/tail truncated/),
    });
    await env.sql(
      `UPDATE audit.chain_heads SET last_seq=4, last_hash=(SELECT hash FROM audit.audit_logs WHERE org_id=$1 AND chain_seq=4) WHERE chain_key=$1`,
      [ORG_C],
    );
    expect((await integrity.verifyChain(ORG_C)).ok).toBe(true); // truncation of UNCHECKPOINTED tail is by design undetectable
    // but rewriting history BEFORE a checkpoint is caught even with a consistent chain_heads
    await asAttacker(() =>
      env.sql(`DELETE FROM audit.audit_logs WHERE org_id=$1 AND chain_seq=4`, [ORG_C]),
    );
    await env.sql(
      `UPDATE audit.chain_heads SET last_seq=3, last_hash=(SELECT hash FROM audit.audit_logs WHERE org_id=$1 AND chain_seq=3) WHERE chain_key=$1`,
      [ORG_C],
    );
    expect(await integrity.verifyChain(ORG_C)).toMatchObject({
      ok: false,
      firstBadSeq: 4,
      reason: expect.stringMatching(/checkpointed row is missing/),
    });
  });

  it('rejects a checkpoint with a forged signature', async () => {
    await env.sql(
      `ALTER TABLE audit.audit_checkpoints DISABLE TRIGGER audit_checkpoints_no_update`,
    );
    await env.sql(
      `UPDATE audit.audit_checkpoints SET signature = repeat('0', 64) WHERE chain_key='00000000-0000-7000-8000-00000000000c'`,
    );
    await env.sql(`ALTER TABLE audit.audit_checkpoints ENABLE TRIGGER audit_checkpoints_no_update`);
    expect(await integrity.verifyChain('00000000-0000-7000-8000-00000000000c')).toMatchObject({
      ok: false,
      reason: 'checkpoint signature invalid',
    });
  });

  it('refuses to checkpoint a broken chain, and runOnce checkpoints healthy chains idempotently', async () => {
    await expect(integrity.checkpoint(ORG_B)).rejects.toThrow(
      /refusing to checkpoint a broken chain/,
    );
    const first = await integrity.runOnce();
    expect(first.chains.find((c) => c.chainKey === ORG_A)).toMatchObject({ ok: true });
    expect(first.chains.find((c) => c.chainKey === ORG_B)?.ok).toBe(false);
    expect(first.checkpointed).toBeGreaterThanOrEqual(2); // ORG_A and the platform chain
    expect((await integrity.runOnce()).checkpointed).toBe(0); // nothing new to anchor
    // checkpoints are append-only as well (rows exist now, so the row triggers fire)
    await expect(env.sql(`UPDATE audit.audit_checkpoints SET head_hash='x'`)).rejects.toThrow(
      /append-only/,
    );
    await expect(env.sql(`DELETE FROM audit.audit_checkpoints`)).rejects.toThrow(/append-only/);
  });
});

describe('verifier job under the worker role', () => {
  it('the least-privilege nuzm_worker role can verify and checkpoint (platform scope), but cannot write audit rows it does not own', async () => {
    const asWorker = new AuditIntegrity(env.worker, signer);
    await insert(env, ORG_A, 'test.after.worker', { n: 1 });
    const run = await asWorker.runOnce();
    expect(run.chains.find((c) => c.chainKey === ORG_A)?.ok).toBe(true);
    expect(run.checkpointed).toBeGreaterThanOrEqual(1);
    await expect(
      env.worker.withOrg(ORG_A, (c) =>
        c.query(
          `INSERT INTO audit.audit_logs (id, actor_type, org_id, action, outcome) VALUES (gen_random_uuid(),'system',$1,'test.cross.insert','success')`,
          [ORG_B],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});
