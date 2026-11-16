import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { AuditIntegrity, HmacCheckpointSigner } from '@nuzm/platform';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditSink } from '../../common/audit';
import { Harness, type App } from '../identity/testing/app-harness';

const h = new Harness();
let app: App;
let orgA = '';
let orgB = '';
let userId = '';

beforeAll(async () => {
  await h.init();
  ({ app } = await h.buildApp({}, undefined, [], { realAudit: true }));
  userId = await h.createUser('atomic');
  const user = userId;
  const mk = async (slug: string) => {
    const id = uuidv7();
    await h.env.sql(
      `INSERT INTO tenancy.organizations (id, name, slug, type, country, created_by) VALUES ($1,$2,$2,'customer','SA',$3)`,
      [id, slug, user],
    );
    return id;
  };
  orgA = await mk('atomic-a');
  orgB = await mk('atomic-b');
});
afterAll(() => h.close());

const count = async (org: string, action: string) =>
  (
    await h.env.sql(`SELECT count(*)::int n FROM audit.audit_logs WHERE org_id=$1 AND action=$2`, [
      org,
      action,
    ])
  )[0]!.n as number;
const workspaces = async (org: string) =>
  (await h.env.sql(`SELECT count(*)::int n FROM tenancy.workspaces WHERE org_id=$1`, [org]))[0]!
    .n as number;
const addWorkspace = (c: import('pg').PoolClient, org: string, slug: string) =>
  c.query(
    `INSERT INTO tenancy.workspaces (id, org_id, name, slug, created_by) VALUES ($1,$2,$3,$3,$4)`,
    [uuidv7(), org, slug, userId],
  );

describe('audit joins the surrounding transaction', () => {
  it('commits the change and its audit row together', async () => {
    const sink = app.get(AuditSink);
    await h.env.app.withOrg(orgA, async (c) => {
      await addWorkspace(c, orgA, 'ok-1');
      await sink.record({ action: 'test.atomic.committed', orgId: orgA, outcome: 'success' });
    });
    expect(await workspaces(orgA)).toBe(1);
    expect(await count(orgA, 'test.atomic.committed')).toBe(1);
  });

  it('rolls BOTH back when the transaction fails after the audit write', async () => {
    const sink = app.get(AuditSink);
    await expect(
      h.env.app.withOrg(orgA, async (c) => {
        await addWorkspace(c, orgA, 'doomed');
        await sink.record({ action: 'test.atomic.rolledback', orgId: orgA, outcome: 'success' });
        throw new Error('later step failed');
      }),
    ).rejects.toThrow('later step failed');
    expect(await workspaces(orgA)).toBe(1); // only ok-1
    expect(await count(orgA, 'test.atomic.rolledback')).toBe(0); // no phantom audit row for a change that never happened
  });

  it('fails closed: a rejected audit write aborts the change itself', async () => {
    const sink = app.get(AuditSink);
    const quiet = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      await expect(
        h.env.app.withOrg(orgA, async (c) => {
          await addWorkspace(c, orgA, 'unaudited');
          await sink.record({ action: 'bad' as never, orgId: orgA, outcome: 'success' });
        }),
      ).rejects.toThrow(/check constraint/);
    } finally {
      process.stderr.write = quiet;
    }
    expect(await workspaces(orgA)).toBe(1); // the unaudited workspace does not exist
  });

  it('an event for ANOTHER organization does not join the transaction (own chain, own commit)', async () => {
    const sink = app.get(AuditSink);
    await expect(
      h.env.app.withOrg(orgA, async () => {
        await sink.record({ action: 'test.atomic.other_org', orgId: orgB, outcome: 'success' });
        throw new Error('outer fails');
      }),
    ).rejects.toThrow('outer fails');
    expect(await count(orgB, 'test.atomic.other_org')).toBe(1); // committed independently
  });

  it('a late, un-awaited record after the transaction ended never touches the released connection', async () => {
    const sink = app.get(AuditSink);
    let late: Promise<void> | undefined;
    await h.env.app.withOrg(orgA, async () => {
      late = new Promise<void>((resolve, reject) =>
        setTimeout(() => {
          Promise.resolve(
            sink.record({ action: 'test.atomic.late', orgId: orgA, outcome: 'success' }),
          ).then(() => resolve(), reject);
        }, 50),
      );
    });
    await late; // runs after COMMIT: must use its own transaction and succeed
    expect(await count(orgA, 'test.atomic.late')).toBe(1);
  });

  it('keeps the hash chain intact through commits, rollbacks and fall-backs', async () => {
    const integrity = new AuditIntegrity(
      h.env.app,
      new HmacCheckpointSigner(new Uint8Array(randomBytes(32))),
    );
    for (const org of [orgA, orgB])
      expect(await integrity.verifyChain(org)).toMatchObject({ ok: true });
    // rolled-back audit rows left no gap in the sequence
    const seqs = (
      await h.env.sql(
        `SELECT chain_seq::int s FROM audit.audit_logs WHERE org_id=$1 ORDER BY chain_seq`,
        [orgA],
      )
    ).map((r) => r.s);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
  });
});
