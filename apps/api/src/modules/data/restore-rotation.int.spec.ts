import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MockDatabaseAdapter } from '@nuzm/adapter-data';
import { SecretStore } from '../../common/secrets';
import { DataAdapterRegistry } from './internal/adapter-registry';
import { DataAlerts } from './internal/alerts';
import { DatabaseBindingPort } from './internal/binding.port';
import { DatabaseFlow } from './internal/database-flow';
import { DataJobs } from './internal/jobs';
import { RestoreService } from './internal/restore.service';
import { RotationService } from './internal/rotation.service';
import { setupDataEnv, type DataEnv, type Row } from './testing/data-harness';

let e: DataEnv;
let jobs: DataJobs;
let restores: RestoreService;
let rotations: RotationService;
let alerts: DataAlerts;
let mock: MockDatabaseAdapter;
const orgA = () => e.org.A!;
const ref = async (id: string) =>
  (await e.h.env.sql(`SELECT provider_ref FROM data.database_instances WHERE id = $1`, [id]))[0]!
    .provider_ref as string;
const ROWS = (n: number, tag = 'r') =>
  Array.from({ length: n }, (_, i) => ({ id: i + 1, v: `${tag}-${i + 1}` }));
const backup = async (dbId: string, who = 'alice') => {
  const b = await e.call(who, 'POST', `/v1/databases/${dbId}/backups`, {});
  await jobs.runOne(orgA(), b.json().operationId);
  return b.json().id as string;
};
const restore = (dbId: string, body: Row, who = 'alice') =>
  e.call(who, 'POST', `/v1/databases/${dbId}/restores`, body);
const runRestore = async (r: { json(): Row }) => {
  await jobs.runOne(orgA(), r.json().operationId);
  return (
    await e.h.env.sql(`SELECT * FROM data.database_restores WHERE id = $1`, [r.json().id])
  )[0] as Row;
};
const integrity = async (providerRef: string) =>
  (
    await mock.integrityCheck(
      { providerAccountId: 'x', credentialRef: 'vault://x/y', traceId: 't', deadlineMs: 1 },
      providerRef,
      { sampleTables: 100 },
    )
  ).data!.tables;

beforeAll(async () => {
  e = await setupDataEnv();
  const reg = e.app.get(DataAdapterRegistry);
  mock = reg.get('database', 'mock-database') as MockDatabaseAdapter;
  jobs = e.app.get(DataJobs);
  restores = e.app.get(RestoreService);
  rotations = e.app.get(RotationService);
  alerts = e.app.get(DataAlerts);
  await e.enableLocal('database', 'mock-database', {
    defaultRegion: 'sa-central',
    versions: { postgresql: ['16'], mysql: ['8.4'] },
  });
}, 120_000);
afterAll(() => e.h.close());

describe('AC-M08-03: restore-to-new reproduces the source (row counts and checksums equal) for PostgreSQL and MySQL — simulated data, NOT VERIFIED', () => {
  for (const engine of ['postgresql', 'mysql'] as const)
    it(`${engine}: backup → restore (default target = new) → a second, verified database with the same sampled tables`, async () => {
      const db = await e.provision('alice', orgA(), { engine, name: `src-${engine}` });
      const pr = await ref(db.id);
      mock.seedTable(pr, 'accounts', ROWS(5));
      mock.seedTable(pr, 'orders', ROWS(3, 'o'));
      const bk = await backup(db.id);
      const r = await restore(db.id, { backupId: bk });
      expect(r.statusCode).toBe(202);
      expect(r.json()).toMatchObject({
        mode: 'new',
        state: 'requested',
        databaseId: db.id,
        backupId: bk,
      });
      const row = await runRestore(r);
      expect(row.state).toBe('succeeded');
      const v = row.verification as {
        passed: boolean;
        tables: { table: string; rowCount: number; match: boolean }[];
      };
      expect(v.passed).toBe(true);
      expect(v.tables.map((t) => [t.table, t.rowCount, t.match])).toEqual([
        ['accounts', 5, true],
        ['orders', 3, true],
      ]);
      const target = (
        await e.call('alice', 'GET', `/v1/databases/${row.target_instance_id}`)
      ).json();
      expect(target).toMatchObject({ status: 'running', engine, tlsRequired: true });
      expect(target.name).toContain('-restore-');
      expect(target.vaultRef).toMatch(/^vault:\/\//);
      expect(target.vaultRef).not.toBe(db.vaultRef); // its own credential
      expect(await integrity(await ref(target.id))).toEqual(await integrity(pr)); // 100% of sampled tables equal
      const list = (await e.call('alice', 'GET', `/v1/databases/${db.id}/backups`))
        .json()
        .items.find((b: Row) => b.id === bk);
      expect(list.restores.map((x: Row) => [x.mode, x.state])).toEqual([['new', 'succeeded']]);
      expect(list.lastVerification.passed).toBe(true);
      expect(e.sink.events.map((x) => x.action)).toEqual(
        expect.arrayContaining(['data.database.restore_requested', 'data.database.restored']),
      );
    });

  it('a restore never stays unverified: when the restored data does not match the backup manifest it FAILS, the copy is marked failed and an alert is raised', async () => {
    const db = await e.provision('alice', orgA(), { name: 'src-corrupt' });
    const pr = await ref(db.id);
    mock.seedTable(pr, 'accounts', ROWS(4));
    const bk = await backup(db.id);
    mock.corruptBackup(
      pr,
      (
        await e.h.env.sql(`SELECT provider_backup_ref FROM data.database_backups WHERE id = $1`, [
          bk,
        ])
      )[0]!.provider_backup_ref as string,
    );
    const row = await runRestore(await restore(db.id, { backupId: bk }));
    expect(row.state).toBe('failed');
    expect(row.failure_code).toBe('verification_mismatch');
    expect(
      (
        await e.h.env.sql(`SELECT state FROM data.database_instances WHERE id = $1`, [
          row.target_instance_id,
        ])
      )[0]!.state,
    ).toBe('failed');
    expect(
      alerts.raised.some(
        (a) => a.kind === 'data.restore_verification_failed' && a.severity === 'critical',
      ),
    ).toBe(true);
  });
});

describe('restore rules: tenant, region, state, in-place confirmation', () => {
  let db: Row;
  let bk: string;
  beforeAll(async () => {
    db = await e.provision('alice', orgA(), { name: 'rules-db' });
    mock.seedTable(await ref(db.id), 'accounts', ROWS(6));
    bk = await backup(db.id);
  });

  it('refuses an unknown/foreign backup (404), unknown fields and org selectors (403/422), roles without data:db:admin (403)', async () => {
    expect(
      (await restore(db.id, { backupId: '00000000-0000-7000-8000-00000000dead' })).statusCode,
    ).toBe(404);
    expect((await restore(db.id, { backupId: bk, targetOrgId: e.org.B })).statusCode).toBe(403);
    expect((await restore(db.id, { backupId: bk, bogus: 1 })).statusCode).toBe(422);
    expect((await restore(db.id, { backupId: bk, target: 'elsewhere' })).statusCode).toBe(422);
    expect((await restore(db.id, { backupId: bk }, 'dave')).statusCode).toBe(403);
    expect((await restore(db.id, { backupId: bk }, 'carol')).statusCode).toBe(403);
    expect((await restore(db.id, { backupId: bk }, 'bob')).statusCode).toBeGreaterThanOrEqual(403);
    expect((await restore(db.id, { backupId: bk, name: 'Bad Name' })).statusCode).toBe(422);
  });
  it('the backup of another database of the same organization cannot be used (404): a restore is bound to its source database', async () => {
    const other = await e.provision('alice', orgA(), { name: 'other-db' });
    expect((await restore(other.id, { backupId: bk })).statusCode).toBe(404);
  });
  it('a region other than the source: residency-denied regions are 403 residency_denied (AC-M08-15), allowed ones are still not supported (422 restore_not_supported)', async () => {
    const de = await restore(db.id, { backupId: bk, region: 'de-frankfurt' });
    expect(de.statusCode).toBe(403);
    expect(de.json().code).toBe('residency_denied');
    const west = await restore(db.id, { backupId: bk, region: 'sa-west' });
    expect(west.statusCode).toBe(422);
    expect(west.json().code).toBe('restore_not_supported');
  });
  it('an expired backup is a conflict', async () => {
    const old = await backup(db.id);
    await e.h.env.sql(
      `UPDATE data.database_backups SET expires_at = now() - interval '1 day' WHERE id = $1`,
      [old],
    );
    expect((await restore(db.id, { backupId: old })).statusCode).toBe(409);
  });
  it('in-place needs confirmInPlace, the typed name and a recent MFA check; developers cannot; the provider must support it', async () => {
    expect((await restore(db.id, { backupId: bk, target: 'inplace' })).statusCode).toBe(422);
    expect(
      (await restore(db.id, { backupId: bk, target: 'inplace', confirmInPlace: true })).statusCode,
    ).toBe(422);
    expect(
      (
        await restore(
          db.id,
          { backupId: bk, target: 'inplace', confirmInPlace: true, confirmName: 'rules-db' },
          'dave',
        )
      ).statusCode,
    ).toBe(403);
    // erin is an admin WITHOUT a recent MFA verification
    const stale = await restore(
      db.id,
      { backupId: bk, target: 'inplace', confirmInPlace: true, confirmName: 'rules-db' },
      'erin',
    );
    expect(stale.statusCode).toBe(401);
    expect(stale.json().code).toBe('step_up_required');
    expect(
      await e.h.env.sql(
        `SELECT count(*)::int n FROM data.database_restores WHERE mode = 'inplace'`,
      ),
    ).toEqual([{ n: 0 }]);
  });
  it('in-place with every confirmation: an automatic pre-restore backup is taken first, the data returns to the backup, the database stays', async () => {
    const pr = await ref(db.id);
    mock.seedTable(pr, 'accounts', ROWS(2, 'damaged'));
    const r = await restore(db.id, {
      backupId: bk,
      target: 'inplace',
      confirmInPlace: true,
      confirmName: 'rules-db',
    });
    expect(r.statusCode).toBe(202);
    const row = await runRestore(r);
    expect(row.state).toBe('succeeded');
    expect(row.pre_restore_backup_id).toBeTruthy();
    expect(
      (
        await e.h.env.sql(`SELECT type, state FROM data.database_backups WHERE id = $1`, [
          row.pre_restore_backup_id,
        ])
      )[0],
    ).toEqual({ type: 'pre_restore', state: 'available' });
    expect(mock.tableRows(pr, 'accounts')).toEqual(ROWS(6));
    expect((await e.call('alice', 'GET', `/v1/databases/${db.id}`)).json().status).toBe('running');
  });
  it('in-place when the provider cannot do it: the restore FAILS with restore_not_supported after the safety backup, nothing is overwritten', async () => {
    const pr = await ref(db.id);
    mock.seedTable(pr, 'accounts', ROWS(3, 'live'));
    mock.setCapabilities({ 'database.restore-in-place': 'unsupported' });
    const row = await runRestore(
      await restore(db.id, {
        backupId: bk,
        target: 'inplace',
        confirmInPlace: true,
        confirmName: 'rules-db',
      }),
    );
    mock.setCapabilities({ 'database.restore-in-place': 'supported' });
    expect(row.state).toBe('failed');
    expect(row.failure_code).toBe('restore_not_supported');
    expect(mock.tableRows(pr, 'accounts')).toEqual(ROWS(3, 'live'));
  });
  it('the provider probe says restore-to-new is unsupported → 422 restore_not_supported at request time', async () => {
    await e.h.env.sql(
      `UPDATE data.data_providers SET probe = jsonb_set(probe, '{capabilities,database.restore-to-new}', '"unsupported"') WHERE provider_code = 'mock-database'`,
    );
    const r = await restore(db.id, { backupId: bk });
    await e.h.env.sql(
      `UPDATE data.data_providers SET probe = jsonb_set(probe, '{capabilities,database.restore-to-new}', '"supported"') WHERE provider_code = 'mock-database'`,
    );
    expect(r.statusCode).toBe(422);
    expect(r.json().code).toBe('restore_not_supported');
  });
});

describe('AC-M08-04: the restore-verification job runs end to end and alerts on injected corruption', () => {
  it('restores the latest backup into a scratch instance, checks it, records the result and DESTROYS the scratch; not repeated inside the cadence', async () => {
    const db = await e.provision('alice', orgA(), { name: 'drill-db' });
    const pr = await ref(db.id);
    mock.seedTable(pr, 'accounts', ROWS(8));
    const bk = await backup(db.id);
    const before = mock.billableCount();
    const n = await restores.verifyDue(new Date(), { orgId: orgA(), databaseId: db.id });
    expect(n).toBe(1);
    const drill = (
      await e.h.env.sql(
        `SELECT * FROM data.database_restores WHERE source_instance_id = $1 AND mode = 'verification'`,
        [db.id],
      )
    )[0] as Row;
    expect(drill).toMatchObject({ state: 'succeeded', source_backup_id: bk });
    expect(drill.verification).toMatchObject({ passed: true, engineCheck: 'ok' });
    expect(mock.billableCount()).toBe(before); // the scratch copy is gone
    expect(
      (
        await e.h.env.sql(`SELECT state FROM data.database_instances WHERE id = $1`, [
          drill.target_instance_id,
        ])
      )[0]!.state,
    ).toBe('deleted');
    expect(
      (await e.call('alice', 'GET', `/v1/databases?limit=200`))
        .json()
        .items.some((x: Row) => x.name?.startsWith('verify-')),
    ).toBe(false);
    await restores.verifyDue(new Date()); // the cadence (weekly proposal): this backup was just verified, so it is not drilled again
    expect(
      (
        await e.h.env.sql(
          `SELECT count(*)::int n FROM data.database_restores WHERE source_instance_id = $1 AND mode = 'verification'`,
          [db.id],
        )
      )[0],
    ).toEqual({ n: 1 });
    expect(e.sink.events.some((x) => x.action === 'data.database.restore_verified')).toBe(true);
  });
  it('injected corruption: the drill FAILS, an ops alert + an in-app notification are raised, the failed run is recorded, the scratch copy is still destroyed', async () => {
    const db = await e.provision('alice', orgA(), { name: 'drill-bad' });
    const pr = await ref(db.id);
    mock.seedTable(pr, 'accounts', ROWS(4));
    const bk = await backup(db.id);
    mock.corruptBackup(
      pr,
      (
        await e.h.env.sql(`SELECT provider_backup_ref FROM data.database_backups WHERE id = $1`, [
          bk,
        ])
      )[0]!.provider_backup_ref as string,
    );
    const before = mock.billableCount();
    const raisedBefore = alerts.raised.length;
    expect(await restores.verifyDue(new Date(), { orgId: orgA(), databaseId: db.id })).toBe(1);
    const drill = (
      await e.h.env.sql(
        `SELECT * FROM data.database_restores WHERE source_instance_id = $1 AND mode = 'verification'`,
        [db.id],
      )
    )[0] as Row;
    expect(drill).toMatchObject({ state: 'failed', failure_code: 'verification_mismatch' });
    expect((drill.verification as { passed: boolean; tables: { match: boolean }[] }).passed).toBe(
      false,
    );
    expect(
      (drill.verification as { tables: { match: boolean }[] }).tables.some((t) => !t.match),
    ).toBe(true);
    expect(mock.billableCount()).toBe(before);
    expect(alerts.raised.slice(raisedBefore).map((a) => a.kind)).toContain(
      'data.restore_verification_failed',
    );
    expect(
      (
        await e.h.env.sql(
          `SELECT count(*)::int n FROM platform.outbox WHERE topic = 'ops.alert' AND payload->>'kind' = 'data.restore_verification_failed' AND payload->'resource'->>'id' = $1`,
          [db.id],
        )
      )[0],
    ).toEqual({ n: 1 });
    const notes = (await e.call('alice', 'GET', '/v1/notifications')).json().items as Row[];
    expect(notes.some((n) => n.kind === 'data.restore_verification_failed')).toBe(true);
  });
  it('a database with no backup is not "verified by default": nothing runs for it', async () => {
    await e.provision('alice', orgA(), { name: 'no-backup' });
    const n = await restores.verifyDue(new Date(Date.now() + 30 * 86_400_000));
    expect(n).toBeGreaterThanOrEqual(0);
    expect(
      (
        await e.h.env.sql(
          `SELECT count(*)::int n FROM data.database_restores r JOIN data.database_instances i ON i.id = r.source_instance_id WHERE i.name = 'no-backup'`,
        )
      )[0],
    ).toEqual({ n: 0 });
  });
});

describe('AC-M08-06: credential rotation with a dual-credential window', () => {
  let db: Row;
  let pr: string;
  const notices: Row[] = [];
  beforeAll(async () => {
    db = await e.provision('alice', orgA(), { name: 'rot-db' });
    pr = await ref(db.id);
    const bp = e.app.get(DatabaseBindingPort);
    bp.notifyRotation = async (_o, n) => void notices.push(n as unknown as Row);
  });
  const credId = async (vaultRef: string) =>
    (JSON.parse(await e.app.get(SecretStore).get(vaultRef)) as { credentialId: string })
      .credentialId;
  const rotate = (who = 'alice', body: Row = {}, id = db.id) =>
    e.call(who, 'POST', `/v1/databases/${id}/credential-rotations`, body);

  it('roles: developers and viewers cannot (403); an admin without a recent MFA check needs step-up (401); bad input is 422', async () => {
    expect((await rotate('dave')).statusCode).toBe(403);
    expect((await rotate('carol')).statusCode).toBe(403);
    expect((await rotate('erin')).json().code).toBe('step_up_required');
    expect((await rotate('alice', { role: 'Bad Role!' })).statusCode).toBe(422);
    expect((await rotate('alice', { bogus: 1 })).statusCode).toBe(422);
  });
  it('without dual-credential support the action is DISABLED (422 unsupported_capability): a hard swap would break running consumers', async () => {
    await e.h.env.sql(
      `UPDATE data.data_providers SET probe = jsonb_set(probe, '{capabilities,database.dual-credentials}', '"unsupported"') WHERE provider_code = 'mock-database'`,
    );
    const r = await rotate();
    await e.h.env.sql(
      `UPDATE data.data_providers SET probe = jsonb_set(probe, '{capabilities,database.dual-credentials}', '"supported"') WHERE provider_code = 'mock-database'`,
    );
    expect(r.statusCode).toBe(422);
    expect(r.json().code).toBe('unsupported_capability');
  });
  it('rotate: the new secret goes to the vault, consumers are told (a reference, never a secret), BOTH credentials work inside the window, a second rotation is a 409', async () => {
    const oldRef = db.vaultRef as string;
    const oldId = await credId(oldRef);
    const r = await rotate();
    expect(r.statusCode).toBe(202);
    expect(r.json().rotation).toMatchObject({ state: 'pending' });
    expect((await rotate()).json().code).toBe('rotation_in_progress'); // concurrent request while pending
    await jobs.runOne(orgA(), r.json().operationId);
    const got = (await e.call('alice', 'GET', `/v1/databases/${db.id}`)).json();
    expect(got.rotation).toMatchObject({ state: 'window' });
    expect(got.vaultRef).not.toBe(oldRef);
    const newId = await credId(got.vaultRef);
    expect(newId).not.toBe(oldId);
    expect(mock.authenticates(pr, oldId) && mock.authenticates(pr, newId)).toBe(true); // zero downtime: the consumer can switch at any moment of the window
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      databaseId: db.id,
      newVaultRef: got.vaultRef,
      previousVaultRef: oldRef,
    });
    expect(JSON.stringify(notices[0])).not.toMatch(/password|mock-secret/);
    expect((await rotate()).json().code).toBe('rotation_in_progress'); // window open
    expect(
      (
        (
          await e.h.env.sql(`SELECT rotation FROM data.database_instances WHERE id = $1`, [db.id])
        )[0]!.rotation as { windowEndsAt?: string }
      ).windowEndsAt,
    ).toBeTruthy();
    expect(e.sink.events.map((x) => x.action)).toEqual(
      expect.arrayContaining(['data.database.rotation_requested', 'data.database.rotated']),
    );
    expect(JSON.stringify(e.sink.events)).not.toMatch(/mock-secret|"password"/);
    // not before the window ends
    expect(await rotations.endWindows(new Date())).toBe(0);
    expect(mock.authenticates(pr, oldId)).toBe(true);
    // window end: the OLD credential is rejected right away (the sweep runs at least every 30 s; the check below is the run immediately after the end)
    const endsAt = new Date(got.rotation.windowEndsAt as string);
    const t0 = Date.now();
    expect(await rotations.endWindows(new Date(endsAt.getTime() + 1000))).toBe(1);
    expect(Date.now() - t0).toBeLessThan(60_000);
    expect(mock.authenticates(pr, oldId)).toBe(false);
    expect(mock.authenticates(pr, newId)).toBe(true);
    await expect(e.app.get(SecretStore).get(oldRef)).rejects.toThrow(); // the old vault entry is gone
    expect((await e.call('alice', 'GET', `/v1/databases/${db.id}`)).json().rotation).toMatchObject({
      state: 'completed',
    });
    expect(e.sink.events.some((x) => x.action === 'data.database.rotation_completed')).toBe(true);
    // a new rotation can start now
    expect((await rotate()).statusCode).toBe(202);
    await jobs.runOne(
      orgA(),
      (
        await e.h.env.sql(`SELECT operation_id FROM data.database_instances WHERE id = $1`, [db.id])
      )[0]!.operation_id as string,
    );
  });
  it('a revoke that fails never ends the window silently: it stays open, a critical alert is raised and the next sweep retries', async () => {
    const d2 = await e.provision('alice', orgA(), { name: 'rot-fail' });
    const r = await rotate('alice', {}, d2.id);
    await jobs.runOne(orgA(), r.json().operationId);
    const ends = new Date(
      (
        (
          await e.h.env.sql(`SELECT rotation FROM data.database_instances WHERE id = $1`, [d2.id])
        )[0]!.rotation as { windowEndsAt: string }
      ).windowEndsAt,
    );
    mock.inject('revokeCredential', 'outage', 4);
    expect(
      await rotations.endWindows(new Date(ends.getTime() + 1000), {
        orgId: orgA(),
        databaseId: d2.id,
      }),
    ).toBe(0);
    expect(
      alerts.raised.some(
        (a) => a.kind === 'data.rotation_revoke_failed' && a.severity === 'critical',
      ),
    ).toBe(true);
    expect((await e.call('alice', 'GET', `/v1/databases/${d2.id}`)).json().rotation.state).toBe(
      'window',
    );
    expect(
      await rotations.endWindows(new Date(ends.getTime() + 2000), {
        orgId: orgA(),
        databaseId: d2.id,
      }),
    ).toBe(1);
  });
});

describe('one-time credential reveal (PA-15): service only — the HTTP routes are NOT exposed until the owner approves the proposal', () => {
  it('reveals the current secret once, audited without the secret; a second reveal is a conflict; a rotation allows a new reveal; the route does not exist', async () => {
    const d = await e.provision('alice', orgA(), { name: 'reveal-db' });
    const first = await rotations.reveal(orgA(), e.ids.alice!, d.id);
    expect(first).toMatchObject({ engine: 'postgresql', tls: true });
    expect(first.password.length).toBeGreaterThan(8);
    await expect(rotations.reveal(orgA(), e.ids.alice!, d.id)).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(e.sink.events.some((x) => x.action === 'data.database.credential_revealed')).toBe(true);
    expect(JSON.stringify(e.sink.events)).not.toContain(first.password);
    const r = await e.call('alice', 'POST', `/v1/databases/${d.id}/credential-rotations`, {});
    await jobs.runOne(orgA(), r.json().operationId);
    const second = await rotations.reveal(orgA(), e.ids.alice!, d.id);
    expect(second.password).not.toBe(first.password);
    expect(
      (await e.call('alice', 'POST', `/v1/databases/${d.id}/credential-reveals`, {})).statusCode,
    ).toBe(404);
    expect((await e.call('alice', 'GET', `/v1/databases/${d.id}`)).body).not.toContain(
      second.password,
    );
    await expect(rotations.reveal(e.org.B!, e.ids.bob!, d.id)).rejects.toMatchObject({
      code: 'not_found',
    }); // another organization
  });
});

describe('background tick', () => {
  it('re-runs operations whose kick was lost and runs the registered tasks; reconcile of parked operations is part of the sweep', async () => {
    const q = await e.call('alice', 'POST', '/v1/quotes', {
      kind: 'database',
      items: [{ engine: 'postgresql', version: '16', planRef: 'mock-db-s', storageGb: 20 }],
    });
    const r = await e.call('alice', 'POST', '/v1/databases', {
      quoteId: q.json().id,
      engine: 'postgresql',
      version: '16',
      name: 'tick-db',
    }); // nobody kicked it
    const out = await jobs.tick(new Date());
    expect(out.ran).toBeGreaterThanOrEqual(1);
    expect((await e.call('alice', 'GET', `/v1/databases/${r.json().id}`)).json().status).toBe(
      'running',
    );
    expect(Object.keys(out.tasks)).toEqual(
      expect.arrayContaining([
        'scheduled-backups',
        'backup-retention',
        'usage-hourly',
        'usage-daily',
        'restore-verification',
        'rotation-window-end',
      ]),
    );
    expect(Object.values(out.tasks).every((n) => n >= 0)).toBe(true);
    void DatabaseFlow;
  });
});
