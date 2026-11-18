import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_ABSENCE_RULE } from '@nuzm/domain';
import type { FaultKind, FaultOp } from '@nuzm/adapter-mock-compute';
import { AuditSink } from '../../common/audit';
import { OperationsService } from '@nuzm/platform';
import { DB } from '../../common/tokens';
import { ReconcilerService, reconcileConfigFromEnv } from './index';
import { ComputeKit, type Row } from './testing/compute-kit';

const k = new ComputeKit();
let A = '';
let B = '';
beforeAll(async () => {
  await k.init();
  A = k.orgA;
  B = k.orgB;
  // plenty of instance quota for organization A (organization B gets an explicit small limit in its own test)
  await k.sql(
    `INSERT INTO billing.entitlements (id, scope, source, kind, org_id, meter_group, limit_value, allowance, mode)
     VALUES (gen_random_uuid(), 'org_override', 'override', 'meter_limit', $1, 'compute_instances', 100000, 0, 'hard'),
            (gen_random_uuid(), 'org_override', 'override', 'meter_limit', $1, 'compute_vcpu', 1000000, 0, 'hard')`,
    [A],
  );
});
afterAll(() => k.close());

const W = DEFAULT_ABSENCE_RULE.windowMs;
const G = DEFAULT_ABSENCE_RULE.gapMs;
const opRow = async (id: string) =>
  (await k.sql(`SELECT * FROM platform.operations WHERE id = $1`, [id]))[0]!;
const recons = async (resourceId: string) =>
  (
    await k.sql(
      `SELECT result, action_taken, trigger FROM cloud.resource_reconciliations WHERE resource_id = $1 ORDER BY run_at, id`,
      [resourceId],
    )
  ).map((r) => r.result as string);

describe('timeout AFTER the side effect: reconcile, adopt, never re-provision (AC-M05-23)', () => {
  it('the instance becomes UNKNOWN and the operation needs_reconcile; the reconciler finds it by token and completes the operation with ONE provider create', async () => {
    const c = await k.createInstance('alice', A, {}, 'uncertain-1');
    const callsBefore = k.mock.provisionLog.length;
    k.mock.inject({ op: 'provision', kind: 'timeout_after_side_effect' });
    const op = await k.runOp(A, c.operationId);
    expect(op.state).toBe('needs_reconcile');
    const row = await k.instanceRow(c.instanceId);
    expect(row).toMatchObject({ status: 'unknown', rstate: 'UNKNOWN', provider_ref: null });
    expect(k.mock.billableByToken(row.provision_token)).toBe(1); // the side effect happened
    expect(
      (await k.call('alice', 'GET', `/v1/compute/instances/${c.instanceId}`, A)).json().status,
    ).toBe('unknown'); // the console shows the uncertain-state banner from this
    expect(
      k.sink.events.some(
        (e) => e.action === 'instance.create.uncertain' && e.resource?.id === c.instanceId,
      ),
    ).toBe(true);
    // the orchestrator itself cannot leave UNKNOWN (DB trigger + domain), only the reconciler
    await expect(
      k.sql(`UPDATE cloud.resources SET state = 'ACTIVE' WHERE id = $1`, [row.rid]),
    ).rejects.toThrow(/only the reconciler/);

    const out = await k.reconciler.reconcileResource(row.rid);
    expect(out.result).toBe('adopted');
    expect((await opRow(c.operationId)).state).toBe('succeeded');
    const after = await k.instanceRow(c.instanceId);
    expect(after).toMatchObject({ status: 'running', rstate: 'ACTIVE' });
    expect(after.provider_ref).toMatch(/^mock-i-/);
    expect(k.mock.billableByToken(row.provision_token)).toBe(1);
    expect(k.mock.provisionLog.length - callsBefore).toBe(1); // never a second create
    expect(k.mock.provisionLog.slice(callsBefore).every((e) => !e.existed)).toBe(true);
    expect(await recons(row.rid)).toEqual(['adopted']);
    expect(
      k.sink.events.some(
        (e) =>
          e.action === 'instance.create.succeeded' &&
          e.resource?.id === c.instanceId &&
          e.detail?.adopted === true,
      ),
    ).toBe(true);
    expect(
      await k.sql(
        `SELECT 1 FROM commerce.authorization_releases r JOIN commerce.authorizations a ON a.id = r.authorization_id JOIN compute.instances i ON i.order_id = a.order_id WHERE i.id = $1`,
        [c.instanceId],
      ),
    ).toHaveLength(0);
  });

  it('a vendor WITHOUT token dedupe still ends with one resource: the orchestrator never replays after the side effect', async () => {
    k.mock.setDedupe(false);
    try {
      const c = await k.createInstance('alice', A, {}, 'uncertain-dup');
      k.mock.inject({ op: 'provision', kind: 'timeout_after_side_effect' });
      await k.runOp(A, c.operationId);
      const row = await k.instanceRow(c.instanceId);
      await k.reconciler.reconcileResource(row.rid);
      expect(k.mock.billableByToken(row.provision_token)).toBe(1);
      expect(k.mock.provisionLog.filter((e) => e.token === row.provision_token)).toHaveLength(1);
      expect((await k.instanceRow(c.instanceId)).status).toBe('running');
    } finally {
      k.mock.setDedupe(true);
    }
  });
});

describe('timeout BEFORE the side effect: retry only after PROVEN absence (AC-M05-23)', () => {
  it('one "not found" is not proof; two absent observations after the consistency window, spaced apart, prove it; then exactly one retry', async () => {
    const c = await k.createInstance('alice', A, {}, 'before-1');
    const start = k.mock.provisionLog.length;
    k.mock.inject({ op: 'provision', kind: 'timeout_before_side_effect' });
    expect((await k.runOp(A, c.operationId)).state).toBe('needs_reconcile');
    const row = await k.instanceRow(c.instanceId);
    expect(row.rstate).toBe('UNKNOWN');
    expect(k.mock.billableByToken(row.provision_token)).toBe(0);
    expect((await k.reconciler.reconcileResource(row.rid)).result).toBe('absence_pending'); // inside the consistency window: the observation does not count
    k.advance(W + 1000);
    expect((await k.reconciler.reconcileResource(row.rid)).result).toBe('absence_pending'); // first counted observation
    expect(k.mock.provisionLog.length - start).toBe(1); // still no second attempt
    k.advance(G + 1000);
    const out = await k.reconciler.reconcileResource(row.rid);
    expect(out.result).toBe('absence_proven');
    expect((await opRow(c.operationId)).state).toBe('succeeded');
    expect(await k.instanceRow(c.instanceId)).toMatchObject({
      status: 'running',
      rstate: 'ACTIVE',
    });
    expect(k.mock.provisionLog.length - start).toBe(2); // the original (uncertain) + exactly one retry
    expect(k.mock.billableByToken(row.provision_token)).toBe(1);
    expect(k.mock.provisionLog.slice(start).every((e) => !e.existed)).toBe(true);
    expect(k.sink.events.some((e) => e.action === 'cloud.reconcile.absence_proven')).toBe(true);
  });

  it('eventual consistency: a created resource that is not visible yet is NOT treated as absent (lookup lag must not trigger a duplicate)', async () => {
    const c = await k.createInstance('alice', A, {}, 'lag-1');
    k.mock.setConsistencyLag(10 * 60_000);
    try {
      k.mock.inject({ op: 'provision', kind: 'timeout_after_side_effect' });
      await k.runOp(A, c.operationId);
      const row = await k.instanceRow(c.instanceId);
      expect((await k.reconciler.reconcileResource(row.rid)).result).toBe('absence_pending'); // exists but invisible
      k.advance(W + 1000);
      expect((await k.reconciler.reconcileResource(row.rid)).result).toBe('absence_pending');
      expect(k.mock.billableByToken(row.provision_token)).toBe(1);
      expect(k.mock.provisionLog.filter((e) => e.token === row.provision_token)).toHaveLength(1);
      k.advance(10 * 60_000); // the resource becomes visible: adopted before any proof of absence could form
      expect((await k.reconciler.reconcileResource(row.rid)).result).toBe('adopted');
      expect(k.mock.billableByToken(row.provision_token)).toBe(1);
    } finally {
      k.mock.setConsistencyLag(0);
    }
  });

  it('a provider that cannot look resources up by token NEVER gets a retry; after N cycles an admin case is opened', async () => {
    await k.sql(
      `UPDATE cloud.provider_capabilities SET state = 'unsupported' WHERE account_id = $1 AND capability_id = 'compute.find-by-token'`,
      [k.accountId],
    );
    try {
      const c = await k.createInstance('alice', A, {}, 'nolookup-1');
      k.mock.inject({ op: 'provision', kind: 'timeout_before_side_effect' });
      await k.runOp(A, c.operationId);
      const row = await k.instanceRow(c.instanceId);
      const start = k.mock.provisionLog.length;
      const results: string[] = [];
      for (let i = 0; i < 3; i++) {
        k.advance(W + G + 1000);
        results.push((await k.reconciler.reconcileResource(row.rid)).result);
      }
      expect(results).toEqual([
        'cannot_prove_absence',
        'cannot_prove_absence',
        'cannot_prove_absence',
      ]);
      expect(k.mock.provisionLog.length).toBe(start); // never retried
      const res = (
        await k.sql(`SELECT case_opened_at, drift_state FROM cloud.resources WHERE id = $1`, [
          row.rid,
        ])
      )[0]!;
      expect(res.case_opened_at).toBeTruthy();
      expect(res.drift_state).toBe('orphan_suspected');
      expect(k.sink.events.some((e) => e.action === 'orphan.case.opened')).toBe(true);
      expect((await opRow(c.operationId)).state).toBe('needs_reconcile');
    } finally {
      await k.sql(
        `UPDATE cloud.provider_capabilities SET state = 'supported' WHERE account_id = $1 AND capability_id = 'compute.find-by-token'`,
        [k.accountId],
      );
    }
  });

  it('a rate-limited (definitive) failure retries with backoff using the SAME token; the pre-retry lookup finds nothing; one resource results', async () => {
    const c = await k.createInstance('alice', A, {}, 'ratelimit-1');
    const start = k.mock.provisionLog.length;
    k.mock.inject({ op: 'provision', kind: 'rate_limit' });
    expect((await k.runOp(A, c.operationId)).state).toBe('pending');
    expect(await k.instanceRow(c.instanceId)).toMatchObject({
      rstate: 'PROVISIONING',
      provider_ref: null,
    });
    await k.sql(`UPDATE platform.operations SET next_run_at = now() WHERE id = $1`, [
      c.operationId,
    ]);
    expect((await k.runOp(A, c.operationId)).state).toBe('succeeded');
    const row = await k.instanceRow(c.instanceId);
    expect(k.mock.billableByToken(row.provision_token)).toBe(1);
    const log = k.mock.provisionLog.slice(start);
    expect(log).toHaveLength(2);
    expect(new Set(log.map((e) => e.token)).size).toBe(1);
  });
});

describe('uncertain delete and action', () => {
  it('delete timeout after the side effect → UNKNOWN → reconciler sees it gone and completes the deletion; reconcile-before-delete at the API', async () => {
    const c = await k.createInstance('alice', A, {}, 'del-1');
    await k.runOp(A, c.operationId);
    const g = await k.call('alice', 'GET', `/v1/compute/instances/${c.instanceId}`, A);
    k.mock.inject({ op: 'delete', kind: 'timeout_after_side_effect' });
    const d = await k.call(
      'alice',
      'DELETE',
      `/v1/compute/instances/${c.instanceId}`,
      A,
      undefined,
      { 'if-match': g.headers.etag as string },
    );
    expect(d.statusCode).toBe(202);
    expect((await k.runOp(A, d.json().operationId)).state).toBe('needs_reconcile');
    const row = await k.instanceRow(c.instanceId);
    expect(row).toMatchObject({ status: 'unknown', rstate: 'UNKNOWN' });
    // a second delete while uncertain reconciles first (and then finds the instance gone)
    const g2 = await k.call('alice', 'GET', `/v1/compute/instances/${c.instanceId}`, A);
    const again = await k.call(
      'alice',
      'DELETE',
      `/v1/compute/instances/${c.instanceId}`,
      A,
      undefined,
      { 'if-match': g2.headers.etag as string },
    );
    expect([202, 409]).toContain(again.statusCode);
    expect(await k.instanceRow(c.instanceId)).toMatchObject({
      status: 'deleted',
      rstate: 'DELETED',
    });
    expect((await opRow(d.json().operationId)).state).toBe('succeeded');
    expect(k.mock.billableByToken(row.provision_token)).toBe(0);
  });

  it('a stop that timed out before applying is re-issued (idempotent); a reboot/snapshot of unknown outcome is NOT repeated and opens a case', async () => {
    const c = await k.createInstance('alice', A, {}, 'act-1');
    await k.runOp(A, c.operationId);
    const row0 = await k.instanceRow(c.instanceId);
    k.mock.inject({ op: 'act', kind: 'timeout_before_side_effect' });
    const stop = await k.call('alice', 'POST', `/v1/compute/instances/${c.instanceId}/actions`, A, {
      type: 'stop',
    });
    expect((await k.runOp(A, stop.json().operationId)).state).toBe('needs_reconcile');
    expect((await k.instanceRow(c.instanceId)).rstate).toBe('UNKNOWN');
    expect((await k.reconciler.reconcileResource(row0.rid)).result).toBe('absence_proven'); // had not taken effect: re-issued
    expect((await opRow(stop.json().operationId)).state).toBe('succeeded');
    expect((await k.instanceRow(c.instanceId)).status).toBe('stopped');
    // reboot needs a running instance
    const start = await k.call(
      'alice',
      'POST',
      `/v1/compute/instances/${c.instanceId}/actions`,
      A,
      { type: 'start' },
    );
    await k.runOp(A, start.json().operationId);
    k.mock.inject({ op: 'act', kind: 'timeout_after_side_effect' });
    const reboot = await k.call(
      'alice',
      'POST',
      `/v1/compute/instances/${c.instanceId}/actions`,
      A,
      { type: 'reboot' },
    );
    expect((await k.runOp(A, reboot.json().operationId)).state).toBe('needs_reconcile');
    const out = await k.reconciler.reconcileResource(row0.rid);
    expect(out.result).toBe('cannot_prove_absence');
    expect((await opRow(reboot.json().operationId)).state).toBe('failed');
    expect(await k.instanceRow(c.instanceId)).toMatchObject({
      status: 'running',
      rstate: 'ACTIVE',
    });
    expect(
      (await k.sql(`SELECT case_opened_at FROM cloud.resources WHERE id = $1`, [row0.rid]))[0]!
        .case_opened_at,
    ).toBeTruthy();
  });
});

describe('drift, missing and orphans (AC-M05-10)', () => {
  it('drift: provider-side stop is recorded and audited; missing: deleted at the provider → missing within 2 cycles (fake clock) and metering stops', async () => {
    const c = await k.createInstance('alice', A, {}, 'drift-1');
    await k.runOp(A, c.operationId);
    const row = await k.instanceRow(c.instanceId);
    expect((await k.reconciler.reconcileResource(row.rid)).result).toBe('in_sync');
    k.mock.instances.get(row.provider_ref)!.status = 'stopped'; // changed behind our back
    expect((await k.reconciler.reconcileResource(row.rid)).result).toBe('drift');
    expect((await k.instanceRow(c.instanceId)).status).toBe('stopped');
    expect(
      k.sink.events.some(
        (e) => e.action === 'cloud.reconcile.drift_detected' && e.detail?.kind === 'drift',
      ),
    ).toBe(true);
    k.mock.instances.get(row.provider_ref)!.status = 'running';
    await k.reconciler.reconcileResource(row.rid);
    expect((await k.instanceRow(c.instanceId)).status).toBe('running');

    k.mock.instances.get(row.provider_ref)!.deleted = true; // removed at the provider
    const cfg = reconcileConfigFromEnv();
    const cycles: string[] = [];
    for (let i = 0; i < 2; i++) {
      k.advance(cfg.driftIntervalMs + 1000); // the scheduled sweep considers it due again
      expect(await k.reconciler.dueResources()).toContain(row.rid);
      cycles.push((await k.reconciler.reconcileResource(row.rid, { trigger: 'scheduled' })).result);
    }
    expect(cycles).toEqual(['missing', 'missing']);
    expect((await k.instanceRow(c.instanceId)).drift_state).toBe('missing');
    expect(
      await k.sql(
        `SELECT 1 FROM compute.instance_intervals WHERE instance_id = $1 AND ended_at IS NULL`,
        [c.instanceId],
      ),
    ).toHaveLength(0); // never bill what is gone
    expect(
      (await k.admin('pa', 'GET', `/v1/admin/resources?driftState=missing&orgId=${A}`))
        .json()
        .items.map((r: Row) => r.id),
    ).toContain(row.rid);
    expect(
      k.sink.events.filter(
        (e) => e.action === 'cloud.reconcile.drift_detected' && e.detail?.kind === 'missing',
      ).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('forced reconciliation: 202 + job; the job result carries the reconciler outcome and the run is audited with the actor', async () => {
    const c = await k.createInstance('alice', A, {}, 'force-1');
    await k.runOp(A, c.operationId);
    const row = await k.instanceRow(c.instanceId);
    const r = await k.admin('pa', 'POST', `/v1/admin/resources/${row.rid}/reconciliations`);
    expect(r.statusCode).toBe(202);
    const job = await k.waitJob(r.json().operationId);
    expect(job.state).toBe('succeeded');
    expect(job.result.result).toBe('in_sync');
    expect(
      (
        await k.sql(
          `SELECT trigger, actor_user_id FROM cloud.resource_reconciliations WHERE resource_id = $1 ORDER BY run_at DESC LIMIT 1`,
          [row.rid],
        )
      )[0],
    ).toMatchObject({ trigger: 'on_demand' });
    expect(k.sink.events.some((e) => e.action === 'cloud.reconcile.requested')).toBe(true);
  });

  it('orphans: a billable provider resource behind a FAILED record opens an admin case and is NEVER deleted by default; only the explicit flag deletes, audited', async () => {
    const c = await k.createInstance('alice', A, {}, 'orphan-1');
    k.mock.inject({ op: 'provision', kind: 'timeout_after_side_effect' });
    await k.runOp(A, c.operationId);
    const row = await k.instanceRow(c.instanceId);
    // a (wrong) definitive failure is recorded although the provider created the resource
    const op = (await k.app.get(OperationsService).get(A, c.operationId))!;
    await k.prov.compensateCreate(
      A,
      op,
      'test-worker',
      op.input as never,
      'forced_for_test',
      'test',
      'operation_failed',
      true,
      'reconciler',
    );
    expect(await k.instanceRow(c.instanceId)).toMatchObject({ rstate: 'FAILED' });
    expect(k.mock.billableByToken(row.provision_token)).toBe(1);
    const out = await k.reconciler.reconcileResource(row.rid);
    expect(out.result).toBe('orphan_suspected');
    expect(k.mock.billableByToken(row.provision_token)).toBe(1); // nothing deleted
    const res = (
      await k.sql(
        `SELECT case_opened_at, drift_state, provider_ref FROM cloud.resources WHERE id = $1`,
        [row.rid],
      )
    )[0]!;
    expect(res).toMatchObject({ drift_state: 'orphan_suspected' });
    expect(res.case_opened_at).toBeTruthy();
    expect(k.sink.events.some((e) => e.action === 'orphan.case.opened')).toBe(true);
    expect(k.sink.events.some((e) => e.action === 'cloud.orphan.auto_deleted')).toBe(false);
    // explicit admin flag: delete + audit
    const flagged = new ReconcilerService(
      k.app.get(DB),
      k.app.get(AuditSink),
      k.app.get(OperationsService),
      k.registry,
      k.prov,
      { ...reconcileConfigFromEnv(), autoDeleteOrphans: true },
    );
    await k.sql(`ALTER TABLE cloud.resources DISABLE TRIGGER resources_guard`); // the DBA clears the case marker to let the flagged run look again
    await k.sql(
      `UPDATE cloud.resources SET drift_state = 'in_sync', provider_ref = NULL WHERE id = $1`,
      [row.rid],
    );
    await k.sql(`ALTER TABLE cloud.resources ENABLE TRIGGER resources_guard`);
    await flagged.reconcileResource(row.rid);
    expect(k.mock.billableByToken(row.provision_token)).toBe(0);
    expect(k.sink.events.some((e) => e.action === 'cloud.orphan.auto_deleted')).toBe(true);
  });

  it('cancelling a create operation before it runs releases the authorization and fails the resource (reconciler sweep)', async () => {
    const c = await k.createInstance('alice', A, {}, 'cancel-1');
    const r = await k.call('alice', 'POST', `/v1/operations/${c.operationId}/cancellation`, A);
    expect(r.statusCode).toBe(200); // cancelled immediately (it had not started)
    expect((await opRow(c.operationId)).state).toBe('cancelled');
    const row = await k.instanceRow(c.instanceId);
    expect((await k.reconciler.reconcileResource(row.rid)).result).toBe('compensated');
    expect(await k.instanceRow(c.instanceId)).toMatchObject({ status: 'failed', rstate: 'FAILED' });
    expect(
      (
        await k.sql(
          `SELECT r.reason FROM commerce.authorization_releases r JOIN commerce.authorizations a ON a.id = r.authorization_id JOIN compute.instances i ON i.order_id = a.order_id WHERE i.id = $1`,
          [c.instanceId],
        )
      )[0],
    ).toMatchObject({ reason: 'operation_cancelled' });
    expect(k.mock.provisionLog.filter((e) => e.token === row.provision_token)).toHaveLength(0);
  });
});

describe('concurrency: one operation, one authorization, one instance (AC-M05-05, AC-M05-22)', () => {
  const count = async (quoteId: string) => ({
    instances: (await k.sql(`SELECT 1 FROM compute.instances WHERE quote_id = $1`, [quoteId]))
      .length,
    resources: (
      await k.sql(
        `SELECT r.id FROM cloud.resources r JOIN compute.instances i ON i.resource_id = r.id WHERE i.quote_id = $1`,
        [quoteId],
      )
    ).length,
    operations: (
      await k.sql(
        `SELECT o.id FROM platform.operations o JOIN compute.instances i ON i.operation_id = o.id WHERE i.quote_id = $1 AND o.kind = 'compute.instance.create'`,
        [quoteId],
      )
    ).length,
    holds: (
      await k.sql(
        `SELECT a.id FROM commerce.authorizations a JOIN commerce.orders o ON o.id = a.order_id WHERE o.quote_id = $1 AND a.kind = 'hold'`,
        [quoteId],
      )
    ).length,
    orders: (await k.sql(`SELECT 1 FROM commerce.orders WHERE quote_id = $1`, [quoteId])).length,
  });

  for (const n of [50, 100]) {
    it(`${n} parallel creates with the SAME Idempotency-Key and quote → exactly 1 instance, 1 resource, 1 operation, 1 authorization, 1 order`, async () => {
      const q = await k.quote('alice', A);
      const quoteId = q.json().id as string;
      const results = await Promise.all(
        Array.from({ length: n }, () =>
          k.call(
            'alice',
            'POST',
            '/v1/compute/instances',
            A,
            { quoteId, name: `same-key-${n}`, sshPublicKeys: [] },
            { 'idempotency-key': `same-key-${n}` },
          ),
        ),
      );
      const codes = results.map((r) => r.statusCode);
      if (!codes.includes(202))
        throw new Error(
          `no 202: ${results
            .slice(0, 3)
            .map((r) => `${r.statusCode} ${r.body}`)
            .join(' | ')}`,
        );
      expect(codes.filter((c) => c === 202).length).toBeGreaterThanOrEqual(1);
      expect(codes.every((c) => c === 202 || c === 409)).toBe(true); // replays (202) or "in progress" (409): never a second creation
      expect(await count(quoteId)).toEqual({
        instances: 1,
        resources: 1,
        operations: 1,
        holds: 1,
        orders: 1,
      });
      const ids = new Set(
        results.filter((r) => r.statusCode === 202).map((r) => r.json().instance.id),
      );
      expect(ids.size).toBe(1);
      // running it once more changes nothing
      const opId = results.find((r) => r.statusCode === 202)!.json().operationId as string;
      await k.runOp(A, opId);
      await k.runOp(A, opId);
      expect(await count(quoteId)).toEqual({
        instances: 1,
        resources: 1,
        operations: 1,
        holds: 1,
        orders: 1,
      });
    }, 120_000);
  }

  it('parallel creates with DIFFERENT keys and quotes against the instance quota: exactly the limit succeed; the rest are 422 quota_exceeded and release nothing they did not take', async () => {
    const LIMIT = 7;
    await k.sql(
      `INSERT INTO billing.entitlements (id, scope, source, kind, org_id, meter_group, limit_value, allowance, mode) VALUES (gen_random_uuid(), 'org_override', 'override', 'meter_limit', $1, 'compute_instances', $2, 0, 'hard')`,
      [B, LIMIT],
    );
    const quotes: string[] = [];
    for (let i = 0; i < 20; i++) quotes.push((await k.quote('bob', B)).json().id as string);
    const results = await Promise.all(
      quotes.map((quoteId, i) =>
        k.call('bob', 'POST', '/v1/compute/instances', B, {
          quoteId,
          name: `quota-${i}`,
          sshPublicKeys: [],
        }),
      ),
    );
    const ok = results.filter((r) => r.statusCode === 202).length;
    const refused = results.filter(
      (r) => r.statusCode === 422 && /quota_exceeded/.test(r.body),
    ).length;
    expect({ ok, refused, other: results.length - ok - refused }).toEqual({
      ok: LIMIT,
      refused: 20 - LIMIT,
      other: 0,
    });
    expect(
      (
        await k.sql(
          `SELECT 1 FROM compute.instances WHERE org_id = $1 AND status NOT IN ('failed','deleted')`,
          [B],
        )
      ).length,
    ).toBe(LIMIT);
    // refused requests left no instance or hold behind
    expect(
      (
        await k.sql(`SELECT 1 FROM commerce.authorizations WHERE org_id = $1 AND kind = 'hold'`, [
          B,
        ])
      ).length,
    ).toBe(LIMIT);
  }, 120_000);
});

describe('1,000 randomized fault runs: never more than one billable resource per idempotency key (AC-M05-04)', () => {
  // seeded PRNG so a failure is reproducible
  const rng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const FAULTS: [FaultOp, FaultKind][] = [
    ['provision', 'timeout_after_side_effect'],
    ['provision', 'timeout_before_side_effect'],
    ['provision', 'rate_limit'],
    ['provision', 'outage'],
    ['provision', 'duplicate_create'],
    ['findByToken', 'timeout_before_side_effect'],
    ['findByToken', 'outage'],
    ['inspect', 'timeout_before_side_effect'],
    ['inspect', 'rate_limit'],
  ];

  it('1000 runs with random fault schedules: 0 replays after a side effect, ≤ 1 billable resource per token, every run ends consistent', async () => {
    const RUNS = Number(process.env.M05_RANDOM_RUNS ?? 1000);
    const BATCH = 10;
    const rand = rng(20261118);
    k.mock.setDedupe(false); // worst-case vendor: ANY replay after a side effect would create a second billable resource
    const logStart = k.mock.provisionLog.length;
    const tokens: string[] = [];
    let violations = 0;
    let uncertainRuns = 0;
    const stats = {
      runs: 0,
      parkedForReconcile: 0,
      retriedAfterBackoff: 0,
      adopted: 0,
      absenceProvenRetries: 0,
      failedDefinitively: 0,
      succeeded: 0,
    };
    const oneRun = async (i: number) => {
      const c = await k.createInstance('alice', A, {}, `rnd-${i}`);
      if (c.res.statusCode !== 202)
        throw new Error(`create ${i} failed: ${c.res.statusCode} ${c.res.body}`);
      const row = await k.instanceRow(c.instanceId);
      tokens.push(row.provision_token);
      for (let cycle = 0; cycle < 40; cycle++) {
        const op = await opRow(c.operationId);
        if (['succeeded', 'failed', 'cancelled'].includes(op.state as string)) break;
        if (op.state === 'needs_reconcile') stats.parkedForReconcile++;
        if (op.state === 'pending') stats.retriedAfterBackoff++;
        if (op.state === 'pending') {
          await k.sql(`UPDATE platform.operations SET next_run_at = now() WHERE id = $1`, [
            c.operationId,
          ]);
          await k.runOp(A, c.operationId);
        } else {
          k.advance(W / 2);
          const out = await k.reconciler.reconcileResource(row.rid, { trigger: 'scheduled' });
          if (out.result === 'adopted') stats.adopted++;
          if (out.result === 'absence_proven') stats.absenceProvenRetries++;
        }
        if (k.mock.billableByToken(row.provision_token) > 1) violations++;
      }
      const op = await opRow(c.operationId);
      if (!['succeeded', 'failed'].includes(op.state as string))
        throw new Error(`run ${i} did not finish: ${op.state}`);
      stats.runs++;
      if (op.state === 'succeeded') stats.succeeded++;
      else stats.failedDefinitively++;
      const fin = await k.instanceRow(c.instanceId);
      const billable = k.mock.billableByToken(row.provision_token);
      if (op.state === 'succeeded') {
        if (!(fin.rstate === 'ACTIVE' && fin.status === 'running' && billable === 1)) violations++;
      } else if (!(fin.rstate === 'FAILED' && billable === 0)) violations++;
      return fin.status;
    };
    for (let done = 0; done < RUNS; done += BATCH) {
      // arm a random fault schedule for this batch (consumed by whichever calls come first)
      const n = Math.floor(rand() * 8);
      for (let f = 0; f < n; f++) {
        const [op, kind] = FAULTS[Math.floor(rand() * FAULTS.length)]!;
        k.mock.inject({ op, kind, times: 1 + Math.floor(rand() * 2) });
      }
      const outcomes = await Promise.all(
        Array.from({ length: Math.min(BATCH, RUNS - done) }, (_, j) => oneRun(done + j)),
      );
      uncertainRuns += outcomes.length;
    }
    const log = k.mock.provisionLog.slice(logStart);
    const replays = log.filter((e) => e.existed).length;
    const perToken = new Map<string, number>();
    for (const t of tokens) perToken.set(t, k.mock.billableByToken(t));
    expect({
      runs: tokens.length,
      violations,
      replaysAfterSideEffect: replays,
      maxBillablePerToken: Math.max(...perToken.values()),
    }).toEqual({ runs: RUNS, violations: 0, replaysAfterSideEffect: 0, maxBillablePerToken: 1 });
    expect(uncertainRuns).toBe(RUNS);
    expect(stats.parkedForReconcile).toBeGreaterThan(0); // the schedule really produced uncertain outcomes
    expect(stats.adopted + stats.absenceProvenRetries).toBeGreaterThan(0);
    if (process.env.M05_EVIDENCE_DIR) {
      const { mkdirSync, writeFileSync } = await import('node:fs');
      mkdirSync(process.env.M05_EVIDENCE_DIR, { recursive: true });
      writeFileSync(
        `${process.env.M05_EVIDENCE_DIR}/random-fault-runs.json`,
        JSON.stringify(
          {
            seed: 20261118,
            vendorTokenDedupe: false,
            violations,
            replaysAfterSideEffect: replays,
            maxBillablePerToken: Math.max(...perToken.values()),
            ...stats,
          },
          null,
          2,
        ) + '\n',
      );
    }
    // every resource ended in a canonical, terminal-for-this-flow state
    const states = await k.sql(
      `SELECT state, count(*)::int AS n FROM cloud.resources WHERE org_id = $1 AND provision_token = ANY($2::text[]) GROUP BY state`,
      [A, tokens],
    );
    expect(
      states
        .map((r) => r.state as string)
        .filter((x) => !['ACTIVE', 'FAILED', 'DELETED'].includes(x)),
    ).toEqual([]);
  }, 900_000);
});
